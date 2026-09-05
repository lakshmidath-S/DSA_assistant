# myIDE Studio

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

## Run it

```powershell
npm install
npm start
```

Needs Node and Python on PATH. A model server is optional — everything except
*Explain this* works without one.

## What it does

- Opens on the file you last had, or a blank one. No workspace, no project, no
  folder to choose.
- **Run** (or <kbd>Ctrl</kbd>+<kbd>Enter</kbd>) writes the buffer to disk and
  executes it, streaming output as it arrives. A run that is still going after
  15 s is killed, on the assumption it is an infinite loop.
- On a crash it points at the failing line **in the editor**: gutter dot, tinted
  row, squiggle under the exact span Python blamed, and the message trailing the
  line. Editing clears it, because the marker describes code that no longer
  exists.
- **Explain this** asks a local model about the error. Optional.
- Push to talk on <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>, with a live
  waveform so you can see the microphone is actually open.

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

## Layout

```
main.js              Electron shell: spawns Python, owns the scratch file and session
preload.js           the renderer's entire privileged surface
renderer/
  boot.js            Monaco's AMD bootstrap (a separate file - CSP forbids inline)
  app.js             wiring: run, decorations, model, voice
  errors.js          traceback -> file, line, marked span
  ai.js              LM Studio / Ollama streaming + the prompt
  voice.js           push to talk, waveform, explicit states
servers/             voice_server.py  (speech, carried over unchanged)
```

## Verifying the UI

`capturePage` through an env var, since a window that is occluded stops
producing compositor frames and `PrintWindow` comes back blank on GPU-composited
Chromium:

```powershell
$env:STUDIO_SHOT     = 'C:\path\shot.png'   # capture, then keep running
$env:STUDIO_SHOT_RUN = 3000                 # click Run first, wait this long
$env:STUDIO_SHOT_ASK = 45000                # then click Explain this
npm start
```

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
