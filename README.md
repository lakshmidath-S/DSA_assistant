# myIDE

A small Python studio for DSA practice. One window, one file, one Run button.

Built after the VS Code fork turned out to be the wrong shape for this: the
things that needed removing — extensions, source control, login, a chat panel, a
command palette — *are* the workbench, not features layered on top of it. The
part worth keeping, the editor, ships separately as
[Monaco](https://microsoft.github.io/monaco-editor/).

```
fork          ~4,600 lines of ours,  4,127 workbench .ts files inherited
this          ~1,500 lines,          0 inherited
```

## Install it

```powershell
npm install
.\install.ps1     # Desktop + Start menu shortcuts
```

Then tap <kbd>Win</kbd> and type "myIDE". `.\install.ps1 -Remove` takes them away
again, and `npm start` runs it from source without installing anything.

Needs Node and Python on PATH. A model server is optional — everything except
*Explain this* works without one.

## What it does

- Opens on the file you last had, or a blank one with a hint saying what to do.
  No workspace, no project, no folder to choose.
- **Run** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>) writes the buffer to disk and
  executes it, streaming output as it arrives. A run that is still going after
  15 s is killed, on the assumption it is an infinite loop.
- On a crash it points at the failing line **in the editor**: gutter dot, tinted
  row, squiggle under the exact span Python blamed, and the message trailing the
  line. Editing clears it, because the marker describes code that no longer
  exists.
- The explanation **arrives on its own** when a run fails — no button to find,
  no chat to open. *Explain again* re-asks if you want another attempt.
- Push to talk on <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>, with a live
  waveform so you can see the microphone is actually open.
- Drag the divider to resize, <kbd>Ctrl</kbd>+<kbd>+</kbd> / <kbd>-</kbd> to
  change the font. Both are remembered.
- Output shows what your program printed, then the traceback with our scratch
  path stripped out: `line 9` rather than seventy characters of
  `C:\Users\...\session\main.py`.

## Why the answers got better

The fork asked the model to find the bug by reading source, while telling it in
the system prompt that it had "the REAL runtime state". When a program ran to
completion rather than stopping at a breakpoint, it had neither — so it invented
a failure. On a real example it reported `SyntaxError: missing a colon` for a
conditional expression that is valid Python, then "fixed" it by adding
whitespace.

Python has already done that analysis, exactly and for free. `errors.js` parses
the traceback for the file, line, and marked column; the model is then asked to
*explain a known error* rather than *guess an unknown one*. Same 7B model, same
machine: a correct, specific answer in 18 s instead of a confident wrong one in
29 s.

That parser is the one piece worth testing carefully, because everything visual
hangs off it. Two things about real tracebacks are easy to get wrong:

- Since 3.11 the marker line mixes `~` and `^` (`return 1 / 0` → `~~^~~`), so
  matching `/^\s*\^+$/` misses nearly every modern traceback.
- Python **discards the original indentation** and re-indents the echoed source
  to exactly four spaces — a line indented by 16 and one indented by 4 both come
  back indented by 4. Marker offsets are therefore relative to the *trimmed*
  line, and the caller must add the real leading whitespace back. Skip that and
  every indented line underlines the wrong span, which in DSA code is most of
  them.

## Security

```powershell
npm test     # traceback parsing + XSS payloads against the answer renderer
npm audit    # dependencies
```

Electron runs locked down: `contextIsolation` on, `nodeIntegration` off,
`sandbox` **on**, and a CSP that allows connections only to the three loopback
ports the app actually uses. Navigation away from the local page, popups and
`<webview>` are all refused outright - a renderer that displays model output and
could then be navigated to a remote origin would carry the preload bridge with
it. The screenshot hooks below execute JavaScript from the environment, so they
are disabled whenever `app.isPackaged` is true.

`'unsafe-eval'` stays in the CSP because Monaco's AMD loader compiles modules
with the `Function` constructor. Removing it means switching to Monaco's ESM
build behind a bundler, which is a bigger change than it sounds.

Model output is the only untrusted text that reaches `innerHTML` - it is shaped
by the traceback, which is shaped by whatever was pasted into the editor. It goes
through `markdown.js`, which escapes first and adds its handful of tags
afterwards, to text that can no longer contain markup. `test/markdown.test.mjs`
fires fifteen payloads at it and asserts on the tags that actually survive
parsing, rather than grepping the output for scary substrings - escaped text may
legitimately read `&lt;img onerror=...&gt;` and renders as harmless characters.

Running arbitrary Python is the entire point of the app, so that is not a
finding; the 15-second timeout and the process-tree kill exist to stop a runaway
loop, not a hostile one.

## Layout

```
main.js              Electron shell: spawns Python, owns the scratch file and session
preload.js           the renderer's entire privileged surface
renderer/
  boot.js            Monaco's AMD bootstrap (a separate file - CSP forbids inline)
  markdown.js        escaping + the little markdown the model is asked for
  app.js             wiring: run, decorations, model, voice
  errors.js          traceback -> file, line, marked span
  ai.js              LM Studio / Ollama streaming + the prompt
  voice.js           push to talk, waveform, explicit states
servers/             voice_server.py  (speech, carried over unchanged)
test/                traceback cases run through real Python; XSS payloads
```

## Verifying the UI

`capturePage` through an env var, since a window that is occluded stops
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

## One thing worth knowing if you edit boot.js

`boot.js` hands Monaco over as `window.monacoLoaded`, a promise, rather than
firing a `monaco-ready` event. It has to: `boot.js` is a classic script and runs
during parsing, while `app.js` is a module and is therefore deferred. When
Monaco resolves from a warm cache it can finish *before* `app.js` executes, and
a one-shot event then fires with nobody listening — the window comes up with no
editor, no hint and no error in the console. A promise cannot be missed however
the race falls.

## Not done yet

- **Voice is untested end to end.** The transport and the waveform are written
  and the server is the same one the fork used, but sending real speech needs a
  microphone and a person.
- **No stepping.** There are no breakpoints and no variable inspection. Runtime
  *values* are the obvious next thing to feed the model and the biggest remaining
  quality lever, but that means wiring up debugpy from scratch — the fork's
  adapter was carried over at first and then dropped, because nothing called it.
- **No file management.** One scratch file. No open, no save-as, no tabs.
- **Windows-first.** `taskkill` for process trees and `python` rather than
  `python3`; the POSIX paths exist but are unexercised.
