# Where this got to, and what is next

Updated 2026-09-06. Everything described as done is on `main`.

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
  text to scope a question to it. **The thread now survives a restart.**
- **Time & space** and **Can it be faster?** as dedicated buttons.
- Setup checklist: finds Python, starts an installed-but-stopped Ollama, and
  downloads a model with a progress bar.
- Runtime values at a crash, shown in the card and given to the model.
- **The problem statement**, pasted into its own box, given to the explanation
  and ask prompts so the code is judged against what it was meant to do.
- **Every run is traced** — `sys.settrace`, filtered to the user's file,
  recording `(line, changed locals)` up to a cap. The wrong-answer prompt
  carries the tail of it; the panel scrubs through all of it with the marker
  walking down the editor.
- **A model picker** in the title bar, remembered across restarts.
- **`npm run dist`** builds an installer; `npm run pack` an app directory.
- `npm test` covers the traceback parser, the harness and its tracer, XSS
  payloads against the answer renderer, and model choice and prompt shape.
  `npm audit` clean on Electron 44.

## Next, in this order

### 1. Keep the interesting end of a long trace

Recording stops at 300 steps. That was the right first choice — it makes tracing
free, and a 400,000-iteration loop measures the same traced as untraced — but it
keeps the *beginning* of a long run, and a bug in the 10,000th iteration is past
the end of it.

What would be better: keep tracing but hold the steps in a ring buffer, so the
last 300 survive instead of the first. The cost is that tracing then runs for
the whole program rather than switching itself off, which is exactly what the
cap was avoiding. A middle path worth trying: keep the first 100 steps and the
last 200, dropping the middle and saying so — the setup and the failure are the
two ends that matter, and it is the same `record()` function either way.

Whatever is chosen, `formatTrace` and `traceHeading` in `renderer/ai.js` already
have to tell the model what was left out, and the wording of that is load-bearing
(see below).

### 2. Follow the code as it is edited

The step-through is a replay of the last run, so after an edit a step marks
whatever now sits on that line number. Monaco can track this properly — a
decoration moves with the text — so recording the step lines as decorations at
run time, rather than as plain numbers, would keep the marks honest.

### 3. Polish and ship

- **An app icon.** Packaged builds use the default Electron icon; `npm run dist`
  says so on every build.
- **Actually run macOS and Linux.** `install.sh`, the interpreter probing, and
  now the `dmg`/`AppImage` targets are written from documented behaviour and
  have never been executed there.
- **Voice end to end.** Needs a microphone and a person; never tested.
- **The packaged Run button.** The harness was verified from its packaged
  location by invoking it directly, and the renderer was verified from inside
  the asar, but the two have not been exercised together — `STUDIO_SHOT` is
  deliberately refused when `app.isPackaged`, so this needs a human to click it.

## Things worth not rediscovering

- **The traceback is load-bearing.** `errors.js` parses it to choose the marked
  line, and it is shown verbatim. `test/harness.test.mjs` asserts that the
  harness's output, minus its marker lines, is byte for byte what Python would
  have printed. Two real bugs came from this: `exec()` adds a frame of ours, and
  an unnormalised path prints forward slashes where Python prints backslashes.
- **Values as facts are not enough.** Given `u = 9` only as context,
  `qwen2.5-coder:7b` still wrote "u could be greater than or equal to n" — the
  generic IndexError explanation is the likelier continuation. Naming the values
  in the closing question as well is what fixed it. The same trick is now
  applied to the traced values and to the problem statement, and
  `test/ai.test.mjs` asserts the closing question still carries them.
- **A truncated trace must say so.** The steps shown are then from the middle of
  a longer run. A model given the last recorded step with no warning explains a
  program that ended there.
- **A line event fires before the line runs.** So a step means "about to run line
  L, and these names changed since the previous step" — the changes belong to
  the step before. The panel says "about to run" for this reason; dropping that
  wording makes the whole view read as off by one.
- **Compare traced values by repr.** `graph[u].append(v)` mutates in place, so
  the object is the one it always was and identity sees nothing happen.
- **A 1.5B will not hold the no-fix rule.** `qwen2.5-coder:1.5b` answers in
  3.5s, and writes out the corrected line under a heading, with or without the
  trace, while blaming the wrong line. The 7.6B takes 51–74s and gets it right.
  `pickDefaultModel` therefore refuses anything under 3B while something larger
  is installed — it used to do the opposite, because it looked only at names
  containing "coder".
- **Model sizes come from the server, not the name.** A model pulled under a
  custom tag (`logic:latest`) has no number in its name; Ollama reports
  `parameter_size` per tag and `probe()` passes it through.
- **Do not write to the app's data directory from a spawned child.** Writes into
  `%APPDATA%\myIDE\session` were silently discarded from inside the app while
  identical code wrote fine to the project folder. The harness reports through
  marker lines on stderr instead, which need no writable directory.
- **The harness cannot live in the asar.** A spawned Python process reads the
  real filesystem, not Electron's patched `fs`. It ships as an extraResource and
  `main.js` switches on `app.isPackaged` to find it.
- **electron-builder ships every production dependency** whether or not `files`
  names it. Monaco has to be trimmed by exclusion (`dev`, `esm`, `min-maps`),
  which is 63MB of the asar.
- **`boot.js` hands Monaco over as a promise, not an event.** It is a classic
  script and runs during parsing; `app.js` is a module and is deferred. From a
  warm cache Monaco can resolve before `app.js` listens, and a one-shot event
  then fires into nothing — blank window, nothing in the console.
- **Small models write LaTeX.** `\(O(n^2)\)` arrives in most complexity answers;
  `markdown.js` strips the delimiters before escaping.
