/*---------------------------------------------------------------------------------------------
 *  myIDE - wiring.
 *
 *  The whole application flow is: edit -> Run -> Python tells us exactly what
 *  broke -> point at it -> optionally have a model explain it. There is no
 *  chat, no session, no history to manage; one file, one error at a time.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { parseTraceback, describe, hintFor } from './errors.js';
import {
	PROVIDERS, pickDefaultServer, buildPrompt, chat, stripReasoning,
	SYSTEM_PROMPT, SYSTEM_PROMPT_REVEAL, SYSTEM_PROMPT_ASK,
	SYSTEM_PROMPT_COMPLEXITY, SYSTEM_PROMPT_OPTIMISE, buildAskPrompt,
	SYSTEM_PROMPT_SUMMARY, buildSummaryPrompt, pickSmallestModel,
} from './ai.js';
import { Voice } from './voice.js';
import { render, escapeHtml } from './markdown.js';
import { probe, isReady, pullModel, waitForProviders, SUGGESTED, pythonHelp, formatBytes } from './setup.js';

/** Blank, deliberately. The empty-state hint carries the guidance instead. */
const STARTER = '';

const $ = id => document.getElementById(id);

const els = {
	run: $('run'), stop: $('stop'), status: $('status'), mic: $('mic'),
	out: $('out'), card: $('card'), okCard: $('ok-card'), okMeta: $('ok-meta'),
	errType: $('err-type'), errHint: $('err-hint'), errLine: $('err-line'),
	explain: $('explain'), ask: $('ask'), aiMeta: $('ai-meta'), jump: $('jump'),
	overlay: $('voice-overlay'), wave: $('wave'), voiceState: $('voice-state'),
	empty: $('empty'), okOut: $('ok-out'),
	splitter: $('splitter'), outEmpty: $('out-empty'),
	setup: $('setup'), setupSteps: $('setup-steps'), setupRecheck: $('setup-recheck'),
	setupBanner: $('setup-banner'), setupBannerNote: $('setup-banner-note'),
	diffCard: $('diff-card'), diffWant: $('diff-want'), diffGot: $('diff-got'),
	diffExplain: $('diff-explain'), diffAsk: $('diff-ask'), diffMeta: $('diff-meta'),
	expect: $('expect'), expectToggle: $('expect-toggle'),
	reveal: $('reveal'), diffReveal: $('diff-reveal'),
	thread: $('thread'), askInput: $('ask-input'), askSend: $('ask-send'),
	askComplexity: $('ask-complexity'), askOptimise: $('ask-optimise'),
	threadClear: $('thread-clear'), selChip: $('sel-chip'), selText: $('sel-text'),
	selClear: $('sel-clear'),
	values: $('values'), valuesRows: $('values-rows'),
	settingsOpen: $('settings-open'), settingsClose: $('settings-close'),
	settings: $('settings'), settingsServers: $('settings-servers'),
	modelLabel: $('model-label'),
	problem: $('problem'), problemToggle: $('problem-toggle'),
	traceCard: $('trace-card'), traceToggle: $('trace-toggle'), traceBody: $('trace-body'),
	traceCount: $('trace-count'), traceScrub: $('trace-scrub'), tracePrev: $('trace-prev'),
	traceNext: $('trace-next'), traceWhere: $('trace-where'), traceVars: $('trace-vars'),
	traceNote: $('trace-note'),
};

let editor;
let decorations;
/** Kept apart from the error marker: the two are shown at the same time. */
let traceDecorations;
let scratchPath = '';
let lastRun;
let aiAbort;
const ai = { provider: undefined, model: undefined };

// --- editor -------------------------------------------------------------------

window.monacoLoaded.then(async () => {
	const info = await window.studio.info();
	scratchPath = info.scratch;

	monaco.editor.defineTheme('studio', {
		base: 'vs-dark',
		inherit: true,
		rules: [],
		colors: {
			'editor.background': '#101014',
			'editorGutter.background': '#101014',
			'editorLineNumber.foreground': '#3b3b47',
			'editorLineNumber.activeForeground': '#9a9aab',
			'editor.lineHighlightBackground': '#16161c',
			'editorIndentGuide.background1': '#1c1c24',
		},
	});

	const session = await window.studio.loadSession();

	editor = monaco.editor.create($('editor'), {
		value: session.code || STARTER,
		language: 'python',
		theme: 'studio',
		fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
		fontSize: 14,
		lineHeight: 22,
		minimap: { enabled: false },
		scrollBeyondLastLine: false,
		renderLineHighlight: 'line',
		padding: { top: 16, bottom: 16 },
		automaticLayout: true,
		wordWrap: 'on',
		tabSize: 4,
		insertSpaces: true,
		smoothScrolling: true,
		cursorBlinking: 'smooth',
		// A beginner does not need these, and each one is a thing to be confused by.
		folding: false,
		glyphMargin: true,
		lightbulb: { enabled: false },
		occurrencesHighlight: 'off',
		selectionHighlight: false,
		suggestOnTriggerCharacters: true,
		quickSuggestions: { other: true, comments: false, strings: false },
	});

	decorations = editor.createDecorationsCollection();
	traceDecorations = editor.createDecorationsCollection();
	editor.setPosition({ lineNumber: session.line ?? 1, column: session.column ?? 1 });
	editor.focus();

	// Editing invalidates both marks: they are about code that no longer exists.
	editor.onDidChangeModelContent(() => {
		if (decorations.length) {
			decorations.clear();
		}
		if (traceDecorations.length) {
			traceDecorations.clear();
		}
		updateEmptyState();
		scheduleSave();
	});
	updateEmptyState();
	editor.onDidChangeCursorPosition(scheduleSave);

	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

	watchSelections();
	rememberBox(els.problem, els.problemToggle, 'problem');
	rememberBox(els.expect, els.expectToggle, 'expected');
	restoreThread();
	await bootModels();
});

/** The hint is for an empty file only; once there is code it would be in the way. */
function updateEmptyState() {
	els.empty.hidden = editor.getValue().trim().length > 0;
}

/**
 * Replaces the absolute path of our scratch file with something a beginner can
 * read. Python prints the full path on every frame, which is both noise and the
 * longest thing in the panel.
 */
function tidy(text) {
	if (!text) {
		return '';
	}
	// split/join rather than a RegExp: the path is full of backslashes and brings
	// a drive-letter colon with it. Escaping all of that into a pattern is a bug
	// waiting to happen, and there is nothing here a literal cannot do.
	return text
		.split(`"${scratchPath}"`).join('your program')
		.split(scratchPath).join('your program')
		.replace(/ *File "?your program"?, line (\d+)(?:, in (\S+))?/g,
			(_m, line, fn) => (fn && fn !== '<module>' ? `  line ${line}, in ${fn}` : `  line ${line}`));
}

/** Redraws the output panel from the finished run, tidied. */
function paintOutput(result) {
	els.out.textContent = '';
	const out = (result.stdout ?? '').trim();
	const err = tidy(result.stderr ?? '').trim();

	if (out) {
		els.out.appendChild(document.createTextNode(err ? `${out}\n\n` : out));
	}
	if (err) {
		const span = document.createElement('span');
		span.className = 'stderr';
		span.textContent = err;
		els.out.appendChild(span);
	}
	els.outEmpty.hidden = Boolean(out || err);
}

// --- session ------------------------------------------------------------------

let saveTimer;
function scheduleSave() {
	clearTimeout(saveTimer);
	saveTimer = setTimeout(() => {
		const pos = editor.getPosition();
		window.studio.saveSession({
			code: editor.getValue(),
			line: pos?.lineNumber ?? 1,
			column: pos?.column ?? 1,
		});
	}, 400);
}

window.addEventListener('beforeunload', () => {
	const pos = editor?.getPosition();
	window.studio.saveSession({
		code: editor?.getValue() ?? '',
		line: pos?.lineNumber ?? 1,
		column: pos?.column ?? 1,
	});
});

// --- running ------------------------------------------------------------------

window.studio.onRunData(({ bucket, text }) => {
	const span = document.createElement('span');
	if (bucket === 'err') {
		span.className = 'stderr';
	}
	span.textContent = text;
	els.out.appendChild(span);
	els.out.scrollTop = els.out.scrollHeight;
});

async function run() {
	if (!editor) {
		return;
	}
	aiAbort?.abort();
	decorations.clear();
	traceDecorations.clear();
	els.out.textContent = '';
	els.card.hidden = true;
	els.okCard.hidden = true;
	els.diffCard.hidden = true;
	els.traceCard.hidden = true;
	els.explain.innerHTML = '';
	els.diffExplain.innerHTML = '';
	els.aiMeta.textContent = '';
	els.diffMeta.textContent = '';

	els.run.disabled = true;
	els.stop.hidden = false;
	els.status.textContent = 'Running…';

	const code = editor.getValue();
	const result = await window.studio.run(code);

	els.run.disabled = false;
	els.stop.hidden = true;
	els.status.textContent = `Ran in ${(result.ms / 1000).toFixed(1)}s`;

	lastRun = { ...result, code };

	// A missing interpreter is a setup problem, not a bug in the program. Open
	// the checklist rather than report an error that cannot be acted on.
	if (result.stderr === 'no-python') {
		els.status.textContent = '';
		els.out.textContent = '';
		els.outEmpty.hidden = false;
		await refreshSetup();
		openSettings();
		return;
	}

	paintOutput(result);

	// Before the cards, and regardless of which one is about to be shown: the
	// path it took is worth having whether it crashed, printed the wrong thing,
	// or looked fine.
	showTrace(result.trace);

	const parsed = parseTraceback(result.stderr, scratchPath || result.file);
	if (parsed) {
		showError(parsed, code);
		return;
	}

	// No crash. If an expected output was given, a mismatch is still a failure -
	// and it is the one this app exists for.
	const expected = normalise(els.expect.value);
	const got = normalise(result.stdout);
	if (expected && expected !== got) {
		lastRun.expected = expected;
		showDiff(expected, got);
		if (ai.provider) {
			explain(undefined, 'diff');
		}
		return;
	}

	showClean(result, Boolean(expected));
}

function showError(parsed, code) {
	els.card.hidden = false;
	els.okCard.hidden = true;
	els.errType.textContent = describe(parsed);
	els.errHint.textContent = hintFor(parsed);

	// A traceback can name a line this buffer does not have - a frame from
	// another file, or a stale run against code that has since been edited down.
	// Monaco throws "Illegal value for lineNumber" on those, which kills the rest
	// of showError and leaves the panel half-drawn, so the error still gets
	// reported but nothing is marked.
	const lineCount = editor.getModel().getLineCount();
	const line = parsed.primary?.line;
	if (line && line >= 1 && line <= lineCount) {
		const text = code.split('\n')[line - 1] ?? '';
		els.errLine.textContent = `${line}  ${text.trim()}`;
		markLine(parsed, text);
		editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
	} else {
		els.errLine.textContent = '';
	}

	lastRun.parsed = parsed;
	showValues(lastRun.values);

	// Arrives on its own. The old build made you ask, which is what made it feel
	// like a chat window rather than part of the editor.
	if (ai.provider) {
		explain();
	}
}

function showClean(result, matchedExpected) {
	els.okCard.hidden = false;
	els.card.hidden = true;
	els.values.hidden = true;
	els.diffCard.hidden = true;

	const printed = (result.stdout ?? '').trim();
	if (result.timedOut) {
		els.okMeta.textContent = 'Stopped after 15 seconds — is there a loop that never ends?';
	} else if (matchedExpected) {
		els.okMeta.textContent = `Output matches what you expected (${(result.ms / 1000).toFixed(1)}s).`;
	} else if (printed) {
		els.okMeta.textContent = `No errors. It printed this in ${(result.ms / 1000).toFixed(1)}s:`;
	} else {
		els.okMeta.textContent = `No errors, and it printed nothing (${(result.ms / 1000).toFixed(1)}s).`;
	}

	els.okOut.hidden = !printed;
	els.okOut.textContent = printed.slice(0, 400);
}

/**
 * Puts the error on the code itself: a gutter dot, a tinted row, a squiggle
 * under the offending span, and the message trailing the line. This is the bit
 * that replaces a chat transcript.
 */
function markLine(parsed, text) {
	const line = parsed.primary.line;
	const model = editor.getModel();
	const maxColumn = model.getLineMaxColumn(line);

	// Python's marker offsets are relative to the trimmed line, so put the real
	// indentation back before turning them into columns. Without this, every
	// indented line - which in DSA code is most of them - underlines the wrong
	// span. Fall back to the whole statement when there was no marker at all.
	const indent = text.length - text.trimStart().length;
	const startColumn = parsed.caretOffset !== undefined
		? Math.min(maxColumn, indent + parsed.caretOffset + 1)
		: indent + 1;
	const endColumn = parsed.markEnd !== undefined
		? Math.min(maxColumn, indent + parsed.markEnd + 1)
		: maxColumn;

	decorations.set([
		{
			range: new monaco.Range(line, 1, line, 1),
			options: {
				isWholeLine: true,
				className: 'err-row',
				glyphMarginClassName: 'err-glyph',
				glyphMarginHoverMessage: { value: describe(parsed) },
			},
		},
		{
			range: new monaco.Range(line, startColumn, line, Math.max(startColumn + 1, endColumn)),
			options: {
				inlineClassName: 'err-squiggle',
				hoverMessage: { value: `**${parsed.type}** — ${parsed.message}` },
			},
		},
		{
			range: new monaco.Range(line, maxColumn, line, maxColumn),
			options: {
				after: {
					content: `   ${parsed.type}: ${parsed.message}`.slice(0, 90),
					inlineClassName: 'err-after',
				},
			},
		},
	]);

	// Monaco's own marker gives the hover and the overview-ruler tick for free.
	monaco.editor.setModelMarkers(model, 'studio', [{
		severity: monaco.MarkerSeverity.Error,
		startLineNumber: line,
		startColumn,
		endLineNumber: line,
		endColumn: maxColumn,
		message: `${parsed.type}: ${parsed.message}`,
	}]);
}

els.run.addEventListener('click', run);
els.stop.addEventListener('click', () => window.studio.stop());
els.jump.addEventListener('click', () => {
	const line = lastRun?.parsed?.primary?.line;
	if (line) {
		editor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
		editor.setPosition({ lineNumber: line, column: 1 });
		editor.focus();
	}
});

// --- the model ----------------------------------------------------------------

/**
 * @param {string} [question] Free text, e.g. something said out loud.
 * @param {'error'|'diff'} [target] Which card the answer belongs in.
 * @param {boolean} [reveal] Show the fix outright, rather than teaching.
 */
async function explain(question, target = 'error', reveal = false) {
	if (!ai.provider || !lastRun) {
		return;
	}
	aiAbort?.abort();
	aiAbort = new AbortController();

	const out = target === 'diff' ? els.diffExplain : els.explain;
	const meta = target === 'diff' ? els.diffMeta : els.aiMeta;
	const askBtn = target === 'diff' ? els.diffAsk : els.ask;
	const revealBtn = target === 'diff' ? els.diffReveal : els.reveal;

	out.innerHTML = '<span class="caret"></span>';
	askBtn.disabled = true;
	revealBtn.disabled = true;
	const started = Date.now();
	let text = '';

	try {
		await chat({
			provider: ai.provider,
			model: ai.model,
			signal: aiAbort.signal,
			messages: [
				{ role: 'system', content: reveal ? SYSTEM_PROMPT_REVEAL : SYSTEM_PROMPT },
				{
					role: 'user',
					content: buildPrompt({
						code: lastRun.code,
						parsed: lastRun.parsed,
						stdout: lastRun.stdout,
						expected: lastRun.expected,
						values: lastRun.values,
						trace: lastRun.trace,
						problem: els.problem.value,
						question,
					}),
				},
			],
		}, token => {
			text += token;
			out.innerHTML = render(stripReasoning(text)) + '<span class="caret"></span>';
			out.scrollTop = out.scrollHeight;
		});

		out.innerHTML = render(stripReasoning(text));
		meta.textContent = `${ai.model} · ${((Date.now() - started) / 1000).toFixed(1)}s`;
	} catch (err) {
		if (err.name !== 'AbortError') {
			out.innerHTML = `<p style="color:var(--bad)">${escapeHtml(err.message)}</p>`;
		}
	} finally {
		askBtn.disabled = false;
		revealBtn.disabled = false;
	}
	return text;
}

els.ask.addEventListener('click', () => explain());
els.reveal.addEventListener('click', () => explain(undefined, 'error', true));
els.diffReveal.addEventListener('click', () => explain(undefined, 'diff', true));

// --- voice ----------------------------------------------------------------
//
// One click starts recording, the next stops it, and every step after that
// says what it is doing. The old version held the key down, sent the
// transcript to explain() - which does nothing at all when there has been no
// run to explain - and wrote its errors into an overlay it had already
// hidden. So a failure and a success looked identical: nothing.
//
// Now the question goes into the thread like any other, where the answer
// streams in visibly and is kept.

const LABELS = {
	checking: 'Checking the speech server…',
	starting: 'Starting the speech server…',
	listening: 'Listening — click the microphone again to send',
	transcribing: 'Transcribing…',
	thinking: 'Thinking…',
	speaking: 'Speaking…',
};

/** Sticky states: an error stays until it is read and dismissed. */
let voiceError = false;

const voice = new Voice(els.wave, (state, detail) => {
	if (state === 'idle' && !voiceError) {
		els.overlay.hidden = true;
		els.mic.classList.remove('live');
		return;
	}
	els.overlay.hidden = false;
	els.mic.classList.toggle('live', state === 'listening');
	els.voiceState.textContent = detail ?? LABELS[state] ?? state;
});

/** Shows a message that does not disappear on its own. */
function voiceProblem(message) {
	voiceError = true;
	els.overlay.hidden = false;
	els.mic.classList.remove('live');
	els.voiceState.textContent = `${message}  (click to dismiss)`;
}

els.overlay.addEventListener('click', () => {
	if (voiceError) {
		voiceError = false;
		els.overlay.hidden = true;
	}
});

/**
 * Makes sure the speech server is up, starting it if it is not.
 *
 * It is not started with the app: it is optional, and loading Whisper costs
 * real memory for someone who never presses the button. So the first press of
 * the session pays for it, and says so rather than appearing to do nothing.
 */
async function ensureSpeech() {
	voice.setState('checking');
	if (await voice.available()) {
		return true;
	}

	voice.setState('starting');
	const res = await window.studio.startSpeech();
	if (!res.ok) {
		voiceProblem(res.error ?? 'Could not start the speech server.');
		return false;
	}

	// It binds its port before loading any model, so this is quick even on the
	// run that goes on to download several hundred megabytes.
	for (let i = 0; i < 30; i++) {
		if (await voice.available()) {
			return true;
		}
		voice.setState('starting', `Starting the speech server… ${i + 1}s`);
		await new Promise(r => setTimeout(r, 1000));
	}

	// It never came up. Its own stderr is the only thing that knows why -
	// usually a missing Python package.
	const log = (await window.studio.speechLog()) ?? '';
	const last = log.trim().split('\n').filter(Boolean).pop();
	voiceProblem(last
		? `The speech server did not start: ${last}`
		: 'The speech server did not start. Run: pip install -r servers/requirements.txt');
	return false;
}

/** True while the microphone is open, so the button knows which half it is on. */
let recording = false;
let recordingTimer;

async function startRecording() {
	voiceError = false;
	if (!ai.provider) {
		voiceProblem('No model is running, so there would be nothing to answer you.');
		return;
	}
	if (!await ensureSpeech()) {
		return;
	}

	try {
		await voice.start();
	} catch (err) {
		voiceProblem(err.message);
		return;
	}

	recording = true;
	// A counter, so a long question still looks like it is being recorded.
	const began = Date.now();
	recordingTimer = setInterval(() => {
		const seconds = Math.round((Date.now() - began) / 1000);
		voice.setState('listening', `${LABELS.listening}  ${seconds}s`);
	}, 1000);
}

async function stopRecordingAndAsk() {
	recording = false;
	clearInterval(recordingTimer);

	let said;
	try {
		said = await voice.stop();
	} catch (err) {
		voiceProblem(err.message);
		return;
	}

	if (!said) {
		voiceProblem('Nothing was recorded. Say something after the waveform appears.');
		return;
	}

	// Show what it heard before acting on it: a wrong transcription otherwise
	// produces a confusing answer with no visible cause.
	voice.setState('thinking', `“${said}”`);
	await new Promise(r => setTimeout(r, 900));
	els.overlay.hidden = true;
	els.mic.classList.remove('live');

	// Into the thread, where the answer streams in and stays. explain() was the
	// wrong target: it answers about the last run, and does nothing when there
	// has not been one.
	const answer = await ask(said);
	if (answer) {
		voice.speak(stripReasoning(answer).split('\n')[0]);
	}
}

async function toggleMic() {
	if (recording) {
		await stopRecordingAndAsk();
	} else {
		await startRecording();
	}
}

els.mic.addEventListener('click', toggleMic);

window.addEventListener('keydown', e => {
	if (e.ctrlKey && e.altKey && e.code === 'KeyV' && !e.repeat) {
		e.preventDefault();
		toggleMic();
	}
});
// --- resizing and zoom ---------------------------------------------------------

/*
 * A draggable split rather than a fixed 400px: a long explanation wants a wide
 * panel, editing wants a wide editor, and which you want changes minute to
 * minute. The width is remembered per viewer.
 */
(() => {
	const saved = Number(localStorage.getItem('sideWidth'));
	if (saved >= 260 && saved <= 900) {
		document.documentElement.style.setProperty('--side-w', `${saved}px`);
	}

	let dragging = false;
	els.splitter.addEventListener('mousedown', e => {
		dragging = true;
		els.splitter.classList.add('dragging');
		// Stops the editor stealing the drag as a text selection.
		e.preventDefault();
	});

	window.addEventListener('mousemove', e => {
		if (!dragging) {
			return;
		}
		const width = Math.min(900, Math.max(260, window.innerWidth - e.clientX));
		document.documentElement.style.setProperty('--side-w', `${width}px`);
	});

	window.addEventListener('mouseup', () => {
		if (!dragging) {
			return;
		}
		dragging = false;
		els.splitter.classList.remove('dragging');
		const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side-w'), 10);
		try {
			localStorage.setItem('sideWidth', String(w));
		} catch {
			/* private window, or storage disabled - the width just will not persist */
		}
	});
})();

/** Ctrl +/- changes the editor font, as it does in every other editor. */
(() => {
	const FONT_MIN = 10;
	const FONT_MAX = 28;
	let size = Number(localStorage.getItem('fontSize')) || 14;

	function apply(next) {
		size = Math.min(FONT_MAX, Math.max(FONT_MIN, next));
		editor?.updateOptions({ fontSize: size, lineHeight: Math.round(size * 1.6) });
		try {
			localStorage.setItem('fontSize', String(size));
		} catch {
			/* not worth failing a keystroke over */
		}
	}

	window.addEventListener('keydown', e => {
		if (!e.ctrlKey) {
			return;
		}
		if (e.key === '=' || e.key === '+') {
			e.preventDefault();
			apply(size + 1);
		} else if (e.key === '-') {
			e.preventDefault();
			apply(size - 1);
		} else if (e.key === '0') {
			e.preventDefault();
			apply(14);
		}
	});

	window.monacoLoaded.then(() => apply(size));
})();

// --- setup --------------------------------------------------------------------
// A machine that cannot yet do the job should say what is missing and, where it
// can, fix it with one button. Nothing here installs anything without a click.

let setupState;

/** True while a start is in flight, so a rebuilt button knows not to start another. */
let startingServers = false;

/**
 * One refresh at a time.
 *
 * Every button in the checklist ends by refreshing it, and a refresh rebuilds
 * every button - so overlapping calls race on the same list, each rendering
 * over the last and leaving its own probe outstanding. A caller that asks
 * during a refresh gets that refresh rather than starting a second one.
 */
let setupInFlight;

function refreshSetup() {
	setupInFlight ??= doRefreshSetup().finally(() => {
		setupInFlight = undefined;
	});
	return setupInFlight;
}

async function doRefreshSetup() {
	setupState = await probe();

	const servers = setupState.servers ?? [];
	// A remembered choice beats the default, but only while that exact model is
	// still on that exact server: either can be deleted between sessions, and
	// the server it was on can simply not be running today.
	const remembered = readModelChoice();
	const choice = remembered && servers.some(s =>
		s.provider === remembered.provider && s.models.includes(remembered.model))
		? remembered
		: pickDefaultServer(servers);

	if (choice) {
		ai.provider = choice.provider;
		ai.model = choice.model;
		paintModelLabel();
		els.ask.disabled = false;
		els.diffAsk.disabled = false;
		els.reveal.disabled = false;
		els.diffReveal.disabled = false;
		setAskEnabled(true);
	} else {
		ai.provider = undefined;
		ai.model = undefined;
		paintModelLabel();
		els.ask.disabled = true;
		els.diffAsk.disabled = true;
		els.reveal.disabled = true;
		els.diffReveal.disabled = true;
		setAskEnabled(false);
	}

	renderSetup(setupState);

	// The checklist lives in Settings, so the panel carries only a pointer to
	// it - and only while there is something left to do.
	const ready = isReady(setupState);
	els.setupBanner.hidden = ready;
	if (!ready) {
		const stocked = (setupState.servers ?? []).some(s => s.models.length);
		const idle = [setupState.ollamaPath, setupState.lmsPath].filter(Boolean).length
			> (setupState.servers ?? []).length;
		els.setupBannerNote.textContent = !setupState.python?.ok
			? 'Python 3 was not found'
			: !stocked
				? 'No model is available yet'
				: idle
					? 'A model server is installed but not started'
					: 'Something still needs attention';
	}

	if (!els.settings.hidden) {
		renderSettings();
	}
}

/**
 * Brings up the model server you were last using, before anything asks for it.
 *
 * Only that one. Both servers at once costs gigabytes of weights for a choice
 * you have already made, and the other is started the moment you pick
 * something on it in Settings.
 *
 * The first run has no choice to honour, so it starts whatever is installed,
 * looks at everything that answers, and takes the best of it - which is then
 * the remembered choice for every run after.
 */
async function bootModels() {
	const remembered = readModelChoice();

	els.status.textContent = remembered
		? `Starting ${PROVIDERS[remembered.provider]?.label ?? remembered.provider}…`
		: 'Looking for a model…';

	try {
		const only = remembered ? [remembered.provider] : undefined;
		const res = await window.studio.startServers(only);
		if (res?.starting?.length) {
			await waitForProviders(res.starting, 25000);
		}
	} catch {
		// The checklist will show what is missing; a failed autostart is not
		// worth a dialog on the way in.
	}

	els.status.textContent = '';
	await refreshSetup();

	// First run: whatever we picked is now the remembered choice, so the next
	// launch starts one server instead of all of them.
	if (!remembered && ai.provider && ai.model) {
		rememberModelChoice(ai.provider, ai.model);
	}
}
function readSetting(key) {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

/**
 * Separates the server from the model in a remembered choice.
 *
 * The two together are the choice - the same model can be present in both LM
 * Studio and Ollama, and a request has to go to one of them. A control
 * character, because a model name may contain a colon (Ollama tags) or a
 * slash (LM Studio paths) but never this.
 */
const PICK_SEP = '\u0001';

const encodePick = (provider, model) => `${provider}${PICK_SEP}${model}`;

/** The remembered choice, as `{ provider, model }`, or undefined. */
function readModelChoice() {
	const saved = readSetting('model');
	const at = saved.indexOf(PICK_SEP);
	if (!saved || at === -1) {
		return undefined;
	}
	return { provider: saved.slice(0, at), model: saved.slice(at + 1) };
}

function rememberModelChoice(provider, model) {
	try {
		localStorage.setItem('model', encodePick(provider, model));
	} catch {
		/* the choice just will not survive a restart */
	}
}

/** The bar shows what is answering; everything about changing it is in Settings. */
function paintModelLabel() {
	els.modelLabel.textContent = ai.model ?? 'no model yet';
	els.settingsOpen.title = ai.model
		? `${PROVIDERS[ai.provider].label} · ${ai.model}  (Settings)`
		: 'No model is running  (Settings)';
}

/**
 * Draws the model list in Settings, one block per server.
 *
 * A server that is not running still gets a block, with the button that starts
 * it. That is the whole point of doing this here rather than in a dropdown:
 * only the server holding your model needs to be up, and the other one is
 * started at the moment you ask for something on it, not before.
 */
function renderSettings() {
	els.settingsServers.textContent = '';

	const servers = setupState?.servers ?? [];
	const installed = {
		ollama: Boolean(setupState?.ollamaPath),
		lmstudio: Boolean(setupState?.lmsPath),
	};

	for (const provider of ['lmstudio', 'ollama']) {
		const server = servers.find(s => s.provider === provider);
		if (!server && !installed[provider]) {
			continue;   // not installed; nothing useful to say about it
		}

		const block = document.createElement('div');
		block.className = 'server';

		const head = document.createElement('div');
		head.className = 'server-head';
		const name = document.createElement('span');
		name.className = 'server-name';
		name.textContent = PROVIDERS[provider].label;
		const state = document.createElement('span');
		state.className = 'server-state';
		state.textContent = server
			? `${server.models.length} model${server.models.length === 1 ? '' : 's'}`
			: 'not running';
		head.append(name, state);
		block.appendChild(head);

		if (server && server.models.length) {
			const list = document.createElement('div');
			list.className = 'model-list';
			for (const model of server.models) {
				const row = document.createElement('button');
				row.className = 'model-row';
				row.textContent = model;
				if (provider === ai.provider && model === ai.model) {
					row.classList.add('chosen');
				}
				row.addEventListener('click', () => chooseModel(provider, model));
				list.appendChild(row);
			}
			block.appendChild(list);
		} else if (installed[provider]) {
			const start = button(`Start ${PROVIDERS[provider].label}`, async () => {
				start.disabled = true;
				start.textContent = `Starting…`;
				const res = await window.studio.startServers([provider]);
				if (!res.ok) {
					start.textContent = res.error ?? 'Could not start';
					start.disabled = false;
					return;
				}
				await waitForProviders([provider]);
				await refreshSetup();
				renderSettings();
			});
			const row = document.createElement('div');
			row.className = 'step-actions';
			row.appendChild(start);
			block.appendChild(row);
		}

		els.settingsServers.appendChild(block);
	}

	if (!els.settingsServers.children.length) {
		const empty = document.createElement('p');
		empty.className = 'setting-note';
		empty.textContent = 'Neither Ollama nor LM Studio is installed. The setup checklist has links.';
		els.settingsServers.appendChild(empty);
	}
}

/** Switches the answering model, and remembers it for next time. */
function chooseModel(provider, model) {
	ai.provider = provider;
	ai.model = model;
	rememberModelChoice(provider, model);
	paintModelLabel();
	renderSettings();
}

function openSettings() {
	renderSettings();
	els.settings.hidden = false;
}

els.settingsOpen.addEventListener('click', openSettings);
els.setupBanner.addEventListener('click', () => {
	openSettings();
	els.setup.scrollIntoView({ block: 'start' });
});
els.settingsClose.addEventListener('click', () => { els.settings.hidden = true; });
els.settings.addEventListener('click', e => {
	// Clicking the backdrop closes it; clicking the card does not.
	if (e.target === els.settings) {
		els.settings.hidden = true;
	}
});
window.addEventListener('keydown', e => {
	if (e.key === 'Escape' && !els.settings.hidden) {
		els.settings.hidden = true;
	}
});
/** One row of the checklist. */
function step(done, title, note, actions = []) {
	const li = document.createElement('li');
	li.className = 'step';

	const mark = document.createElement('span');
	mark.className = `step-mark ${done ? 'ok' : 'todo'}`;
	mark.textContent = done ? '✓' : '○';

	const body = document.createElement('div');
	body.className = 'step-body';

	const t = document.createElement('div');
	t.className = 'step-title';
	t.textContent = title;
	body.appendChild(t);

	if (note) {
		const n = document.createElement('div');
		n.className = 'step-note';
		n.textContent = note;
		body.appendChild(n);
	}

	if (actions.length) {
		const row = document.createElement('div');
		row.className = 'step-actions';
		for (const a of actions) {
			row.appendChild(a);
		}
		body.appendChild(row);
	}

	li.append(mark, body);
	return li;
}

function button(label, onClick, cls = 'ghost small') {
	const b = document.createElement('button');
	b.className = cls;
	b.textContent = label;
	b.addEventListener('click', onClick);
	return b;
}

function renderSetup(state) {
	els.setupSteps.textContent = '';

	// 1. Python. We cannot install this for you - it needs a real installer and,
	//    on Windows, a PATH tick box that only the installer can set.
	if (state.python.ok) {
		els.setupSteps.appendChild(step(true, `Python ${state.python.version}`, `Using: ${state.python.cmd} ${state.python.args.join(' ')}`.trim()));
	} else {
		const help = pythonHelp(state.platform);
		els.setupSteps.appendChild(step(false, 'Python 3 not found', help.text, [
			button('Open python.org', () => window.studio.openUrl(help.url)),
			button('Re-check', refreshSetup),
		]));
	}

	// 2. The model servers. Only the one holding your model is started at
	//    launch; this offers to start whatever else is installed.
	const running = (state.servers ?? []).map(s => s.provider);
	const installed = [
		state.ollamaPath ? 'ollama' : undefined,
		state.lmsPath ? 'lmstudio' : undefined,
	].filter(Boolean);
	const stopped = installed.filter(p => !running.includes(p));
	const names = list => list.map(p => PROVIDERS[p].label).join(' and ');

	if (running.length && !stopped.length) {
		const counts = (state.servers ?? [])
			.map(s => `${PROVIDERS[s.provider].label}: ${s.models.length}`)
			.join('   ');
		els.setupSteps.appendChild(step(true,
			`${names(running)} ${running.length > 1 ? 'are' : 'is'} running`, counts));
	} else if (installed.length) {
		const start = button(startingServers ? 'Starting…' : 'Start models', async () => {
			// The guard cannot live on the button: renderSetup() empties the list
			// and builds a new, enabled one on every refresh - including the
			// refresh this click is about to cause.
			if (startingServers) {
				return;
			}
			startingServers = true;
			start.disabled = true;
			start.textContent = 'Starting…';

			try {
				const res = await window.studio.startServers();
				if (!res.ok) {
					start.textContent = res.error ?? 'Could not start';
					start.disabled = false;
					return;
				}
				const up = await waitForProviders(res.starting ?? installed);
				if (!up.length) {
					// Re-rendering an identical checklist looks exactly like the
					// click did nothing, which is what earns a second press.
					start.textContent = 'Started, but not answering yet — try again';
					start.disabled = false;
					return;
				}
			} catch (err) {
				// Without this the button sits on "Starting..." for ever and the
				// reason goes to an unhandled rejection nobody reads.
				start.textContent = `Could not start: ${err.message}`;
				start.disabled = false;
				return;
			} finally {
				startingServers = false;
			}

			await refreshSetup();
		});
		start.disabled = startingServers;

		const title = running.length
			? `${names(running)} running, ${names(stopped)} not started`
			: `${names(stopped)} installed but not running`;
		els.setupSteps.appendChild(step(false, title,
			'Ollama serves on port 11434, LM Studio on 1234. myIDE stops again whatever it started here when you close it, and leaves anything that was already running alone.',
			[start]));
	} else {
		els.setupSteps.appendChild(step(false, 'No model server',
			'Ollama is the simplest option: install it, then come back and press Re-check. LM Studio also works.',
			[
				button('Get Ollama', () => window.studio.openUrl('https://ollama.com/download')),
				button('Get LM Studio', () => window.studio.openUrl('https://lmstudio.ai/download')),
				button('Re-check', refreshSetup),
			]));
	}

	// 3. A model. Downloading is only offered for Ollama, which has an API for
	//    it; LM Studio downloads happen in its own window.
	const total = (state.servers ?? []).reduce((n, s) => n + s.models.length, 0);
	const ollamaEmpty = (state.servers ?? []).some(s => s.provider === 'ollama' && !s.models.length);
	if (total) {
		const across = (state.servers ?? [])
			.filter(s => s.models.length)
			.map(s => `${PROVIDERS[s.provider].label}: ${s.models.slice(0, 2).join(', ')}`)
			.join('   ');
		els.setupSteps.appendChild(step(true,
			`${total} model${total === 1 ? '' : 's'} available`, across));
	} else if (ollamaEmpty) {
		const bar = document.createElement('div');
		bar.className = 'bar-track';
		bar.hidden = true;
		const fill = document.createElement('div');
		fill.className = 'bar-fill';
		bar.appendChild(fill);

		const status = document.createElement('div');
		status.className = 'step-note';
		status.hidden = true;

		const buttons = SUGGESTED.map(m => button(`${m.label} · ${m.size}`, async () => {
			for (const b of buttons) {
				b.disabled = true;
			}
			bar.hidden = false;
			status.hidden = false;
			status.textContent = 'Starting download…';
			try {
				await pullModel(m.id, p => {
					const pct = p.total ? Math.round((p.completed / p.total) * 100) : 0;
					fill.style.width = `${pct}%`;
					status.textContent = p.total
						? `${p.status} — ${formatBytes(p.completed)} of ${formatBytes(p.total)} (${pct}%)`
						: p.status;
				});
				status.textContent = 'Done.';
				await refreshSetup();
			} catch (err) {
				status.textContent = err.message;
				for (const b of buttons) {
					b.disabled = false;
				}
			}
		}));

		const li = step(false, 'No model downloaded yet',
			SUGGESTED.map(m => `${m.label}: ${m.note}`).join('  '), buttons);
		li.querySelector('.step-body').append(bar, status);
		els.setupSteps.appendChild(li);
	} else if (state.provider) {
		els.setupSteps.appendChild(step(false, 'No models loaded',
			`Load one in ${PROVIDERS[state.provider].label}, then press Re-check.`, [button('Re-check', refreshSetup)]));
	}
}

els.setupRecheck.addEventListener('click', refreshSetup);

// --- expected output ----------------------------------------------------------
// A crash is the easy case. Most DSA bugs are wrong answers, and that is the
// loop that otherwise ends up pasted into a cloud chat over and over.

/** Trailing spaces and a missing final newline are not real differences. */
function normalise(text) {
	return String(text ?? '')
		.replace(/\r\n/g, '\n')
		.split('\n')
		.map(l => l.replace(/\s+$/, ''))
		.join('\n')
		.trim();
}

/**
 * A collapsible box that remembers what was typed in it.
 *
 * There are two: the problem being solved, and the output it should produce.
 * Both are things you paste once and then run against twenty times, so losing
 * either on restart would make them not worth filling in. Both start open when
 * there is something in them, because a box you cannot see is a box you forget
 * is set - and a stale expected output turns every correct run red.
 */
function rememberBox(box, toggle, key) {
	const setOpen = open => {
		box.hidden = !open;
		toggle.setAttribute('aria-expanded', String(open));
	};

	try {
		box.value = localStorage.getItem(key) ?? '';
	} catch {
		/* storage disabled; the box simply starts empty */
	}
	setOpen(Boolean(box.value));

	toggle.addEventListener('click', () => {
		setOpen(box.hidden);
		if (!box.hidden) {
			box.focus();
		}
	});

	box.addEventListener('input', () => {
		try {
			localStorage.setItem(key, box.value);
		} catch {
			/* not worth failing a keystroke over */
		}
	});
}

function showDiff(expected, got) {
	els.diffCard.hidden = false;
	els.card.hidden = true;
	els.values.hidden = true;
	els.okCard.hidden = true;
	els.diffWant.textContent = expected || '(nothing)';
	els.diffGot.textContent = got || '(nothing)';
	els.diffExplain.innerHTML = '';
	els.diffMeta.textContent = '';
}

els.diffAsk.addEventListener('click', () => explain(undefined, 'diff'));

// --- follow-up questions -------------------------------------------------------
// The first answer arrives on its own; everything after it is asked. This is not
// a chat transcript - it is a stack of question-and-answer notes, and each one
// knows which part of the code it was about.

/**
 * The last few exchanges, so "why?" and "what about the second loop?" work.
 * Kept short on purpose: a 1.5B model has little context to spare, and old
 * turns crowd out the code.
 */
const history = [];
const HISTORY_TURNS = 3;

/**
 * Everything older than the window, folded into a few lines.
 *
 * Turns past the window used to be dropped, so a question about something
 * worked out ten turns ago had nothing behind it. They are summarised instead,
 * by the smallest model on the server already running - this is bookkeeping,
 * not teaching, and it should not cost twenty seconds or a second server.
 *
 * What it summarises is only ever the CONVERSATION. The code, the traceback,
 * the recorded values and the trace are facts the app holds exactly and sends
 * in full on every request; replacing any of those with a small model's
 * paraphrase is how a hallucination gets manufactured.
 */
let historySummary = '';
let summarising = false;

/** The summary as a message, or nothing when there is no history behind us. */
function summaryMessages() {
	return historySummary
		? [{ role: 'system', content: `EARLIER IN THIS CONVERSATION, in note form:\n${historySummary}` }]
		: [];
}

/**
 * Folds the turns that have fallen out of the window into the summary.
 *
 * Runs after an answer, never in front of one: the reader is not kept waiting
 * for bookkeeping. If it fails the raw turns stay where they are - an
 * uncompressed history is only wasteful, whereas a dropped one loses the
 * thread.
 */
async function compressHistory() {
	const excess = history.length - HISTORY_TURNS * 2;
	if (summarising || excess <= 0 || !ai.provider) {
		return;
	}

	const older = history.slice(0, excess);
	summarising = true;

	try {
		// The smallest model on the server we are already talking to. Starting
		// the other one to save a few tokens would be a poor trade.
		const server = (setupState?.servers ?? []).find(s => s.provider === ai.provider);
		const model = pickSmallestModel(server?.models ?? [], server?.sizes ?? {}) ?? ai.model;

		const text = await chat({
			provider: ai.provider,
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT_SUMMARY },
				{ role: 'user', content: buildSummaryPrompt(historySummary, older) },
			],
		}, () => { });

		const clean = stripReasoning(text).trim();
		if (clean) {
			historySummary = clean.slice(0, 1200);
			history.splice(0, excess);
			saveThread();
		}
	} catch {
		/* keep the raw turns; they are still sent, just not compressed */
	} finally {
		summarising = false;
	}
}

/** What is selected right now, in the editor or in an answer. */
let selection = '';

function setSelection(text) {
	selection = (text ?? '').trim();
	els.selChip.hidden = !selection;
	// One line in the chip; the model still gets the whole thing.
	els.selText.textContent = selection.replace(/\s+/g, ' ').slice(0, 120);
}

els.selClear.addEventListener('click', () => setSelection(''));

/**
 * Selecting code is the natural way to say "this bit". Watched on the editor,
 * and on the panel so an answer can be quoted back into a follow-up.
 */
function watchSelections() {
	editor.onDidChangeCursorSelection(e => {
		const picked = editor.getModel().getValueInRange(e.selection);
		if (picked.trim()) {
			setSelection(picked);
		}
	});

	document.addEventListener('selectionchange', () => {
		const sel = document.getSelection();
		if (!sel || sel.isCollapsed) {
			return;
		}
		// Only text inside the answer panel; ignore the editor's own DOM, which
		// the Monaco listener above already handles.
		const node = sel.anchorNode;
		const host = node?.nodeType === 1 ? node : node?.parentElement;
		if (host?.closest('.side-top') && !host.closest('#editor')) {
			setSelection(sel.toString());
		}
	});
}

/*
 * The thread survives a restart.
 *
 * Losing it on close was the thing that made the panel feel disposable: you
 * work out why the loop is wrong on Monday, close the window, and on Tuesday
 * the reasoning is gone while the code that prompted it is still there. Only
 * the text is kept - the answers are re-rendered through the same escaping
 * markdown path they arrived through, never stored as HTML.
 */
const THREAD_KEY = 'thread';
const THREAD_MAX = 20;

/** The turns as data, so they can be written out without reading the DOM back. */
const turns = [];

function saveThread() {
	try {
		localStorage.setItem(THREAD_KEY, JSON.stringify({
			summary: historySummary,
			turns: turns.slice(-THREAD_MAX),
		}));
	} catch {
		/* a long thread in a full store; the questions still work */
	}
}

function restoreThread() {
	let stored;
	try {
		stored = JSON.parse(localStorage.getItem(THREAD_KEY) ?? 'null');
	} catch {
		return;
	}

	// Threads written before the summary existed are a bare array.
	const saved = Array.isArray(stored) ? stored : stored?.turns;
	if (!Array.isArray(saved)) {
		return;
	}
	if (typeof stored?.summary === 'string') {
		historySummary = stored.summary;
	}

	for (const turn of saved.slice(-THREAD_MAX)) {
		if (typeof turn?.q !== 'string' || typeof turn?.a !== 'string') {
			continue;
		}
		turns.push(turn);
		const { answer, meta } = addTurn(turn.q, turn.scope);
		answer.innerHTML = render(turn.a);
		meta.textContent = turn.meta ?? '';
		// So a bare "why?" after a restart still has a subject.
		history.push({ role: 'user', content: turn.q }, { role: 'assistant', content: turn.a });
	}
	history.splice(0, Math.max(0, history.length - HISTORY_TURNS * 2));
}

/** One question and its answer, appended to the stack. */
function addTurn(question, scope) {
	const qa = document.createElement('div');
	qa.className = 'qa';

	const q = document.createElement('div');
	q.className = 'qa-q';
	q.textContent = question;

	if (scope) {
		const s = document.createElement('span');
		s.className = 'qa-scope';
		s.textContent = `about: ${scope.replace(/\s+/g, ' ').slice(0, 90)}`;
		q.appendChild(s);
	}

	const a = document.createElement('div');
	a.className = 'explain';
	a.innerHTML = '<span class="caret"></span>';

	const meta = document.createElement('div');
	meta.className = 'qa-meta';

	qa.append(q, a, meta);
	els.thread.appendChild(qa);
	qa.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	return { answer: a, meta };
}

function setAskEnabled(on) {
	for (const b of [els.askSend, els.askComplexity, els.askOptimise]) {
		b.disabled = !on;
	}
}

/**
 * Answers a follow-up. `mode` picks the system prompt; the question text is
 * what appears above the answer.
 */
async function ask(question, mode = 'ask') {
	if (!ai.provider || !editor) {
		return;
	}

	const scope = selection;
	const { answer, meta } = addTurn(question, scope);
	setAskEnabled(false);
	aiAbort?.abort();
	aiAbort = new AbortController();

	const system = mode === 'complexity' ? SYSTEM_PROMPT_COMPLEXITY
		: mode === 'optimise' ? SYSTEM_PROMPT_OPTIMISE
			: SYSTEM_PROMPT_ASK;

	const started = Date.now();
	let text = '';

	try {
		await chat({
			provider: ai.provider,
			model: ai.model,
			signal: aiAbort.signal,
			messages: [
				{ role: 'system', content: system },
				// Everything before the window, in note form.
				...summaryMessages(),
				// Earlier turns, so a bare "why?" still has a subject.
				...history.slice(-HISTORY_TURNS * 2),
				{
					role: 'user',
					content: buildAskPrompt({
						code: editor.getValue(),
						selection: scope,
						question,
						parsed: lastRun?.parsed,
						expected: lastRun?.expected,
						stdout: lastRun?.stdout,
						values: lastRun?.values,
						trace: lastRun?.trace,
						problem: els.problem.value,
					}),
				},
			],
		}, token => {
			text += token;
			answer.innerHTML = render(stripReasoning(text)) + '<span class="caret"></span>';
		});

		const clean = stripReasoning(text);
		answer.innerHTML = render(clean);
		meta.textContent = `${ai.model} · ${((Date.now() - started) / 1000).toFixed(1)}s`;

		history.push({ role: 'user', content: question }, { role: 'assistant', content: clean });
		turns.push({ q: question, scope, a: clean, meta: meta.textContent });
		saveThread();

		// Deliberately not awaited: the answer is already rendered, and folding
		// the turns that just fell out of the window is nobody's business but
		// the next question's.
		compressHistory();
		return clean;
	} catch (err) {
		if (err.name === 'AbortError') {
			answer.innerHTML = '<p>Cancelled.</p>';
		} else {
			answer.innerHTML = `<p style="color:var(--bad)">${escapeHtml(err.message)}</p>`;
		}
	} finally {
		setAskEnabled(true);
	}
}

function submitAsk() {
	const q = els.askInput.value.trim();
	if (!q) {
		return;
	}
	els.askInput.value = '';
	ask(q);
}

els.askSend.addEventListener('click', submitAsk);
els.askInput.addEventListener('keydown', e => {
	if (e.key === 'Enter') {
		e.preventDefault();
		submitAsk();
	}
});

els.askComplexity.addEventListener('click', () => ask(
	selection ? 'What is the time and space complexity of this part?' : 'What is the time and space complexity?',
	'complexity'));

els.askOptimise.addEventListener('click', () => ask(
	selection ? 'Can this part be made faster?' : 'Can this be made faster or use less memory?',
	'optimise'));

els.threadClear.addEventListener('click', () => {
	els.thread.textContent = '';
	history.length = 0;
	turns.length = 0;
	historySummary = '';
	saveThread();
});

/**
 * Shows what the variables held when the run failed.
 *
 * The reader gets the same facts the model does. Often that is the whole
 * explanation: `u = 9` beside a list of length 3 needs no prose.
 */
function showValues(values) {
	els.valuesRows.textContent = '';
	const entries = values?.locals ? Object.entries(values.locals) : [];
	els.values.hidden = entries.length === 0;

	for (const [name, repr] of entries) {
		els.valuesRows.appendChild(valueRow(name, repr));
	}
}

/** One name-and-value row, shared by the crash panel and the step-through. */
function valueRow(name, repr, changed = false) {
	const tr = document.createElement('tr');
	if (changed) {
		tr.className = 'changed';
	}
	const n = document.createElement('td');
	n.className = 'vname';
	n.textContent = name;
	const v = document.createElement('td');
	v.className = 'vval';
	v.textContent = repr;
	tr.append(n, v);
	return tr;
}

// --- stepping through the run ---------------------------------------------------
// The traceback says where it stopped. This says how it got there - and for a
// run that printed the wrong answer without crashing, it is the only account of
// what happened at all.

/**
 * Anchors for the recorded lines, so a step still points at its own code after
 * the file has been edited.
 *
 * A step remembers the line number it happened on, and a line number stops
 * being true the moment anything above it is added or removed - so stepping
 * after an edit marked whatever had since moved into that position, with no
 * sign that it was the wrong line. Monaco moves a decoration with the text it
 * covers, so one invisible decoration per recorded line turns a number that
 * rots into a reference that does not.
 */
let traceAnchors;
let traceAnchorOf;

function anchorTrace(steps) {
	traceAnchors?.clear();
	traceAnchorOf = new Map();
	if (!editor || !steps.length) {
		return;
	}

	const lineCount = editor.getModel().getLineCount();
	const lines = [...new Set(steps.map(step => step.line))]
		.filter(line => line >= 1 && line <= lineCount)
		.sort((a, b) => a - b);

	traceAnchors = editor.createDecorationsCollection(lines.map(line => ({
		range: new monaco.Range(line, 1, line, 1),
		// No class and no glyph: this draws nothing. It exists only to be
		// carried along by the edits that follow.
		options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
	})));

	lines.forEach((line, index) => traceAnchorOf.set(line, index));
}

/** Where a recorded line has ended up, after whatever editing has happened. */
function livingLine(recorded) {
	const index = traceAnchorOf?.get(recorded);
	if (index === undefined || !traceAnchors) {
		return recorded;
	}
	return traceAnchors.getRange(index)?.startLineNumber ?? recorded;
}

/** The steps of the last run, and where the scrubber is in them. */
let traceSteps = [];
let traceAt = 0;
/** The whole recording, for the things that are about it rather than in it. */
let lastTrace;

function showTrace(trace) {
	lastTrace = trace;
	traceSteps = trace?.steps ?? [];
	anchorTrace(traceSteps);
	traceAt = 0;
	traceDecorations.clear();

	els.traceCard.hidden = traceSteps.length === 0;
	if (!traceSteps.length) {
		return;
	}

	const dropped = trace.dropped ?? 0;
	els.traceCount.textContent = dropped
		? `${traceSteps.length} of ${traceSteps.length + dropped} steps`
		: `${traceSteps.length} step${traceSteps.length === 1 ? '' : 's'}`;

	// Both of these change what the last step means, so neither is a detail.
	// Truncated: the program carried on past the recording. Dropped: it did
	// reach its end, but the middle is missing.
	els.traceNote.hidden = !trace.truncated && !dropped;
	els.traceNote.textContent = trace.truncated
		? 'Recording stopped early to keep the run fast, so the program carried on past the last step here.'
		: dropped
			? `The opening and the ending are recorded exactly; ${dropped} steps in the middle were dropped.`
			: '';

	els.traceScrub.max = String(traceSteps.length - 1);
	els.traceScrub.value = '0';
	// Without reveal: this runs on every Run, and scrolling the editor to the
	// first traced line each time would fight whoever is reading line 40.
	setStep(0, false);
}

/**
 * Everything in scope at a step, rebuilt by replaying the changes up to it.
 *
 * The harness records only what changed on each line, which is what keeps three
 * hundred steps small enough to hold and to send. Replaying forward turns that
 * back into "here is what is in scope now". It has to be done per frame, keyed
 * by name and depth: a recursive call would otherwise show its parent's values,
 * and a second call to the same function would inherit the first one's.
 */
function stateAt(index) {
	const frames = new Map();

	for (let i = 0; i <= index; i++) {
		const step = traceSteps[i];
		const key = `${step.fn}#${step.d}`;

		let vars = frames.get(key);
		if (!vars) {
			vars = new Map();
			frames.set(key, vars);
		}
		for (const [name, value] of Object.entries(step.vars ?? {})) {
			vars.set(name, value);
		}
		// The frame closed. Its names are gone, unless this is the step being
		// shown - in which case they are what the reader asked to look at.
		if (step.r && i < index) {
			frames.delete(key);
		}
	}

	const at = traceSteps[index];
	return frames.get(`${at.fn}#${at.d}`) ?? new Map();
}

function setStep(index, reveal = true) {
	if (!traceSteps.length) {
		return;
	}
	traceAt = Math.min(traceSteps.length - 1, Math.max(0, index));
	const step = traceSteps[traceAt];
	els.traceScrub.value = String(traceAt);
	els.tracePrev.disabled = traceAt === 0;
	els.traceNext.disabled = traceAt === traceSteps.length - 1;

	const where = step.fn === '<module>' ? 'the file itself' : `${step.fn}()`;
	if (step.ret !== undefined) {
		els.traceWhere.textContent = `${traceAt + 1}/${traceSteps.length} · line ${step.line} — ${where} returned ${step.ret}`;
	} else if (step.r) {
		els.traceWhere.textContent = `${traceAt + 1}/${traceSteps.length} · line ${step.line} — ${where} ended`;
	} else if (step.exc) {
		els.traceWhere.textContent = `${traceAt + 1}/${traceSteps.length} · line ${step.line} — raised ${step.exc}`;
	} else {
		// A line event fires before the line runs, so this is about to happen,
		// not just happened. Saying so is the difference between the panel
		// making sense and being off by one.
		els.traceWhere.textContent = `${traceAt + 1}/${traceSteps.length} · about to run line ${step.line} in ${where}`;
	}

	// Landing on the first step after the gap without being told would read as
	// one continuous run that skipped from the second pass to the last.
	if (lastTrace?.dropped && traceAt === lastTrace.gapAt) {
		els.traceWhere.textContent += `  · ${lastTrace.dropped} steps before this were not recorded`;
	}

	els.traceVars.textContent = '';
	const changed = new Set(Object.keys(step.vars ?? {}));
	for (const [name, value] of stateAt(traceAt)) {
		els.traceVars.appendChild(valueRow(name, value, changed.has(name)));
	}

	markStep(livingLine(step.line), reveal);
}

/** Puts the step on the code, the way an error is put on the code. */
function markStep(line, reveal = true) {
	traceDecorations.clear();
	// Nothing is marked while the section is closed: the highlight and the
	// scroll it causes would come from a panel the reader cannot see.
	if (!editor || els.traceBody.hidden) {
		return;
	}
	// The buffer may have been edited since the run, and Monaco throws on a
	// line it does not have - which would leave the panel half drawn.
	const lineCount = editor.getModel().getLineCount();
	if (!(line >= 1 && line <= lineCount)) {
		return;
	}

	traceDecorations.set([{
		range: new monaco.Range(line, 1, line, 1),
		options: {
			isWholeLine: true,
			className: 'trace-row',
			glyphMarginClassName: 'trace-glyph',
		},
	}]);
	if (reveal) {
		editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
	}
}

els.traceScrub.addEventListener('input', () => setStep(Number(els.traceScrub.value)));
els.tracePrev.addEventListener('click', () => setStep(traceAt - 1));
els.traceNext.addEventListener('click', () => setStep(traceAt + 1));

els.traceToggle.addEventListener('click', () => {
	const open = els.traceBody.hidden;
	els.traceBody.hidden = !open;
	els.traceToggle.setAttribute('aria-expanded', String(open));
	try {
		localStorage.setItem('traceOpen', open ? '1' : '');
	} catch {
		/* the section just will not remember being open */
	}
	if (open) {
		setStep(traceAt);
	} else {
		traceDecorations.clear();
	}
});

try {
	if (localStorage.getItem('traceOpen')) {
		els.traceBody.hidden = false;
		els.traceToggle.setAttribute('aria-expanded', 'true');
	}
} catch {
	/* start collapsed */
}

// Alt+arrow steps, so a walk through a loop does not mean going back to the
// mouse between every step. Alt, because the editor owns the bare arrows.
window.addEventListener('keydown', e => {
	if (!e.altKey || els.traceCard.hidden || els.traceBody.hidden) {
		return;
	}
	if (e.key === 'ArrowLeft') {
		e.preventDefault();
		setStep(traceAt - 1);
	} else if (e.key === 'ArrowRight') {
		e.preventDefault();
		setStep(traceAt + 1);
	}
});
