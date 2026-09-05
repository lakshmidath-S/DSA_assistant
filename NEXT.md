# Where this got to, and what is next

Written 2026-09-06. Everything described as done is on `main` and pushed.

## The point of the app, in one paragraph

Debugging DSA solutions by pasting them into a cloud chat means re-pasting after
every fix, and paying for it. Explaining one traceback, or one wrong answer, is a
small bounded job that a 1.5B–7B model on your own machine can do. The model is
here to make you understand your own mistake, not to hand you a working
solution — the corrected code is behind *Show the fix*, deliberately as the
quieter second button.

## Done

- Run a file; mark the failing line in the editor from the real traceback.
- Wrong answers, not just crashes: *Expected output* is checked on every run and
  a mismatch gets its own card.
- Explanations arrive unprompted, teach rather than answer, and never write the
  corrected code unless *Show the fix* is pressed.
- Follow-up questions with memory of the last three turns; select code or answer
  text to scope a question to it.
- **Time & space** and **Can it be faster?** as dedicated buttons.
- Setup checklist: finds Python, starts an installed-but-stopped Ollama, and
  downloads a model with a progress bar.
- Runtime values at a crash, shown in the card and given to the model.
- `npm test` covers the traceback parser, the harness, and XSS payloads against
  the answer renderer. `npm audit` clean on Electron 44.

## Next, in this order

### 1. Give it the problem statement

The smallest remaining win. The model has never seen the problem, so it infers
intent from the code — which is circular, because the code is what is wrong.

A field for the problem (pasted from LeetCode or wherever), stored with the
session like *Expected output* is, and included in the wrong-answer and ask
prompts. It turns "your output differs" into "the problem asks for indices in
ascending order; yours returns them in discovery order", and lets it question
the approach rather than only the output.

Touches: `renderer/index.html` (a field beside *Expected output*),
`renderer/app.js` (persist it, pass it through), `renderer/ai.js`
(`buildPrompt` and `buildAskPrompt`).

### 2. Trace execution, then visualise it

Two things want the same machinery, so build the tracer once.

`python/harness.py` currently reports values **only when something raises** — it
reads them off the exception's traceback. A run that finishes but prints the
wrong answer records nothing, which is exactly the case the app was extended to
cover. That needs `sys.settrace`, filtered to the user's file, recording a
bounded history of (line, changed locals).

With that history:

- the wrong-answer prompt can carry the last N steps instead of nothing;
- a step-through view can show the list, dict or tree changing, with a scrubber.

Watch the cost: tracing every line is slow, so cap the number of recorded steps
and stop recording past the cap rather than slowing the whole run. Reuse the
same stderr marker channel — see the note below about writable directories.

### 3. Polish and ship

- **Save the question thread.** It is lost on close today; only the code and
  expected output survive.
- **Try `qwen2.5-coder:1.5b`.** Already downloaded. Teaching answers currently
  take 14–25s on the 7B; if the 1.5B explains well enough at a few seconds, it
  is the better default for this job.
- **Package with `electron-builder`** so it runs without `npm start`.
- **Actually run macOS and Linux.** `install.sh` and the interpreter probing are
  written from documented behaviour and have never been executed there.
- **Voice end to end.** Needs a microphone and a person; never tested.

## Things worth not rediscovering

- **The traceback is load-bearing.** `errors.js` parses it to choose the marked
  line, and it is shown verbatim. `test/harness.test.mjs` asserts that the
  harness's output, minus its marker line, is byte for byte what Python would
  have printed. Two real bugs came from this: `exec()` adds a frame of ours, and
  an unnormalised path prints forward slashes where Python prints backslashes.
- **Values as facts are not enough.** Given `u = 9` only as context,
  `qwen2.5-coder:7b` still wrote "u could be greater than or equal to n" — the
  generic IndexError explanation is the likelier continuation. Naming the values
  in the closing question as well is what fixed it. Expect to need the same
  trick for traced values.
- **Do not write to the app's data directory from a spawned child.** Writes into
  `%APPDATA%\myIDE\session` were silently discarded from inside the app while
  identical code wrote fine to the project folder. The harness reports through a
  marker line on stderr instead, which needs no writable directory.
- **`boot.js` hands Monaco over as a promise, not an event.** It is a classic
  script and runs during parsing; `app.js` is a module and is deferred. From a
  warm cache Monaco can resolve before `app.js` listens, and a one-shot event
  then fires into nothing — blank window, nothing in the console.
- **Small models write LaTeX.** `\(O(n^2)\)` arrives in most complexity answers;
  `markdown.js` strips the delimiters before escaping.
