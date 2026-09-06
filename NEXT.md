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
- Settings: the checklist and the model list, with the active model on the bar.
  The last-used server starts itself on launch and stops on quit.
- Conversation older than the three-turn window is summarised rather than
  dropped, by the cheapest model on the server already running.
- Setup checklist: finds Python, starts every model server it finds that is
  installed but stopped - Ollama and LM Studio, from one **Start models**
  button - stops again on quit whatever it started, and downloads a model with
  a progress bar.
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
- **Voice with a real microphone.** The pipeline is now exercised end to end -
  the server starting on demand, `/stt` returning the right sentence, the
  question reaching the thread - but the audio was synthesised with Windows TTS
  and fed in, not spoken. `getUserMedia`, the waveform and the spoken reply
  still need a person and a microphone.
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
- **On Windows, neither spawn flag gives a hidden server that survives.**
  Measured, one spawn each, because the obvious fix is wrong:

  | | new console | outlives the app |
  |---|---|---|
  | `detached: true` | yes - 1 per spawn | yes |
  | `detached: false` | no | **no** |
  | `Start-Process -WindowStyle Hidden` | no | yes |

  `detached: true` means CREATE_NEW_CONSOLE and `windowsHide` cannot suppress
  it - the flags contradict each other and the console wins. With Windows
  Terminal as the default terminal application that is a Terminal window per
  spawn: pressing the button a few times left twenty-one orphaned
  `OpenConsole.exe` processes and took the machine to 0 FPS. Turning `detached`
  off fixes the windows and silently breaks the promise the checklist makes,
  because the server then dies with the app. PowerShell's `Start-Process` is
  the only one that does both, so that is what `launchDetached` uses on
  Windows. Elsewhere, plain `detached: true`.
- **Stop only what you started.** A server that was already running when myIDE
  opened belongs to whoever started it - someone may be part way through a chat
  in LM Studio's own window - so shutdown checks the port first and records
  ownership only when it actually spawned something. `ollama serve` is stopped
  by pid (`Start-Process -PassThru` hands it back); LM Studio is stopped by
  asking `lms server stop`, because `lms server start` never gave us a process
  to hold.
- **`before-quit` does not wait for you.** The process leaves as soon as the
  handler returns, so an async shutdown has to `preventDefault()`, do the work,
  and call `app.quit()` again - with a timeout, so a server that will not die
  cannot trap the app open.
- **Summarise the conversation, never the artifacts.** The code, the
  traceback, the recorded values and the trace are things the app holds exactly
  and sends in full on every request. Replacing any of them with a small
  model's paraphrase is how a hallucination gets manufactured, so the
  summariser only ever sees past questions and answers - and is told to add
  nothing, and to leave out what it is unsure of.
- **A wait with no counter reads as a crash.** The first `/stt` of a session
  loads Whisper: 17.2s measured with the model cached, minutes without. The old
  UI showed a fixed "Transcribing..." for all of it. `/health` answers during a
  transcription - the server is threaded - and reports `loaded.stt`, which is
  what lets the overlay say whether it is transcribing or still loading.
- **Do not write to an overlay you have just hidden.** Voice errors were set as
  text on the overlay *after* `setState('idle')` had hidden it, so every failure
  looked exactly like nothing happening. Error states are sticky now, and are
  dismissed by clicking them.
- **`explain()` does nothing without a run.** It answers about the last
  traceback or diff, so sending a spoken question to it produced silence
  whenever the file had not been run. Spoken questions go to `ask()`, which
  needs no run and leaves the answer in the thread.
- **Take the single-instance lock.** There is one scratch file, one session and
  one idea of whether a server is being started, and all of them are per
  process - so a second copy is not a second window, it is a second set of
  state fighting the first. It is easy to launch by accident, because a busy
  copy is exactly when someone clicks the shortcut again.
- **A button that is rebuilt cannot hold its own disabled flag.** `renderSetup`
  empties the list and makes a new button on every refresh, including the
  refresh the click itself causes. Guards belong in module state.
- **`spawn`'s failures do not reach its `try`/`catch`.** They arrive later as an
  `'error'` event, and an `'error'` event with no listener is thrown - in the
  main process that ends the app.
- **Probe every model server, not the first that answers.** Someone can be
  running LM Studio and Ollama at once; stopping at the first hid half their
  models, and which half depended on the order of the list.
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
