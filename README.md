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
  finished and printed the wrong answer, because nothing raised. The marks
  follow the code as you edit it, rather than pointing at whatever has since
  moved into that line number.
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
  about your code, and remembers the last two exchanges, so a bare "why?" still
  has a subject. Answers stack as notes, not as a chat transcript. Only the
  last two exchanges are sent with a new question; older ones stay on screen.
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
- **It starts itself.** On launch myIDE starts the server your chosen model
  belongs to - or, if you have not chosen one, just Ollama - picks the model,
  and loads it before you ask anything. The header says *loading…* until it is
  ready. Everything it started is stopped again when you close the app;
  anything that was already running is left alone.
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

Both ends of a run are kept and the middle is dropped. Keeping only the first
N steps was the wrong half: setup is rarely where the bug is, and an answer
produced on the ten-thousandth iteration fell off the recording entirely. So
the opening 80 steps are kept exactly, the last 220 roll, and what falls out
between them is counted and reported - a 5,000-iteration loop keeps 300 steps,
drops 14,704, and still records the branch that only runs on the final pass.

Tracing also gives itself a second of wall time. Past that it switches itself
off, because a 400,000-iteration loop cannot be traced to its end at any
acceptable price: that costs about a second over the untraced run, against
losing the ending. When that happens the prompt is told in as many words, since
a model shown the last recorded step and nothing else will confidently explain
a program that ended where the recording did. The dropped middle is stated too,
and marked where it falls - otherwise a jump from the second iteration to the
last reads as a loop that ran twice.

Two things fall out of tracing that an exception handler cannot give at all:
a **caught** exception, which never reaches a traceback and is a real way to
print a wrong answer; and the value a function actually returned.

Changes are compared by **repr**, not by identity or equality. `graph[u].append(v)`
mutates a list in place, so the object is the same one it was before and `is`
sees nothing happen — while the repr, which is what the reader and the model are
shown, changes.

### Which model answers, and why it is the small one

The app answers with the smallest coder-tuned model installed that does not
think before it writes - `qwen2.5-coder:1.5b` on the machine this was built
on. Measured through the app's own prompt, on an RTX 3050 with 4 GB:

| | warm answer | first visible word | |
|---|---|---|---|
| `qwen2.5-coder:1.5b` | 1.4s | 0.5s | fits on the GPU |
| `qwen3:4b` | 30s | 24s | thinks before answering |
| `logic:latest` (7.6B) | 58s | 43s | thinks, and does not fit |

This reverses an earlier decision. The 7.6B was the default for a while because
its answers followed the teaching rule more carefully. They did, when they
arrived - but it reasons privately for about forty seconds before writing a
word, and with the reasoning hidden that looked exactly like nothing happening.
Together with a request path that had no timeout, that is how the app came to
feel broken: questions sat under a blinking caret and there was no telling slow
from dead.

Ollama reports which models think (`capabilities`, from `/api/show`), and a
thinking model is never the default while anything else is installed. Pick one
in Settings and it is asked not to think (`think: false`). Most honour that; a
DeepSeek-R1 distill such as `logic:latest` reasons anyway, and the status line
then says so and counts the seconds.

What the small model costs, measured:

- **It ignores the no-fix rule.** Told not to, it wrote corrected code in 9 of 9
  explanations of three common crashes. A short prompt with one worked example
  and the rules repeated at the very end cut that to 4 of 12. The rest is
  enforced mechanically: `withoutCode()` removes code blocks from the automatic
  explanation and leaves a note saying *Show the fix* has it. Across those 12,
  the reader was shown code 0 times. *Show the fix* is untouched, and so are
  follow-up questions - asking for code outright still gets code.
- **It rarely ends with a question** - 1 in 12.
- **Without the recorded values it can explain the wrong cause.** For a
  `KeyError` on `counts[ch] += 1` it once said dictionary keys "must be unique".
  Given the values the app records - `counts = {}`, `ch = 'h'` - it named the
  real cause three times out of three.

With a bigger GPU, pick a larger model in Settings; the choice is remembered.
Picks saved by earlier versions were forgotten once, because they were made
while the app gave no sign of whether anything worked - and because the first
run used to save its own automatic default as though it had been chosen.

### Every request ends

The request path used to have no timeout of any kind. Now every answer ends
visibly, in one of two ways: the text and how long it took, or what went wrong
and something to press. While it is on its way the line under it counts -
*Asking qwen2.5-coder:1.5b…*, *Waiting… 6s (loading it, usually)*,
*…is thinking before it answers… 12s*, *Writing…*.

| What happened | What you see |
|---|---|
| Nothing listening | "Ollama is not running." with **Try again** and **Start it** |
| No reply within 120s | "No reply … It may be too large for this machine" with **Choose a model** |
| The stream stops for 45s | "stopped responding part-way through" |
| Over 180s in all | "Gave up after …" |
| Reasoning, then no answer | "finished without writing an answer" |
| The model is not installed | "… is not installed in Ollama." |
| The 600-token cap | the answer, marked "cut short at the length limit" |

A question asked while nothing can answer it still goes into the thread, with
the reason under it; it used to vanish, input cleared and nothing shown. Each
request has its own controller, so asking no longer cancels an explanation that
is still arriving, and **Run** cancels only the explanation of the previous run.

The chosen model is loaded at launch rather than at the first question - the
header says *loading…* meanwhile - and is kept loaded for 30 minutes between
questions. The background summary of older turns is gone: it sent a second
request, to a second model, after every answer, and on a 4 GB card the next
question then had to load the first model again.

`test/ai.test.mjs` runs `chat()` against a fake server that misbehaves in each
of the ways in that table, and checks every one of them ends.

Two details of real tracebacks are easy to get wrong, and both are covered:

- Since 3.11 the marker line mixes `~` and `^` (`return 1 / 0` → `~~^~~`), so
  matching `/^\s*\^+$/` misses nearly every modern traceback.
- Python discards the original indentation and re-indents the echoed source to
  exactly four spaces, so marker offsets are relative to the *trimmed* line. The
  caller has to add the real leading whitespace back, or every indented line
  underlines the wrong span.

## Security

```
npm test     # eslint, traceback parsing, harness/tracer, XSS payloads, AI prompts/models
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
build/               make-icon.py and icon.png for packaging
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

`python/harness.py` and `servers/` ship as **extraResources**, not inside the
asar. A spawned Python process reads through the real filesystem, not Electron's
patched `fs`, so Python code inside `app.asar` cannot be executed by an external
interpreter. `main.js` looks beside the archive when `app.isPackaged`, and inside
`__dirname` when it is not.

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
across a restart; the model picker listing four installed models; a 1.5B and a 7.6B
answering the same wrong-answer prompt, timed, with and without the trace; and the packaged build -
Monaco loading from inside `app.asar` with Python highlighting intact, and the
harness running from `resources/python/` where `extraResources` puts it.

Then, for the request path: the real app driven end to end, six launches,
five with Ollama stopped and one with it running but nothing loaded. Each
time the model warmed at launch (about 13s from stopped), then a crash was
explained, six follow-ups asked including a bare "why?", both quick buttons
pressed, and a question asked while an explanation was still arriving. 66 of
66 were answered, most in 1-5s, the slowest in 21.9s. Ollama
killed mid-session gave "Ollama is not running." with the question kept, and
**Start it** brought it back and answered in 16s.

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
- **One file.** No open, no save-as, no tabs.
- **The default ignores your hardware.** It is the smallest suitable model
  whatever the GPU; a machine that could run a 7B comfortably still starts on
  the 1.5B until someone picks the 7B in Settings.
- **The problem statement is never cleared for you.** It survives restarts,
  and if it describes an older problem, every answer is judged against that.
- **One test case.** *Expected output* holds a single expected string, not a
  table of cases.
- **`values` only at a crash.** The dedicated variables panel still needs an
  exception; for a clean run the same information is in the step-through.
- **A trace is replaced on the next run.** The step-through recording reflects
  only the most recent run; earlier runs are not archived for comparison.
