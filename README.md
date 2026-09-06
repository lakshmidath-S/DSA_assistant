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
- It also shows **what the variables actually held** at that moment - `u = 9`
  beside `graph = [[1], [], []]` is often the whole explanation on its own. The
  model is given the same values, so it reads facts rather than simulating the
  program.
- When it **runs but prints the wrong thing**, you get an expected-vs-got card
  instead. Fill in *Expected output* and every run is checked against it.
- **Step through the run.** Every run is traced, crash or no crash, so the panel
  can walk back through it: drag the scrubber and the marker moves down the
  editor while the variables fill in beside it — the list growing, the dict
  filling, the index going one too far. This is the only account of a run that
  finished and printed the wrong answer, because nothing raised.
- **Tell it the problem.** Paste the question you are solving into *The problem*
  and the explanation is judged against what the code was *meant* to do, rather
  than against what the code looks like it is trying to do — which is circular,
  since the code is the thing that is wrong.
- Either way a local model explains it, unprompted — what went wrong and why,
  never the corrected code. It is given the traceback, the recorded values and
  the recorded steps, so it reads facts instead of simulating the program.
  *Explain again* re-asks; *Show the fix* gives the corrected line when you
  want it.
- **Ask follow-ups.** The box at the bottom of the panel takes any question
  about your code, and remembers the last few exchanges, so a bare "why?" still
  has a subject. Answers stack as notes, not as a chat transcript. Turns older
  than that window are not dropped - they are folded into a short factual note
  by the smallest model on the server already running, so a question about
  something settled ten turns ago still has it behind it.
- **Select first to narrow the question.** Highlight part of your code — or part
  of an answer — and a chip appears showing what the question is about. "Why is
  this O(n²)?" needs to know which part *this* is.
- **Time & space** analyses complexity: both bounds, what `n` refers to in your
  code, which loop causes what, and whether a bound is amortised.
- **Can it be faster?** gives your current complexity and the best achievable,
  then names the technique that closes the gap and why it removes the cost.
- **Talk to it.** Click the microphone (or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>V</kbd>)
  to start recording with a live waveform, click again to send. What it heard is
  shown before it is acted on, then the question goes into the thread like any
  other and the answer streams in. Every step names itself and counts its
  seconds; nothing fails silently.
- **Settings** (the gear on the title bar, which also shows what is answering)
  holds the setup checklist and the model list. Every model on every running
  server is listed under its server; choosing one switches to that server, and
  starts it if it is not running.
- **It starts itself.** On launch myIDE starts the one server your last model
  belongs to - not both, which would cost gigabytes for a choice you have
  already made - and selects that model. The first run has nothing to go on, so
  it starts what is installed, takes the best model it finds, and remembers it.
  Everything it started is stopped again when you close the app; anything that
  was already running is left alone.
- The question thread, the problem and the expected output all survive a
  restart, along with the code.
- Drag the divider to resize; <kbd>Ctrl</kbd>+<kbd>+</kbd>/<kbd>-</kbd> for font
  size. <kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> steps through the run. All persist.

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
| A model server installed but stopped | **Start models** — starts every one it finds, Ollama and LM Studio, waits for their ports, and stops them again when myIDE closes |
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

You do not start it yourself: the first press of the microphone starts it and
says so. That press is also the one that pays for loading Whisper - measured at
**17.2s** for the first transcription against **4.6s** for every one after, with
the model already cached, and minutes rather than seconds if it still has to be
downloaded. The overlay counts the seconds and, when `/health` reports the model
still loading, says that is what it is waiting for. A silent wait of that length
is indistinguishable from a crash, which is exactly how this used to fail.

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

The follow-up prompts keep the same rule, with two deliberate exceptions.

Complexity **is** the lesson: "O(n²) because the inner loop runs n − i times for
each of n outer passes" teaches exactly the thing being asked about, so it is
answered directly.

Optimisation names the technique and why it works — a hash map turning a repeated
scan into a lookup — but stops before writing the faster solution. Knowing which
idea applies is the insight; typing it is the exercise. Asked about an O(n²)
`two_sum`, `qwen2.5-coder:7b` named the hash map and explained that it removes
the repeated pair checking, without producing the rewritten function.

### Values beat reasoning

`python/harness.py` runs the file and, if it raises, reports the locals of the
deepest frame that is the user's own code. Without that the model has to
simulate the program, and a 7B model is not reliable at it: asked about a wrong
`two_sum` it traced the loop correctly and then wrote that the result
"translates to `[3, 0]`" having just derived `[1, 0]`.

Handing over the values was necessary but not sufficient. Given them only as
context, `qwen2.5-coder:7b` still answered that "u could be greater than or
equal to n" while holding `u = 9` - a generic IndexError explanation is simply
the likelier continuation. Naming the values in the closing question as well
fixed it: it then said the code was accessing `graph[9]`, which does not exist
because the graph has indices 0 to 2.

The harness prints those values as one marker line on stderr rather than to a
file, because there is no directory it can rely on being writable: writes into
the app's own data directory were silently discarded on one machine while the
same code worked from the project folder. The editor strips the line before
anything sees it, and `test/harness.test.mjs` asserts that what remains is byte
for byte what Python would have printed - running the file through `exec()` adds
a frame of our own, and an unnormalised path prints forward slashes where Python
prints backslashes.

### Steps beat values, where there are no values

Recorded locals only exist if something raised. A run that finishes and prints
the wrong answer — the case this app was extended to cover, and the one people
actually paste into a cloud chat — raises nothing, so the exception handler sees
nothing and the model got the source and the two output strings and had to
simulate the rest.

So the harness also installs `sys.settrace`, filtered to the user's own file,
and records `(line, the names that changed)`. The wrong-answer prompt carries
the tail of that, and the panel can scrub through all of it.

Tracing every line is slow, so recording stops at 300 steps by *uninstalling the
trace function* rather than by continuing to pay for events it will discard. A
400,000-iteration loop measured the same with tracing as without, to within
noise. Truncation is then stated in the prompt in as many words, because the
steps shown are from the middle of a longer run and a model told nothing about
that will confidently explain a program that ended where the recording did.

Two things fall out of tracing that an exception handler cannot give at all:
a **caught** exception, which never reaches a traceback and is a real way to
print a wrong answer; and the value a function actually returned.

Changes are compared by **repr**, not by identity or equality. `graph[u].append(v)`
mutates a list in place, so the object is the same one it was before and `is`
sees nothing happen — while the repr, which is what the reader and the model are
shown, changes.

### What a 1.5B does with all of this

`qwen2.5-coder:1.5b` and a 7.6B were given the same wrong-answer prompt for the
`two_sum` that returns `[1, 0]` instead of `[0, 1]`, once bare and once with the
problem statement and the recorded trace:

| | bare | with trace + problem |
|---|---|---|
| `qwen2.5-coder:1.5b` | 3.5s | 9.3s |
| 7.6B (`logic:latest`) | 50.9s | 73.5s |

Speed was never the question. The 1.5B **wrote out the corrected code both
times**, under a "Here's the corrected line:" heading, which is the one thing
`SYSTEM_PROMPT` forbids and the whole reason the app exists. It also blamed the
wrong line twice, and with the trace in hand narrated iterations that never
happened. The 7.6B named line 6, explained the ordering assumption behind it,
and closed with a question — the exact shape asked for — both times.

So the 1.5B is not the default, and `pickDefaultModel` now refuses to default to
anything under 3B while something larger is installed. It had been doing the
opposite: it considered only names containing "coder", so a 1.5B coder beat a
7.6B sitting beside it, and nothing looked broken because the panel still
answered. Sizes now come from what the server reports — Ollama states
`parameter_size` per tag — because a model pulled under a custom tag has no
number in its name at all.

The 1.5B is still in the picker. For "what does this error mean" it is genuinely
the better trade; it just cannot be trusted to hold a rule.

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

Answers are also stripped of LaTeX delimiters before rendering — models write
complexity as `\(O(n^2)\)` and nothing here renders maths, so the backslashes
would otherwise appear literally in every complexity answer. That happens before
escaping, so it cannot be used to smuggle markup through, and there is a test
for exactly that.

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
python/harness.py    runs the file; reports the variables at a failure and
                     traces the path the run took
preload.js           the renderer's entire privileged surface
renderer/
  boot.js            Monaco's AMD bootstrap (separate file - CSP forbids inline)
  app.js             wiring: run, decorations, setup panel, problem and expected
                     output, step-through, follow-up thread, selection, voice
  errors.js          traceback -> file, line, marked span
  ai.js              LM Studio / Ollama streaming, model choice, and the prompts
  markdown.js        escaping + the little markdown the model is asked for
  setup.js           what this machine has; starting Ollama; downloading a model
  voice.js           push to talk, waveform, explicit states
servers/             voice_server.py (optional speech)
test/                traceback cases and harness runs against real Python;
                     XSS payloads against the answer renderer; model choice and
                     the shape of the prompts
install.ps1          Windows shortcuts
install.sh           macOS bundle / Linux .desktop entry
```

## Packaging

```
npm run pack         # dist/win-unpacked - an app directory, no installer
npm run dist         # an installer for the current platform
```

Two things about the build are load-bearing:

`python/harness.py` ships as an **extraResource**, not inside the asar. A
spawned Python process reads through the real filesystem, not Electron's patched
`fs`, so a harness inside `app.asar` cannot be opened at all. `main.js` looks
beside the archive when `app.isPackaged`, and inside `__dirname` when it is not.

Monaco is trimmed by exclusion. electron-builder ships every production
dependency whether or not `files` names it, and `monaco-editor` carries four
copies of the editor - `dev`, `esm`, `min`, `min-maps` - of which only `min` is
ever loaded. Excluding the other three takes the asar from 63MB to 14MB.

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
the variables panel and the model quoting `graph[9]` from the recorded values;
session save and restore; asking a follow-up and having a bare "why does that
make it faster?" answered from the remembered turn; selecting code and seeing the
question scoped to it; complexity and optimisation answers; clearing the thread;
the setup checklist rendering with both model servers made unreachable; **Start models** (both servers come up from cold - LM Studio in 0.7s, Ollama in 3.2s - with no console window; both are stopped again on quit, and a server that was already running before myIDE opened is left running); and the model-download stream, by re-pulling a model that was
already present, which returns the same NDJSON frames as a first download.

Then, for the tracer and what came with it: the step-through on the `two_sum`
that returns its indices backwards - scrubbing to step 10 of 13 shows `seen =
{2: 0}` and `want = 2` with line 5 marked in the editor, which is the bug,
before any explanation is read; the trace surviving a run with no crash at all;
tracing switching off at the cap, with a 400,000-iteration loop measured against
the same loop untraced; the problem statement and expected output persisting
across a restart; the model picker listing four installed models and defaulting
to the 7.6B rather than the 1.5B coder; both models answering the same
wrong-answer prompt, timed, with and without the trace; and the packaged build -
Monaco loading from inside `app.asar` with Python highlighting intact, and the
harness running from `resources/python/` where `extraResources` puts it.

Not exercised: a first-time download of a model that is not already on disk; the
packaged app's **Run** button specifically (the harness was invoked directly from
its packaged location instead, because `STUDIO_SHOT` is deliberately refused
when `app.isPackaged`); voice end to end, which needs a microphone and a person;
and macOS and Linux, where the code paths exist and are written from documented
behaviour but have not been run.

## Not done yet

The plan, and the notes needed to pick it up cold, are in **[NEXT.md](NEXT.md)**.

### Known gaps

- **No breakpoints.** Stepping is a replay of a finished run, not a debugger:
  you cannot stop it, change a value, or continue.
- **The first 300 steps, not the last.** Recording stops at the cap rather than
  keeping a rolling window, so a bug in the 10,000th iteration is past the end
  of the trace. A ring buffer would keep the interesting end, at the cost of
  tracing the whole run.
- **Stepping does not follow edits.** The trace is of the last run, so after
  editing, a step marks whatever is now on that line number.
- **One file.** No open, no save-as, no tabs.
- **One test case.** *Expected output* holds a single expected string, not a
  table of cases.
- **No app icon.** Packaged builds use the default Electron icon.
- **`values` only at a crash.** The dedicated variables panel still needs an
  exception; for a clean run the same information is in the step-through.
