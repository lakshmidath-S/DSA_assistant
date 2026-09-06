"""
myIDE - offline speech server for voice mode.

Speech-to-text with faster-whisper and text-to-speech with Piper, both running
locally on the CPU. Once the two model files are cached, nothing here touches
the network - which is the whole point, since the debugger it feeds is offline
by design.

Run it with:

    python servers/voice_server.py

Endpoints (all JSON, so the workbench can reach them through IRequestService):

    GET  /health  -> {"ready": bool, "stt": str, "tts": str, "loaded": {...}}
    POST /stt     <- {"audio": "<base64>", "format": "webm"}   -> {"text": str}
    POST /tts     <- {"text": str}                             -> {"audio": "<base64 wav>"}

Both models load lazily on first use, so startup is instant and a session that
only dictates never pays for the voice model.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import threading
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The workbench renders on this origin. Echoing exactly it - rather than "*" -
# keeps any web page you happen to be visiting from driving your microphone
# server.
ALLOWED_ORIGIN = "vscode-file://vscode-app"

DEFAULT_PORT = 8756
DEFAULT_STT_MODEL = "small"
DEFAULT_TTS_VOICE = "en_US-lessac-medium"

# Piper voices live in one flat layout on HuggingFace.
PIPER_BASE = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium"
)

MAX_BODY_BYTES = 32 * 1024 * 1024  # A dictated question is tiny; this is slack.


class Models:
    """Lazily loaded models, shared across requests behind one lock each."""

    def __init__(self, stt_name: str, tts_voice: str, data_dir: Path) -> None:
        self.stt_name = stt_name
        self.tts_voice = tts_voice
        self.data_dir = data_dir
        self._stt = None
        self._tts = None
        self._stt_lock = threading.Lock()
        self._tts_lock = threading.Lock()

    @property
    def loaded(self) -> dict:
        return {"stt": self._stt is not None, "tts": self._tts is not None}

    def stt(self):
        with self._stt_lock:
            if self._stt is None:
                from faster_whisper import WhisperModel

                log(f"loading speech-to-text model '{self.stt_name}' (first use)")
                # int8 keeps a 4 GB GPU box comfortable; this runs on CPU anyway.
                self._stt = WhisperModel(
                    self.stt_name, device="cpu", compute_type="int8"
                )
                log("speech-to-text ready")
            return self._stt

    def tts(self):
        with self._tts_lock:
            if self._tts is None:
                from piper import PiperVoice

                model_path = ensure_piper_voice(self.tts_voice, self.data_dir)
                log(f"loading voice '{self.tts_voice}' (first use)")
                self._tts = PiperVoice.load(str(model_path))
                log("text-to-speech ready")
            return self._tts


def log(message: str) -> None:
    print(f"[myide-voice] {message}", flush=True)


def ensure_piper_voice(voice: str, data_dir: Path) -> Path:
    """Return the .onnx path for `voice`, downloading it once if missing."""
    data_dir.mkdir(parents=True, exist_ok=True)
    model_path = data_dir / f"{voice}.onnx"
    config_path = data_dir / f"{voice}.onnx.json"

    for path, url in (
        (model_path, f"{PIPER_BASE}/{voice}.onnx"),
        (config_path, f"{PIPER_BASE}/{voice}.onnx.json"),
    ):
        if path.exists() and path.stat().st_size > 0:
            continue
        log(f"downloading {path.name} (one time, ~60 MB total)")
        tmp = path.with_suffix(path.suffix + ".part")
        try:
            urllib.request.urlretrieve(url, tmp)
            tmp.replace(path)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
    return model_path


def transcribe(models: Models, audio: bytes, suffix: str) -> str:
    """Whisper reads a file, so the clip is staged next to the models."""
    scratch = models.data_dir / f"clip{suffix}"
    scratch.parent.mkdir(parents=True, exist_ok=True)
    scratch.write_bytes(audio)
    try:
        segments, _info = models.stt().transcribe(
            str(scratch),
            beam_size=1,
            vad_filter=True,
            # Steer the model towards the vocabulary this IDE actually hears.
            initial_prompt="Python debugging: dict, list, index error, heapq, "
            "recursion, off by one, time complexity, breakpoint, variable.",
        )
        return " ".join(segment.text.strip() for segment in segments).strip()
    finally:
        scratch.unlink(missing_ok=True)


def synthesize(models: Models, text: str) -> bytes:
    buffer = io.BytesIO()
    # synthesize_wav writes the header itself; plain synthesize() yields raw
    # chunks and would leave us assembling a RIFF file by hand.
    with wave.open(buffer, "wb") as wav:
        models.tts().synthesize_wav(text, wav)
    return buffer.getvalue()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    models: Models  # injected below

    # --- plumbing ---------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - base class API
        pass  # The default handler logs every request to stderr; too noisy.

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", ALLOWED_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Vary", "Origin")

    def _send(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            raise ValueError("missing or oversized request body")
        return json.loads(self.rfile.read(length).decode("utf-8"))

    # --- routes -----------------------------------------------------------

    def do_OPTIONS(self) -> None:  # noqa: N802 - base class API
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 - base class API
        if self.path.split("?")[0] != "/health":
            self._send(404, {"error": "not found"})
            return
        self._send(
            200,
            {
                "ready": True,
                "stt": self.models.stt_name,
                "tts": self.models.tts_voice,
                "loaded": self.models.loaded,
            },
        )

    def do_POST(self) -> None:  # noqa: N802 - base class API
        route = self.path.split("?")[0]
        try:
            if route == "/stt":
                payload = self._read_json()
                audio = base64.b64decode(payload.get("audio") or "")
                if not audio:
                    self._send(400, {"error": "no audio supplied"})
                    return
                fmt = str(payload.get("format") or "webm").lower()
                suffix = "." + "".join(c for c in fmt if c.isalnum())[:8]
                text = transcribe(self.models, audio, suffix)
                self._send(200, {"text": text})

            elif route == "/tts":
                text = (self._read_json().get("text") or "").strip()
                if not text:
                    self._send(400, {"error": "no text supplied"})
                    return
                wav = synthesize(self.models, text)
                self._send(200, {"audio": base64.b64encode(wav).decode("ascii")})

            else:
                self._send(404, {"error": "not found"})

        except Exception as err:  # Report rather than drop the connection.
            log(f"error handling {route}: {err}")
            self._send(500, {"error": str(err)})


def main() -> int:
    parser = argparse.ArgumentParser(description="myIDE offline speech server")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--stt-model", default=DEFAULT_STT_MODEL)
    parser.add_argument("--tts-voice", default=DEFAULT_TTS_VOICE)
    parser.add_argument(
        "--data-dir",
        default=str(Path.home() / ".myide" / "voice"),
        help="where the Piper voice and scratch clips are kept",
    )
    parser.add_argument(
        "--prefetch",
        action="store_true",
        help="load both models now instead of on first use, then keep serving",
    )
    args = parser.parse_args()

    models = Models(args.stt_model, args.tts_voice, Path(args.data_dir))

    if args.prefetch:
        log("prefetching models; the first run downloads them")
        try:
            models.stt()
            models.tts()
        except Exception as err:
            log(f"prefetch failed: {err}")
            return 1

    Handler.models = models
    # Loopback only. This server hears your microphone; it has no business
    # being reachable from the network.
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on http://127.0.0.1:{args.port} (stt={args.stt_model}, tts={args.tts_voice})")
    log("press Ctrl+C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    if sys.version_info < (3, 9):
        print("myIDE voice needs Python 3.9 or newer", file=sys.stderr)
        raise SystemExit(1)
    os.environ.setdefault("OMP_NUM_THREADS", "4")
    raise SystemExit(main())
