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
	PROVIDERS, listModels, pickDefaultModel, buildPrompt, chat, stripReasoning,
	SYSTEM_PROMPT, SYSTEM_PROMPT_REVEAL, SYSTEM_PROMPT_ASK,
	SYSTEM_PROMPT_COMPLEXITY, SYSTEM_PROMPT_OPTIMISE, buildAskPrompt,
} from './ai.js';
import { Voice } from './voice.js';
import { render, escapeHtml } from './markdown.js';
import { probe, isReady, pullModel, waitForProvider, SUGGESTED, pythonHelp, formatBytes } from './setup.js';

/** Blank, deliberately. The empty-state hint carries the guidance instead. */
const STARTER = '';

const $ = id => document.getElementById(id);

const els = {
	run: $('run'), stop: $('stop'), status: $('status'), model: $('model'), mic: $('mic'),
	out: $('out'), card: $('card'), okCard: $('ok-card'), okMeta: $('ok-meta'),
	errType: $('err-type'), errHint: $('err-hint'), errLine: $('err-line'),
	explain: $('explain'), ask: $('ask'), aiMeta: $('ai-meta'), jump: $('jump'),
	overlay: $('voice-overlay'), wave: $('wave'), voiceState: $('voice-state'),
	empty: $('empty'), okOut: $('ok-out'),
	splitter: $('splitter'), outEmpty: $('out-empty'),
	setup: $('setup'), setupSteps: $('setup-steps'), setupRecheck: $('setup-recheck'),
	diffCard: $('diff-card'), diffWant: $('diff-want'), diffGot: $('diff-got'),
	diffExplain: $('diff-explain'), diffAsk: $('diff-ask'), diffMeta: $('diff-meta'),
	expect: $('expect'), expectToggle: $('expect-toggle'),
	reveal: $('reveal'), diffReveal: $('diff-reveal'),
	thread: $('thread'), askInput: $('ask-input'), askSend: $('ask-send'),
	askComplexity: $('ask-complexity'), askOptimise: $('ask-optimise'),
	threadClear: $('thread-clear'), selChip: $('sel-chip'), selText: $('sel-text'),
	selClear: $('sel-clear'),
	values: $('values'), valuesRows: $('values-rows'),
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
	await refreshSetup();
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

	// A missing interpreter is a setup problem, not a bug in the program. Show
	// the checklist rather than an error that cannot be acted on.
	if (result.stderr === 'no-python') {
		els.status.textContent = '';
		els.out.textContent = '';
		els.outEmpty.hidden = false;
		await refreshSetup();
		els.setup.hidden = false;
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

// --- voice --------------------------------------------------------------------

const LABELS = {
	listening: 'Listening — release to send',
	transcribing: 'Transcribing…',
	thinking: 'Thinking…',
	speaking: 'Speaking…',
};

const voice = new Voice(els.wave, (state, detail) => {
	if (state === 'idle') {
		els.overlay.hidden = true;
		els.mic.classList.remove('live');
		return;
	}
	els.overlay.hidden = false;
	els.mic.classList.toggle('live', state === 'listening');
	els.voiceState.textContent = detail ?? LABELS[state] ?? state;
});

let micHeld = false;

async function micDown() {
	if (micHeld) {
		return;
	}
	micHeld = true;
	try {
		await voice.start();
	} catch (err) {
		micHeld = false;
		els.voiceState.textContent = err.message;
	}
}

async function micUp() {
	if (!micHeld) {
		return;
	}
	micHeld = false;
	try {
		const said = await voice.stop();
		if (!said) {
			return;
		}
		voice.setState('thinking', `“${said}”`);
		els.overlay.hidden = false;
		const answer = await explain(said);
		els.overlay.hidden = true;
		if (answer) {
			voice.speak(stripReasoning(answer).split('\n')[0]);
		}
	} catch (err) {
		els.voiceState.textContent = err.message;
		setTimeout(() => { els.overlay.hidden = true; }, 2500);
	}
}

els.mic.addEventListener('mousedown', micDown);
els.mic.addEventListener('mouseup', micUp);
els.mic.addEventListener('mouseleave', () => micHeld && micUp());

window.addEventListener('keydown', e => {
	if (e.ctrlKey && e.altKey && e.code === 'KeyV' && !e.repeat) {
		e.preventDefault();
		micDown();
	}
});

window.addEventListener('keyup', e => {
	if (e.code === 'KeyV' || !e.ctrlKey || !e.altKey) {
		if (micHeld) {
			micUp();
		}
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

async function refreshSetup() {
	setupState = await probe();

	if (setupState.provider && setupState.models.length) {
		ai.provider = setupState.provider;
		// A remembered choice beats the default, but only while it is still
		// installed - a model can be deleted between sessions.
		const remembered = readSetting('model');
		ai.model = setupState.models.includes(remembered)
			? remembered
			: pickDefaultModel(setupState.models, setupState.sizes);
		paintModels(setupState.models);
		els.ask.disabled = false;
		els.diffAsk.disabled = false;
		els.reveal.disabled = false;
		els.diffReveal.disabled = false;
		setAskEnabled(true);
	} else {
		ai.provider = undefined;
		paintModels([]);
		els.ask.disabled = true;
		els.diffAsk.disabled = true;
		els.reveal.disabled = true;
		els.diffReveal.disabled = true;
		setAskEnabled(false);
	}

	renderSetup(setupState);
	els.setup.hidden = isReady(setupState);
}

function readSetting(key) {
	try {
		return localStorage.getItem(key) ?? '';
	} catch {
		return '';
	}
}

/**
 * Fills the model picker.
 *
 * Which model answers is worth changing without leaving the window: the same
 * question costs three seconds on a 1.5B and twenty on a 7B, and which of those
 * is the right trade changes with how stuck you are.
 */
function paintModels(models) {
	els.model.textContent = '';

	if (!models.length) {
		const none = document.createElement('option');
		none.textContent = 'no model yet';
		els.model.appendChild(none);
		els.model.disabled = true;
		return;
	}

	for (const name of models) {
		const option = document.createElement('option');
		option.value = name;
		option.textContent = name;
		els.model.appendChild(option);
	}
	els.model.disabled = false;
	els.model.value = ai.model;
	els.model.title = `${PROVIDERS[ai.provider].label} · ${ai.model}`;
}

els.model.addEventListener('change', () => {
	ai.model = els.model.value;
	els.model.title = `${PROVIDERS[ai.provider].label} · ${ai.model}`;
	try {
		localStorage.setItem('model', ai.model);
	} catch {
		/* the choice just will not survive a restart */
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

	// 2. A model server. Installed-but-not-running is the common case and the
	//    one we can fix here.
	if (state.provider) {
		els.setupSteps.appendChild(step(true, `${PROVIDERS[state.provider].label} is running`));
	} else if (state.ollamaPath) {
		const start = button('Start Ollama', async () => {
			start.disabled = true;
			start.textContent = 'Starting…';
			const res = await window.studio.startOllama();
			if (!res.ok) {
				start.textContent = res.error ?? 'Could not start';
				return;
			}
			await waitForProvider('ollama');
			await refreshSetup();
		});
		els.setupSteps.appendChild(step(false, 'Ollama is installed but not running',
			'It serves the model on port 11434. Starting it here leaves it running after myIDE closes.',
			[start]));
	} else {
		els.setupSteps.appendChild(step(false, 'No model server',
			'Ollama is the simplest option: install it, then come back and press Re-check. LM Studio on port 1234 also works.',
			[
				button('Get Ollama', () => window.studio.openUrl('https://ollama.com/download')),
				button('Re-check', refreshSetup),
			]));
	}

	// 3. A model. Only offered for Ollama, which has a download API; LM Studio
	//    downloads happen in its own window.
	if (state.provider && state.models.length) {
		els.setupSteps.appendChild(step(true, `${state.models.length} model${state.models.length === 1 ? '' : 's'} available`,
			state.models.slice(0, 3).join(', ')));
	} else if (state.provider === 'ollama') {
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
		localStorage.setItem(THREAD_KEY, JSON.stringify(turns.slice(-THREAD_MAX)));
	} catch {
		/* a long thread in a full store; the questions still work */
	}
}

function restoreThread() {
	let saved = [];
	try {
		saved = JSON.parse(localStorage.getItem(THREAD_KEY) ?? '[]');
	} catch {
		return;
	}
	if (!Array.isArray(saved)) {
		return;
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

/** The steps of the last run, and where the scrubber is in them. */
let traceSteps = [];
let traceAt = 0;

function showTrace(trace) {
	traceSteps = trace?.steps ?? [];
	traceAt = 0;
	traceDecorations.clear();

	els.traceCard.hidden = traceSteps.length === 0;
	if (!traceSteps.length) {
		return;
	}

	els.traceCount.textContent = trace.truncated
		? `first ${traceSteps.length} steps`
		: `${traceSteps.length} step${traceSteps.length === 1 ? '' : 's'}`;

	// Truncation is not a detail: the recording stops but the program does not,
	// so the last step shown is not where the run ended.
	els.traceNote.hidden = !trace.truncated;
	els.traceNote.textContent = trace.truncated
		? `Recording stopped after ${trace.limit} steps to keep the run fast. The program carried on past the last step here.`
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

	els.traceVars.textContent = '';
	const changed = new Set(Object.keys(step.vars ?? {}));
	for (const [name, value] of stateAt(traceAt)) {
		els.traceVars.appendChild(valueRow(name, value, changed.has(name)));
	}

	markStep(step.line, reveal);
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
