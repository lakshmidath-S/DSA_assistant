# Where this got to, and what is next

Updated 2026-11-15. Everything described as done is on `main`.

## The point of the app, in one paragraph

Debugging DSA solutions by pasting them into a cloud chat means re-pasting after
every fix, and paying for it. Explaining one traceback, or one wrong answer, is a
small bounded job that a 1.5B–7B model on your own machine can do. The model is
here to make you understand your own mistake, not to hand you a working
solution — the corrected code is behind *Show the fix*, deliberately as the
quieter second button.

## Done

- **2026-11-15: the paths a LeetCode user actually hits, and the tutor's leaks.**
  - *Design problems run.* `class MinStack` with `["MinStack","push",...]` and
    its argument lists, or the example pasted whole (bare `Input` / `Output`
    headings), is driven call by call (`run_design` in the harness). Output
    lists every call; the first wrong one gets the card ("At getMin(), call 8
    of 8") and a checked fact (`designSteps` / `designFact` in `cases.js`). A
    crash names the call; no cases asks for them in the class's own names.
  - *`self` is opened up.* Traces, crash values and loop samples show
    `self.stack`, not an address (`named_values`, at most 8 attributes), and a
    design call records the object's attributes after it (`state`).
  - *Input is a script's stdin*, written and closed (`run:start` takes it as a
    third argument). The EOFError note says whether Input was empty or ran out.
  - *A Solution that calls itself* with no cases runs as a script - it used to
    be called on nothing and report "needs a test case" over its own output.
  - *A stale Problem is named* when its examples do not fit the method: "The
    Problem is for different code", one action to clear it and run again.
  - *Big locals at a crash are glanced at*, not repr'd whole: a 2-million-item
    list was formatted in full before being cut to 200 characters.
  - *The tutor no longer gives the fix in words.* Measured: 21 of 24 automatic
    explanations handed it over in prose after a correct diagnosis.
    `teachingOnly()` cuts at the first fix sentence or non-quoting block and
    says so: 0 of 32 after. It also drops the request's own question when the
    model repeats it as a heading, and "Ask the student:" labels.
  - *The wrong-answer request is facts only*: the call, both answers, the code,
    each value's history along the call that made the answer (`callHistory`),
    and "walk through it, then ask one question". Reversed answer 2/6 -> ~6/8,
    off-by-one sum 2/6 -> ~5/8. A design case gets the calls with the object
    after each instead (`designStory`): 3/16 -> 6-7/16, on two bugs.
  - *Tests*: teachingOnly shapes, callHistory, the compact prompt, design
    harness runs, stdin, big values, design examples and facts, the EOF note.
    A third full-app script (16 checks) covers design, stale Problem,
    self-call and stdin; the 33- and 60-check scripts still pass.
- **LeetCode solutions run as they are.** A `class Solution` is called on each
  test case by the harness (`run_solution`), with LeetCode's imports, `ListNode`
  and `TreeNode` built from `[1,2,3]` where the signature says so, and in-place
  methods reporting their argument. Cases come from *Input* (Test cases tab), or from
  the pasted Problem's examples (`renderer/cases.js`), and each answer is judged
  against the Expected box or the examples' `Output:` lines - as values, with
  LeetCode's 1e-5 float tolerance and "in any order" honoured. A wrong case gets
  the diff card and, where it is simple, a checked difference ("reversed").
- **A loop that cannot end is named, not timed out.** A watchdog thread samples
  the stack at 5s; a `while` whose condition's names never changed is reported
  as an *Infinite loop* with its line, condition and values. Anything else gets
  until 12s and is called *Still running*.
- **A second full-app script, 33 checks**, and the 56-check one rerun, which
  found an old race: late output chunks threw away the full output (fixed with
  run numbers).
- **Decluttered (2026-11-01).** The problem drawer above the code and the
  Input / Expected drawers beside Output became one panel under the code with
  three tabs (Output, Test cases, Problem), resizable from its top edge, with a
  dot on a tab that has something in it. Cards lost their boxes: one large
  verdict line, a "where" sentence ("On line 4, in maxProfit(), with ...")
  whose line number jumps to the line, the values and the diff unboxed, and
  secondary actions as words instead of outlined buttons. A clean run no longer
  repeats its output on the card. Answer status reads "Answered by MODEL in
  1.4s." The 56-check script gained tab checks (60) and the Solution script now
  checks the where sentence; it caught `<genexpr>()` being named as the
  function, now the nearest function the student wrote.
- **The chalkboard redesign.** Problem above the code, Output beside Expected
  output under it, the right column only the tutor's. (Since replaced by the
  tabbed panel above.) A green slate with chalk
  colours that each mean one thing; the error's name as the card's headline; a
  dot on the bar for whether the model is ready. System fonts only - nothing
  downloaded or bundled. Every id the code uses was kept.
- **A full-app script, 56 checks, all passing** (see the README), which found
  four bugs, all fixed: `input()` hung for the whole time limit; a stopped run
  was called clean; a run started during another could not be stopped or timed
  out; and 20,000 printed lines took 149s to draw.
- Run a file; mark the failing line in the editor from the real traceback.
- Wrong answers, not just crashes: *Expected output* is checked on every run and
  a mismatch gets its own card.
- Explanations arrive unprompted, teach rather than answer, and never write the
  corrected code unless *Show the fix* is pressed.
- Follow-up questions with memory of the last two turns; select code or answer
  text to scope a question to it. **The thread now survives a restart.**
- **Time & space** and **Can it be faster?** as dedicated buttons.
- Settings: the checklist and the model list, with the active model on the bar.
  The last-used server starts itself on launch and stops on quit.
- **Every request ends.** `chat()` has load, stall and total timeouts, an
  output cap, and a live status line under each answer; a failure says why
  and offers **Try again** / **Start it** / **Choose a model**. A question with
  no model running still lands in the thread, with the reason. Each request
  has its own controller. The model is loaded at launch and kept loaded.
- **The default is the small non-thinking coder** (`qwen2.5-coder:1.5b`), not
  the 7.6B - see the trap below. Its teaching answers have the fix removed
  mechanically (`teachingOnly`), since it will not hold the rule on its own.
- Setup checklist: finds Python, starts every model server it finds that is
  installed but stopped - Ollama and LM Studio, from one **Start models**
  button - stops again on quit whatever it started, and downloads a model with
  a progress bar.
- Runtime values at a crash, shown in the card and given to the model.
- **The problem statement**, pasted into its own box, given to the explanation
  and ask prompts so the code is judged against what it was meant to do.
- **Every run is traced** — `sys.settrace`, filtered to the user's file,
  recording `(line, changed locals)` up to a cap. Long runs keep both ends
  (80 opening steps + 220 rolling tail, reporting the dropped count). Stepping
  marks are anchored to Monaco decorations and follow code edits. The
  wrong-answer prompt carries the tail of it; the panel scrubs through all of it
  with the marker walking down the editor.
- **Push-to-talk voice mode** — starts `servers/voice_server.py` on demand with
  a countdown and loading indicator, transcribes speech via faster-whisper on
  `/stt`, sends questions straight to `ask()` with context, and provides spoken
  TTS output via piper-tts on `/tts`.
- **A model picker** in the title bar, remembered across restarts.
- **`npm run dist`** builds an installer; `npm run pack` an app directory, with
  an icon generated by `build/make-icon.py`.
- **`npm test` lints first.** eslint with `no-undef` exists because three
  separate features were broken by a name that was never declared, and none of
  them said so.
- `npm test` covers the traceback parser, the harness, its tracer, the
  Solution runner and the loop watchdog, XSS payloads against the answer
  renderer, test cases from pasted problems, and model choice and prompt shape.
  `npm audit` clean on Electron 44.

## Next, in this order

### 1. The things that need another machine or another person

- **Actually run macOS and Linux.** `install.sh`, the interpreter probing, and
  the `dmg`/`AppImage` targets are written from documented behaviour and have
  never been executed there.
- **Voice with a real microphone.** The pipeline is exercised end to end - the
  server starting on demand, `/stt` returning the right sentence, the question
  reaching the thread, the counters and the failure messages - but the audio
  was synthesised with Windows TTS and fed in, not spoken. `getUserMedia`, the
  waveform and the spoken reply still need a person.
- **The packaged Run button.** The harness was verified from its packaged
  location by invoking it directly, and the renderer was verified from inside
  the asar, but the two have not been exercised together: `STUDIO_SHOT` is
  deliberately refused when `app.isPackaged`, so this needs a human to click it.

### 2. Worth doing next

- **A trace that survives the run.** The step-through is dropped when you run
  again; keeping the last few would let you compare two attempts.
- **Loading Whisper is all-or-nothing.** The first press of the microphone pays
  17s for it. Loading it in the background once the app is idle would hide
  that, at the cost of memory nobody asked for - which is why it is not done.
- **One file.** No open, no save-as, no tabs.
- **Design-bug explanations from the 1.5B are its weakest output now** - 6-7
  of 16 name the cause even with the object's state per call. The scratch
  measuring script built them from a real harness run of each buggy class;
  doing the same in `test/` (behind an opt-in flag, since it needs Ollama)
  would make the next prompt change measurable by anyone. Suggesting a larger
  model in the card when the run is a design problem is the other lever.
- **A top-level function as a test.** `def two_sum(nums, target)` with no call
  could be called on Input the way a Solution method is.
- **Wrong-answer explanations: the question at the end.** It ends on a
  question about 1 time in 4 and the question is often the student's own
  ("why does it return -3?"). Measured attempts to force it (a sentence cap)
  hurt the explanation; untried: asking for the question first.
- **Memory in a stuck loop.** One appending on every pass reached ~35 million
  items in five seconds. A memory ceiling on the child would bound it.

## Things worth not rediscovering

- **Each run handles only its own process.** The timeout and a new run used to
  call `killCurrent()`, and every run's `'close'` set `current = null`. A run
  started while another was going was then unreachable: the old run's close
  cleared `current`, so Stop and the 15s timeout both killed nothing and an
  endless loop ran until the app quit. `killRun(child)` takes the process;
  `close` clears `current` only if it is still that child. The renderer drops
  a result from a run that has been replaced (`runSeq`).
- **Close stdin.** Left open, `input()` waits for text that never comes, for
  the full time limit, and is then described as a possible infinite loop. Input
  is written first and then it is closed - never left open for typing.
- **A small model hands over the fix in words, after the diagnosis.** Removing
  code blocks was not enough: 21 of 24 answers said "to fix this, change X to
  Y" in prose. Cut at the first such sentence (`teachingOnly`); a sentence is a
  fix when it puts forward code the student did not write, not when it says
  what a value should have been.
- **For wrong answers, less prompt is better on a 1.5B.** The problem
  statement, step-by-step trace and instruction list it used to get made it
  blame correct lines. Two answers, the code, each value's history and "walk
  through how it gets there" did far better. Measure a prompt change over 6-8
  samples per bug against Ollama directly before believing it; one answer
  says nothing at this temperature.
- **Draw streamed output in batches.** `python -u` sends every `print()` as its
  own chunk; a span and a scroll per chunk is a layout per line, and 20,000
  lines that ran in 0.8s took 149s to appear. Chunks are drawn every 50ms and
  only the last 100k characters are kept while it runs.
- **Output chunks can arrive after the run's result.** They are separate IPC
  messages and are not ordered against the reply. A late chunk landing on the
  fully drawn output tripped the streaming size cap, which removes the oldest
  node - the whole output - so 20,000 lines showed the last 2,000, depending on
  timing. Every chunk carries its run's number; a run that has been drawn in
  full (`finishedRun`) takes no more.
- **A worked example is copied, content and all.** The crash example
  (`nums[len(nums)]`, IndexError) sent with wrong-answer explanations made the
  1.5B invent that IndexError in a third of them. It goes with crashes only.
- **The loop watchdog must speak before the editor's limit.** main.js kills at
  15s with no report; the harness gives up at 12s so its report always lands.
  It samples three times rather than once, because "still changing" is the
  difference between slow and stuck, and it never calls a `for` loop stuck.
- **Examples are parsed in the renderer, not the harness.** A pasted problem
  has explanations running over several lines and constraints after; only
  `cases.js` sees the whole text, and it sends the harness bare inputs.
- **Test against a throwaway profile.** `STUDIO_USERDATA` gives a test run its
  own `userData`, which is also what the single-instance lock is keyed on - so
  a test no longer needs the user's open copy closed, or a backup of their data.
- **A test window is throttled unless told not to be.** Launched from a script
  it opens behind the terminal, and Chromium throttles an occluded page's
  timers to about one a minute. `STUDIO_SHOT` mode turns background throttling
  off; without that, timings from a test are fiction.

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
- **A name that is never declared is invisible until pressed.** `node --check`
  parses; it cannot see one. Three features were broken by exactly that - the
  Start models button, and voice twice - and each failure was caught by a
  `try`/`catch` and reported as an ordinary problem, or as none at all. eslint
  with `no-undef` runs first in `npm test` for this reason.
- **Verify the code that ships, not a copy of it.** The server-start logic was
  checked by replaying it in a standalone script, which declared the `Q` that
  main.js did not. The script passed every time while the button did nothing.
- **A trace keeps both ends, and says where the middle went.** The gap is
  reported in the prompt and marked in the panel where it falls: a jump from
  the second iteration to the last otherwise reads as a loop that ran twice.
- **Recorded line numbers rot.** A step remembers the line it happened on, and
  that stops being true as soon as anything above it is edited. The steps are
  anchored to invisible Monaco decorations, which move with the text.
- **A truncated trace must say so.** The steps shown are then from the middle of
  a longer run. A model given the last recorded step with no warning explains a
  program that ended there.
- **A line event fires before the line runs.** So a step means "about to run line
  L, and these names changed since the previous step" — the changes belong to
  the step before. The panel says "about to run" for this reason; dropping that
  wording makes the whole view read as off by one.
- **Compare traced values by repr.** `graph[u].append(v)` mutates in place, so
  the object is the one it always was and identity sees nothing happen.
- **A model that thinks looks like a broken app.** The 7.6B default
  (`logic:latest`, a DeepSeek-R1 distill) reasons privately for ~43s before its
  first visible word, and the app hides reasoning - so, with no timeout on the
  request, questions sat under a blinking caret and the user could not tell
  slow from dead. It also ignores `think: false`. Ollama lists `thinking` in
  `capabilities`; use that, never the name, and never default to one.
- **A 1.5B will not hold the no-fix rule, and that is now handled in code.**
  `qwen2.5-coder:1.5b` wrote corrected code in 9/9 crash explanations under the
  long rule list. A short system prompt, one worked example and the rules
  repeated at the end of the request got it to 4/12; `teachingOnly()` (then
  `withoutCode()`, code blocks only) takes it to 0 shown. It still rarely ends with a question, and without recorded
  values it can name the wrong cause - with them it was right 3/3.
- **Only a 1.5B fits a 4 GB GPU.** At `num_ctx` 8192 a 4B got 2.3 of 4.1 GB
  onto the GPU; the context is 4096 now, which every request fits in.
- **Never run two models back to back on a small card.** The background
  history summary used the smallest model while answers used the default, so
  every question after the third could unload one and reload the other. It
  was removed rather than fixed.
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
- **Send the artifacts in full, every time.** The code, the traceback, the
  recorded values and the trace are things the app holds exactly. Replacing
  any of them with a model's paraphrase is how a hallucination gets made.
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
