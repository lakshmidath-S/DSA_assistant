# myIDE

A small Python editor for DSA practice that keeps the debug loop on your own
machine. One window, one file, a Run button, and a local model that explains
what broke.

It exists because the alternative is pasting a whole solution into a cloud chat,
getting a fix, finding that something else now fails, and pasting it again.
Explaining one traceback, or one wrong answer, is a small bounded job — small
enough that a 1.5B model on your own hardware can do it, and not worth spending
cloud usage on.

**It does not give you the answer.** The model's job here is to make you
understand your own mistake, so the next one is easier to spot. It names the
line, explains what the code actually does as against what you meant, and ends
with a question. It never writes the corrected code. When you have genuinely
looked and are stuck, *Show the fix* is there — deliberately as a second,
quieter button rather than the default.

## What it does

- Opens blank, or on the file you had last.
- **Run** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) executes the buffer and streams the
  output. A run still going after 15 seconds is stopped.
- When it **crashes**, the failing line is marked in the editor: gutter dot,
  tinted row, and a squiggle under the exact span Python blamed. Editing clears
  the mark.
- When it **runs but prints the wrong thing**, you get an expected-vs-got card
  instead. Fill in *Expected output* and every run is checked against it.
- Either way a local model explains it, unprompted — what went wrong and why,
  never the corrected code. *Explain again* re-asks; *Show the fix* gives the
  corrected line when you want it.
- Push to talk on <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>, with a live
  waveform (needs the speech server, below).
- Drag the divider to resize; <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>-</kbd> for font
  size. Both persist.

## Setting it up

```
npm install
npm start
```

Node and Python 3 need to be on PATH; nothing else is required to run code. On
first launch a **Finish setting up** checklist appears in the side panel and
covers the rest:

| It finds | It does |
| --- | --- |
| Python missing | Links to the right installer for your platform |
| Ollama installed but stopped | **Start Ollama** — starts it and waits for the port |
| Ollama not installed | Links to the download |
| No model downloaded | **Download** with a live progress bar, via Ollama's API |

Two models are offered: `qwen2.5-coder:1.5b` (~1 GB, fine on CPU) and
`qwen2.5-coder:7b` (~4.7 GB, better reasoning, wants ~6 GB of RAM or a GPU).
LM Studio on port 1234 is also detected and used if it is already running; its
downloads happen in its own window.

Everything except *Explain* works with no model at all.

To install it as a launchable app:

```powershell
.\install.ps1        # Windows: Desktop + Start menu
```
```sh
./install.sh         # macOS: ~/Applications  ·  Linux: .desktop entry
```

Both take `-Remove` / `--remove`. On Windows the Start-menu entry is the one
that matters: Start search reads the Programs folder from its app-list cache,
not the file index, so a Desktop-only shortcut never turns up when you type.

### Voice (optional)

`servers/voice_server.py` provides speech-to-text and text-to-speech on port
8756. It needs `pip install -r servers/requirements.txt` (faster-whisper and
piper-tts) and downloads its own models on first use. The app works without it.

## Why it teaches instead of answering

Python already knows what went wrong, exactly, and says so for free. So
`errors.js` parses the traceback for the file, line and marked column, and the
model is asked to *explain a known failure* rather than *find an unknown one*.

This matters more than model size. An earlier version told the model it had "the
REAL runtime state" and then, whenever a program ran to completion instead of
stopping at a breakpoint, handed it source only. Asked to explain a failure it
could not see, it invented one — reporting a missing colon in a conditional
expression that is valid Python, then "fixing" it by adding whitespace.

The same reasoning shapes the wrong-answer prompt, twice over.

It states that the expected output and the test input are correct and must not
change, because without that the model edits the test to match the bug:
`qwen2.5-coder:7b` suggested changing `two_sum([2, 7, 11, 15], 9)` to
`two_sum([7, 2, 11, 15], 9)` rather than looking at the line that returned the
indices in the wrong order.

It also has to say which line counts. Asked simply to name where the two
diverge, the same model blamed line 4 (`need = target - n`), which is correct
code — the wrong value is produced by the `return` on line 6. Told to name the
line that *produces* the value rather than one merely involved in the working,
it named line 6.

Neither instruction makes a small model reliable. In the same answer it traced
the loop correctly and then wrote that the result "translates to `[3, 0]`" when
it had just derived `[1, 0]`. Read it as a study partner thinking aloud, not as
an authority.

Two details of real tracebacks are easy to get wrong, and both are covered:

- Since 3.11 the marker line mixes `~` and `^` (`return 1 / 0` → `~~^~~`), so
  matching `/^\s*\^+$/` misses nearly every modern traceback.
- Python discards the original indentation and re-indents the echoed source to
  exactly four spaces, so marker offsets are relative to the *trimmed* line. The
  caller has to add the real leading whitespace back, or every indented line
  underlines the wrong span.

## Security

```
npm test     # traceback parsing, and XSS payloads against the answer renderer
npm audit
```

`contextIsolation` on, `nodeIntegration` off, `sandbox` on, and a CSP that
allows connections only to the three loopback ports the app uses. Navigation
away from the local page, popups and `<webview>` are refused: a renderer that
displays model output and could then be navigated to a remote origin would carry
the preload bridge with it. The screenshot hooks below run JavaScript from the
environment, so they are disabled when `app.isPackaged` is true.

`'unsafe-eval'` remains because Monaco's AMD loader compiles modules with the
`Function` constructor. Removing it means Monaco's ESM build behind a bundler.

Model output is the only untrusted text reaching `innerHTML` — it is shaped by
the traceback, which is shaped by whatever you pasted. `markdown.js` escapes
first and adds its few tags afterwards, to text that can no longer contain
markup. The test asserts on the tags that survive parsing rather than grepping
for scary substrings: escaped text may legitimately read
`&lt;img onerror=...&gt;` and renders as harmless characters.

Running arbitrary Python is the point of the app, so that is not a finding. The
timeout and process-tree kill are there for runaway loops, not hostile code.

## Layout

```
main.js              Electron shell: finds Python, runs it, owns the scratch file
preload.js           the renderer's entire privileged surface
renderer/
  boot.js            Monaco's AMD bootstrap (separate file - CSP forbids inline)
  app.js             wiring: run, decorations, setup panel, expected output, voice
  errors.js          traceback -> file, line, marked span
  ai.js              LM Studio / Ollama streaming, and the prompts
  markdown.js        escaping + the little markdown the model is asked for
  setup.js           what this machine has; starting Ollama; downloading a model
  voice.js           push to talk, waveform, explicit states
servers/             voice_server.py (optional speech)
test/                traceback cases run through real Python; XSS payloads
install.ps1          Windows shortcuts
install.sh           macOS bundle / Linux .desktop entry
```

## Portability notes

The interpreter is resolved by probing, not assumed: `py -3`, then `python`,
then `python3` on Windows; `python3` then `python` elsewhere. Each candidate is
run with `--version` and must report 3.x, with a timeout — on Windows `python`
is often a Store alias that forwards correctly when Python came from the Store
and hangs or opens the Store when it did not.

Killing a run uses `taskkill /T` on Windows, because a plain kill leaves the
child's own children behind, and `SIGKILL` elsewhere.

## Verifying the UI

`capturePage` behind environment variables, because an occluded window stops
producing compositor frames and `PrintWindow` comes back blank on GPU-composited
Chromium:

```powershell
$env:STUDIO_SHOT      = 'C:\path\shot.png'  # capture, then keep running
$env:STUDIO_SHOT_RUN  = 3000                # click Run first, wait this long
$env:STUDIO_SHOT_ASK  = 45000               # then click Explain again
$env:STUDIO_SHOT_EXIT = 1                   # quit after capturing
$env:STUDIO_EVAL      = "..."               # run JS in the page first
npm start
```

## If you edit boot.js

Monaco is handed over as `window.monacoLoaded`, a promise, rather than a
`monaco-ready` event. It has to be: `boot.js` is a classic script and runs
during parsing, while `app.js` is a module and is deferred. When Monaco resolves
from a warm cache it can finish before `app.js` executes, and a one-shot event
then fires with nobody listening — the window comes up with no editor, no hint,
and nothing in the console. A promise cannot be missed.

## What has and has not been exercised

Verified by running it, on Windows: traceback marking and explanation; the
wrong-answer card and its explanation; that the default answer explains without
writing the fix, and that *Show the fix* then returns the corrected line;
session save and restore; the setup checklist rendering with both model servers
made unreachable; **Start Ollama** (the process survives the app closing and the
port comes up); and the model-download stream, by re-pulling a model that was
already present, which returns the same NDJSON frames as a first download.

Not exercised: a first-time download of a model that is not already on disk;
voice end to end, which needs a microphone and a person; and macOS and Linux,
where the code paths exist and are written from documented behaviour but have
not been run.

## Not done yet

- **No stepping.** No breakpoints, no variable inspection. Feeding real values
  rather than just the traceback is the biggest remaining lever on answer
  quality, and it means wiring up debugpy properly.
- **One file.** No open, no save-as, no tabs.
- **One test case.** *Expected output* holds a single expected string, not a
  table of cases.
