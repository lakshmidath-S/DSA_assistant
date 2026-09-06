/*---------------------------------------------------------------------------------------------
 *  myIDE - talking to it, with visible state at every step.
 *
 *  Voice looked broken for one reason above all: the steps that take time gave
 *  no sign of being alive. The speech server loads its Whisper weights on first
 *  use and downloads them if they are missing - several hundred megabytes - so
 *  the first question of a session sat on "Transcribing..." for minutes with
 *  nothing moving and no way to tell working from hung. Then, if the server was
 *  not running at all, the error was written into an overlay that had already
 *  been hidden, so it was never read.
 *
 *  So every wait here reports: elapsed seconds, what is being waited for, and
 *  whether the model is still loading (asked of /health, which answers during a
 *  transcription because the server is threaded). Nothing is silent, and no
 *  request is without a deadline.
 *
 *  Recording is a toggle rather than a hold. A held key cannot survive the
 *  question being long, and there is no reason a sentence should have to.
 *
 *  Talks to servers/voice_server.py: /health, /stt, /tts on :8756.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export const VOICE_ENDPOINT = 'http://127.0.0.1:8756';

/** Bars in the waveform. Enough to read as a voice, few enough to stay cheap. */
const BAR_COUNT = 48;

/** A held request must fail rather than hang, but the first transcription of a
 *  session can legitimately take minutes while the model downloads. */
const HEALTH_TIMEOUT_MS = 2000;
const STT_TIMEOUT_MS = 10 * 60 * 1000;
const TTS_TIMEOUT_MS = 60 * 1000;

export class Voice {
	/**
	 * @param {HTMLCanvasElement} canvas Where the waveform is drawn.
	 * @param {(state: string, detail?: string) => void} onState Told every transition.
	 */
	constructor(canvas, onState) {
		this.canvas = canvas;
		this.onState = onState;
		this.state = 'idle';

		this.stream = undefined;
		this.recorder = undefined;
		this.chunks = [];
		this.audioContext = undefined;
		this.analyser = undefined;
		this.raf = 0;
		/** Smoothed bar heights, so the waveform glides instead of flickering. */
		this.levels = new Array(BAR_COUNT).fill(0);
	}

	setState(state, detail) {
		this.state = state;
		this.onState(state, detail);
	}

	/**
	 * What the speech server says about itself, or undefined when it is not
	 * there. `loaded` tells recording from downloading, which is the difference
	 * between a wait worth explaining and one worth worrying about.
	 */
	async health() {
		try {
			const res = await fetch(`${VOICE_ENDPOINT}/health`, {
				signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			if (!res.ok) {
				return undefined;
			}
			const json = await res.json();
			return json?.ready ? json : undefined;
		} catch {
			return undefined;
		}
	}

	async available() {
		return Boolean(await this.health());
	}

	/** Opens the microphone and starts drawing. Held open until stop(). */
	async start() {
		if (this.state !== 'idle') {
			return;
		}
		this.setState('listening');
		this.chunks = [];

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			this.setState('idle');
			throw new Error('Could not open the microphone. Check Windows microphone permissions.');
		}

		this.audioContext = new AudioContext();
		const source = this.audioContext.createMediaStreamSource(this.stream);
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 1024;
		this.analyser.smoothingTimeConstant = 0.7;
		source.connect(this.analyser);

		this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
		this.recorder.ondataavailable = e => {
			if (e.data.size > 0) {
				this.chunks.push(e.data);
			}
		};
		this.recorder.start();

		this.draw();
	}

	/**
	 * Closes the microphone and transcribes.
	 *
	 * The wait is narrated. On a cold server the first call loads - and possibly
	 * downloads - the Whisper model, which takes minutes, and a spinner that
	 * cannot say so is indistinguishable from a crash. /health is polled
	 * alongside, because the server is threaded and will answer it while it is
	 * still working on the audio.
	 *
	 * @returns {Promise<string>} the recognised text, or '' if nothing was said.
	 */
	async stop() {
		if (this.state !== 'listening') {
			return '';
		}

		const recorded = new Promise(resolve => {
			this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: 'audio/webm' }));
		});
		this.recorder.stop();
		const blob = await recorded;

		this.teardown();

		// Too short to be speech - almost always a mis-click.
		if (blob.size < 2000) {
			this.setState('idle');
			return '';
		}

		this.setState('transcribing', 'Transcribing…');
		const base64 = await blobToBase64(blob);
		const started = Date.now();

		// Count up, and say what the delay is, for as long as the request runs.
		let loadingReported = false;
		const ticker = setInterval(async () => {
			const seconds = Math.round((Date.now() - started) / 1000);
			if (!loadingReported && seconds >= 4) {
				const info = await this.health();
				if (info && info.loaded && info.loaded.stt === false) {
					loadingReported = true;
				}
			}
			this.setState('transcribing', loadingReported
				? `Loading the speech model… ${seconds}s (first use downloads it)`
				: `Transcribing… ${seconds}s`);
		}, 1000);

		try {
			const res = await fetch(`${VOICE_ENDPOINT}/stt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ audio: base64, format: 'webm' }),
				signal: AbortSignal.timeout(STT_TIMEOUT_MS),
			});

			if (!res.ok) {
				const body = await res.text().catch(() => '');
				let detail = body.slice(0, 200);
				try {
					detail = JSON.parse(body).error ?? detail;
				} catch {
					/* not JSON; the raw body is the best we have */
				}
				throw new Error(`The speech server failed to transcribe: ${detail}`);
			}

			const json = await res.json();
			return (json.text ?? '').trim();
		} catch (err) {
			if (err.name === 'TimeoutError') {
				throw new Error('The speech server did not answer. It may still be downloading its model.');
			}
			// A refused connection is the common one, and it has a fix worth naming.
			if (err instanceof TypeError) {
				throw new Error('The speech server is not running.');
			}
			throw err;
		} finally {
			clearInterval(ticker);
		}
	}
	/** Speaks a line back. Failure here is never fatal - the text is on screen. */
	async speak(text) {
		if (!text || !text.trim()) {
			return;
		}
		try {
			this.setState('speaking');
			const res = await fetch(`${VOICE_ENDPOINT}/tts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: text.slice(0, 600) }),
				signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
			});
			if (!res.ok) {
				throw new Error(`tts returned ${res.status}`);
			}
			const json = await res.json();
			const audio = new Audio(`data:audio/wav;base64,${json.audio}`);
			await audio.play();
			await new Promise(resolve => { audio.onended = resolve; });
		} catch {
			/* speech is a convenience; the answer is already rendered */
		} finally {
			this.setState('idle');
		}
	}

	teardown() {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.stream?.getTracks().forEach(t => t.stop());
		this.audioContext?.close();
		this.stream = undefined;
		this.audioContext = undefined;
		this.analyser = undefined;
		this.clear();
	}

	/** One animation frame of the waveform. */
	draw() {
		if (!this.analyser) {
			return;
		}
		const ctx = this.canvas.getContext('2d');
		const dpr = window.devicePixelRatio || 1;
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;

		if (this.canvas.width !== width * dpr) {
			this.canvas.width = width * dpr;
			this.canvas.height = height * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const bins = new Uint8Array(this.analyser.frequencyBinCount);
		this.analyser.getByteFrequencyData(bins);

		// Voice energy sits low in the spectrum; using the whole range would
		// leave most bars permanently flat.
		const usable = Math.floor(bins.length * 0.4);
		const per = Math.max(1, Math.floor(usable / BAR_COUNT));

		const barWidth = width / BAR_COUNT;
		for (let i = 0; i < BAR_COUNT; i++) {
			let sum = 0;
			for (let j = 0; j < per; j++) {
				sum += bins[i * per + j] ?? 0;
			}
			const target = (sum / per) / 255;
			// Ease toward the target so bars glide rather than strobe.
			this.levels[i] += (target - this.levels[i]) * 0.35;

			const h = Math.max(2, this.levels[i] * height * 0.9);
			const x = i * barWidth;
			const y = (height - h) / 2;

			ctx.fillStyle = `hsl(${190 + this.levels[i] * 60}, 85%, ${45 + this.levels[i] * 25}%)`;
			ctx.beginPath();
			ctx.roundRect(x + barWidth * 0.2, y, barWidth * 0.6, h, barWidth * 0.3);
			ctx.fill();
		}

		this.raf = requestAnimationFrame(() => this.draw());
	}

	clear() {
		const ctx = this.canvas.getContext('2d');
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.levels.fill(0);
	}
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}
