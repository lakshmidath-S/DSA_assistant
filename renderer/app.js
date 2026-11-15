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
	PROVIDERS, pickDefaultServer, buildTeaching, chat, stripReasoning,
	SYSTEM_PROMPT_ASK, SYSTEM_PROMPT_COMPLEXITY, SYSTEM_PROMPT_OPTIMISE, buildAskPrompt,
	warmModel, modelThinks,
} from './ai.js';
import { Voice } from './voice.js';
import { render, escapeHtml } from './markdown.js';
import { probe, isReady, pullModel, waitForProviders, SUGGESTED, pythonHelp, formatBytes } from './setup.js';
import {
	planRun, judge, anyOrderIn, argumentsOf, differenceOf, designSteps, designFact, callOf,
} from './cases.js';

/** Blank, deliberately. The empty-state hint carries the guidance instead. */
const STARTER = '';

const $ = id => document.getElementById(id);

const els = {
	run: $('run'), stop: $('stop'), status: $('status'), mic: $('mic'),
	out: $('out'), card: $('card'), okCard: $('ok-card'), okMeta: $('ok-meta'), okTitle: $('ok-title'),
	okFoot: $('ok-foot'), okAct: $('ok-act'),
	errType: $('err-type'), errMsg: $('err-msg'), errHint: $('err-hint'), errWhere: $('err-where'),
	explain: $('explain'), ask: $('ask'), aiMeta: $('ai-meta'),
	overlay: $('voice-overlay'), wave: $('wave'), voiceState: $('voice-state'),
	empty: $('empty'),
	splitter: $('splitter'), hsplit: $('hsplit'), outEmpty: $('out-empty'),
	tabs: [...document.querySelectorAll('.tabs [role="tab"]')],
	setup: $('setup'), setupSteps: $('setup-steps'), setupRecheck: $('setup-recheck'),
	setupBanner: $('setup-banner'), setupBannerNote: $('setup-banner-note'),
	diffCard: $('diff-card'), diffWant: $('diff-want'), diffGot: $('diff-got'),
	diffExplain: $('diff-explain'), diffAsk: $('diff-ask'), diffMeta: $('diff-meta'),
	expect: $('expect'), input: $('input'), returns: $('returns'),
	diffCase: $('diff-case'), diffFact: $('diff-fact'), valuesHead: $('values-head'),
	reveal: $('reveal'), diffReveal: $('diff-reveal'),
	thread: $('thread'), askInput: $('ask-input'), askSend: $('ask-send'),
	askComplexity: $('ask-complexity'), askOptimise: $('ask-optimise'),
	threadClear: $('thread-clear'), selChip: $('sel-chip'), selText: $('sel-text'),
	selClear: $('sel-clear'),
	values: $('values'), valuesRows: $('values-rows'),
	settingsOpen: $('settings-open'), settingsClose: $('settings-close'),
	settings: $('settings'), settingsServers: $('settings-servers'),
	modelLabel: $('model-label'),
	problem: $('problem'),
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
/** The explanation of the last run, while it arrives - a new run stops it. */
let explaining;
const ai = { provider: undefined, model: undefined, thinks: false };

// --- editor -------------------------------------------------------------------

window.monacoLoaded.then(async () => {
	const info = await window.studio.info();
	scratchPath = info.scratch;

	// The board the code is written on: the same slate and chalk as the rest
	// of the window (styles.css), so the editor is not a box set into the app.
	monaco.editor.defineTheme('studio', {
		base: 'vs-dark',
		inherit: true,
		rules: [
			{ token: '', foreground: 'e8ebe3' },
			{ token: 'comment', foreground: '7f8c85', fontStyle: 'italic' },
			{ token: 'keyword', foreground: '8cc8e8' },
			{ token: 'string', foreground: 'e9b97e' },
			{ token: 'string.escape', foreground: 'f0d264' },
			{ token: 'number', foreground: 'c9a6f0' },
			{ token: 'delimiter', foreground: 'aab4ad' },
			{ token: 'type', foreground: '94d8a8' },
			{ token: 'tag', foreground: 'f0d264' },
		],
		colors: {
			'editor.background': '#1a221f',
			'editor.foreground': '#e8ebe3',
			'editorGutter.background': '#1a221f',
			'editorLineNumber.foreground': '#46534d',
			'editorLineNumber.activeForeground': '#aab4ad',
			'editor.lineHighlightBackground': '#202a26',
			'editor.lineHighlightBorder': '#00000000',
			'editorCursor.foreground': '#f0d264',
			'editor.selectionBackground': '#f0d26438',
			'editor.inactiveSelectionBackground': '#f0d26420',
			'editorIndentGuide.background1': '#26302c',
			'editorIndentGuide.activeBackground1': '#3a4741',
			'editorWhitespace.foreground': '#2e3a35',
			'editorBracketMatch.background': '#f0d2641a',
			'editorBracketMatch.border': '#f0d26466',
			'editorBracketHighlight.foreground1': '#f0d264',
			'editorBracketHighlight.foreground2': '#c9a6f0',
			'editorBracketHighlight.foreground3': '#8cc8e8',
			'editorError.foreground': '#ff8f87',
			'editorOverviewRuler.border': '#00000000',
			'editorWidget.background': '#1f2824',
			'editorWidget.border': '#3a4741',
			'editorSuggestWidget.background': '#1f2824',
			'editorSuggestWidget.border': '#3a4741',
			'editorSuggestWidget.selectedBackground': '#2b3732',
			'editorHoverWidget.background': '#1f2824',
			'editorHoverWidget.border': '#3a4741',
			'scrollbarSlider.background': '#ffffff14',
			'scrollbarSlider.hoverBackground': '#ffffff22',
			'scrollbarSlider.activeBackground': '#ffffff2e',
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
	rememberText(els.problem, 'problem');
	rememberText(els.expect, 'expected');
	rememberText(els.input, 'input');
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
	discardStream();
	finishedRun = Math.max(finishedRun, result.run ?? 0);
	els.out.textContent = '';
	const out = (result.stdout ?? '').trim();
	const err = tidy(result.stderr ?? '').trim();

	if (out) {
		els.out.appendChild(document.createTextNode(err ? `${out}\n\n` : out));
	}
	if (err) {
		// A traceback's frames are the route to the error, and its last line is
		// the error: only that line is set in the error colour.
		const traceback = /^Traceback \(most recent call last\):/m.test(err);
		const cut = traceback ? err.lastIndexOf('\n') + 1 : 0;
		if (cut) {
			const route = document.createElement('span');
			route.className = 'stderr-route';
			route.textContent = err.slice(0, cut);
			els.out.appendChild(route);
		}
		const span = document.createElement('span');
		span.className = 'stderr';
		span.textContent = err.slice(cut);
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

/*
 * Output as it streams, drawn in batches.
 *
 * Python with -u writes every print() as its own chunk, and each used to become
 * its own span plus a scroll - which makes the browser lay the panel out again
 * per line. A loop printing 20,000 numbers finished in 0.7s and then froze the
 * window for minutes while the panel caught up. Now chunks are collected and
 * drawn at most every 50ms, and only the last STREAM_KEEP characters are kept
 * on screen while it runs; the finished run redraws the panel in full anyway.
 */
const STREAM_KEEP = 100_000;
let streamQueue = [];
let streamTimer;

/**
 * The newest run whose output has been drawn in full. A chunk can arrive after
 * its run's result, and drawing it then tripped the cap above and threw away
 * the complete output it landed on - 20,000 lines printed, the last 2,000 shown.
 */
let finishedRun = 0;

function flushStream() {
	streamTimer = undefined;
	if (!streamQueue.length) {
		return;
	}
	const frag = document.createDocumentFragment();
	let span;
	for (const { bucket, text } of streamQueue) {
		// Consecutive chunks from the same stream share a span.
		if (!span || span.dataset.bucket !== bucket) {
			span = document.createElement('span');
			span.dataset.bucket = bucket;
			if (bucket === 'err') {
				span.className = 'stderr';
			}
			frag.appendChild(span);
		}
		span.textContent += text;
	}
	streamQueue = [];
	els.out.appendChild(frag);
	while (els.out.textContent.length > STREAM_KEEP && els.out.childNodes.length > 1) {
		els.out.firstChild.remove();
	}
	els.out.scrollTop = els.out.scrollHeight;
}

/** Drops anything still waiting to be drawn: a new run, or the final redraw, replaces it. */
function discardStream() {
	clearTimeout(streamTimer);
	streamTimer = undefined;
	streamQueue = [];
}

window.studio.onRunData(({ bucket, text, run }) => {
	if (run <= finishedRun) {
		return;
	}
	streamQueue.push({ bucket, text });
	streamTimer ??= setTimeout(flushStream, 50);
});

/**
 * Which run is the latest. Ctrl+Enter does not wait for the Run button to come
 * back, so a second run can start while the first is still going - and the
 * first one's result, arriving after, used to be painted over the second's.
 */
let runSeq = 0;

async function run() {
	if (!editor) {
		return;
	}
	const mine = ++runSeq;
	explaining?.stop();
	// What it prints or returns is what is worth seeing next.
	selectTab('output');
	decorations.clear();
	traceDecorations.clear();
	discardStream();
	els.out.textContent = '';
	els.returns.textContent = '';
	els.returns.hidden = true;
	els.card.hidden = true;
	els.okCard.hidden = true;
	setOkAction();
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
	// A class Solution or a design class prints nothing: it is called on test
	// cases, and what it returns is the answer. The cases are worked out here,
	// where the boxes are; the Input box as typed goes along as well, as what a
	// script's input() reads. Which the file is, the harness decides.
	const plan = planRun({ input: els.input.value, expected: els.expect.value, problem: els.problem.value });
	const result = await window.studio.run(code, plan.input, els.input.value);
	if (mine !== runSeq) {
		// Replaced by a newer run; whatever it still streams is not wanted.
		finishedRun = Math.max(finishedRun, result.run ?? 0);
		return;
	}

	els.run.disabled = false;
	els.stop.hidden = true;
	els.status.textContent = result.stopped || result.loop
		? `Stopped after ${(result.ms / 1000).toFixed(1)}s`
		: `Ran in ${(result.ms / 1000).toFixed(1)}s`;

	lastRun = { ...result, code, plan };

	// Stopped on purpose: nothing went wrong, and nothing ran to the end to be
	// judged. What it printed so far is in Output; that is all there is to say.
	if (result.stopped) {
		paintOutput(result);
		return;
	}

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

	// What each test case returned, judged against what it should have, where
	// that is known. Listed whatever happens next: the cases that finished
	// before a crash or a stuck loop still have their answers.
	const sol = result.solution;
	lastRun.cases = sol?.cases
		? judge(sol.cases, plan?.expectations, { anyOrder: anyOrderIn(els.problem.value) })
		: [];
	showReturns(sol, lastRun.cases, result.loop);

	// A run that would not end has no traceback, only where it was stuck.
	if (result.loop) {
		showLoop(result.loop, code);
		return;
	}

	const parsed = parseTraceback(result.stderr, scratchPath || result.file);
	if (parsed) {
		showError(parsed, code);
		return;
	}

	if (sol) {
		showSolution(result, sol, lastRun.cases, plan);
		return;
	}

	// No crash. If an expected output was given, a mismatch is still a failure -
	// and it is the one this app exists for.
	const expected = normalise(els.expect.value);
	const got = normalise(result.stdout);
	if (expected && expected !== got) {
		lastRun.expected = expected;
		showDiff(expected, got);
		explain(undefined, 'diff');
		return;
	}

	showClean(result, Boolean(expected));
}

function showError(parsed, code) {
	els.card.hidden = false;
	els.okCard.hidden = true;
	// The name on its own as the headline - it is what gets searched for - and
	// Python's own message under it.
	els.errType.textContent = parsed.type;
	els.errMsg.textContent = parsed.message ?? '';
	els.errHint.textContent = hintFor(parsed, { input: els.input.value });

	// A traceback can name a line this buffer does not have - a frame from
	// another file, or a stale run against code that has since been edited down.
	// Monaco throws "Illegal value for lineNumber" on those, which kills the rest
	// of showError and leaves the panel half-drawn, so the error still gets
	// reported but nothing is marked.
	const line = inBuffer(parsed.primary?.line);
	if (line) {
		markLine(parsed, code.split('\n')[line - 1] ?? '');
		editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
	}
	// Raised inside a Solution: which test case it was given. And the function
	// is the nearest one the student named: "<genexpr>" is Python's word for
	// the expression on that line, not theirs.
	const failed = lastRun.solution?.failed;
	const at = designAt(failed);
	showWhere(els.errWhere, {
		line,
		fn: parsed.frames.filter(f => f.isUser && !f.func.startsWith('<')).pop()?.func,
		call: failed && !at ? callLabel(failed, lastRun.solution.method) : undefined,
		at,
	});

	lastRun.parsed = parsed;
	showValues(lastRun.values);

	// Arrives on its own. The old build made you ask, which is what made it feel
	// like a chat window rather than part of the editor. With no model it still
	// runs, and says in the card that nothing can answer yet.
	explain();
}

function showClean(result, matchedExpected) {
	els.okCard.hidden = false;
	els.card.hidden = true;
	els.values.hidden = true;
	els.diffCard.hidden = true;

	const printed = (result.stdout ?? '').trim();
	// A run that hit the time limit did not run cleanly; it did not finish.
	els.okCard.classList.remove('asking');
	els.okCard.classList.toggle('stalled', Boolean(result.timedOut));
	els.okTitle.textContent = result.timedOut ? 'Did not finish'
		: matchedExpected ? 'Matches' : 'Ran cleanly';
	// What it printed is in Output, under the code; saying it again here is
	// the kind of repetition that made this side crowded.
	if (result.timedOut) {
		els.okMeta.textContent = 'Stopped after 15 seconds. Is there a loop that never ends, or is it waiting for input()?';
	} else if (matchedExpected) {
		els.okMeta.textContent = 'What it printed is exactly what you expected.';
	} else if (printed) {
		els.okMeta.textContent = 'No errors. What it printed is in Output, under the code.';
	} else {
		els.okMeta.textContent = 'No errors, and it printed nothing.';
	}
}

// --- a LeetCode-style Solution ------------------------------------------------
// It prints nothing; it is called. The harness calls the method on each test
// case and reports what came back, and that is the output worth showing.

/** A case's arguments, or the bare call when the method takes none. A design case's label is already its calls. */
function callLabel(call, method) {
	if (lastRun?.solution?.kind === 'design') {
		return String(call ?? '');
	}
	return argumentsOf(call, method) || `${method}()`;
}

/** "top(), operation 4 of 4" - where the harness says a design case was - taken apart. */
function designAt(text) {
	const m = /^(.*), operation (\d+) of (\d+)$/.exec(String(text ?? ''));
	return m ? { call: m[1], n: Number(m[2]), total: Number(m[3]) } : undefined;
}

/** A line number this buffer has, or undefined. */
function inBuffer(line) {
	return line >= 1 && line <= editor.getModel().getLineCount() ? line : undefined;
}

/**
 * Where something happened, as one sentence on the card: "On line 4, in
 * maxProfit(), with prices = [7, 1, 5]." The line number is the way back to it
 * in the editor. Any part can be missing; with none, the sentence is hidden.
 */
function showWhere(el, { lead, line, fn, call, at, note }) {
	const code = text => {
		const c = document.createElement('code');
		c.textContent = text.length > 160 ? `${text.slice(0, 160)}…` : text;
		return c;
	};
	const parts = [];
	if (lead) {
		parts.push([lead]);
	}
	if (line) {
		const jump = document.createElement('button');
		jump.className = 'jump';
		jump.dataset.line = String(line);
		jump.title = 'Show this line in the editor';
		jump.textContent = `line ${line}`;
		parts.push([parts.length ? 'on ' : 'On ', jump]);
	}
	// "<module>", "<genexpr>", "<lambda>": Python's names, not the student's.
	// A design call already names its method, so "in top(), at top()" says it once.
	if (fn && !fn.startsWith('<') && !(at && at.call.startsWith(`${fn}(`))) {
		parts.push([parts.length ? 'in ' : 'In ', code(`${fn}()`)]);
	}
	if (call) {
		parts.push([parts.length ? 'with ' : 'With ', code(call)]);
	}
	// One call of a design case: "at top(), call 7 of 8".
	if (at) {
		parts.push([parts.length ? 'at ' : 'At ', code(at.call), `, call ${at.n} of ${at.total}`]);
	}

	el.textContent = '';
	parts.forEach((part, i) => el.append(...(i ? [', '] : []), ...part));
	if (parts.length) {
		el.append('.');
	}
	if (note) {
		el.append(`${parts.length ? ' ' : ''}${note}`);
	}
	el.hidden = !parts.length && !note;
}

/** Calls of one design case listed in Output before the rest are summed up in a line. */
const DESIGN_ROWS = 200;

/** The returned values in Output, one row per case, marked where they could be checked. */
function showReturns(sol, cases, loop) {
	els.returns.textContent = '';
	const row = (cls, ...cells) => {
		const li = document.createElement('li');
		if (cls) {
			li.className = cls;
		}
		for (const [name, text, title] of cells) {
			const span = document.createElement('span');
			span.className = name;
			span.textContent = text;
			if (title) {
				span.title = title;
			}
			li.appendChild(span);
		}
		els.returns.appendChild(li);
	};

	const markOf = ok => (ok === true ? ['r-mark pass', '✓', 'Matches what was expected']
		: ok === false ? ['r-mark fail', '✗', 'Not what was expected']
			: ['r-mark', '']);
	const note = text => {
		const li = document.createElement('li');
		li.className = 'r-note';
		li.textContent = text;
		els.returns.appendChild(li);
	};

	// A design case is a sequence of calls on one object, so it is listed a
	// call to a row - each marked against its own entry of the expected list,
	// which is how "top() came back -2" is found without comparing two long
	// lists of nulls by eye. A call that returns nothing is set quieter.
	const designRows = steps => {
		for (const s of steps.slice(0, DESIGN_ROWS)) {
			row(s.shown === 'null' && s.ok !== false ? 'r-quiet' : '', markOf(s.ok),
				['r-args', callOf(s)], ['r-val', s.shown],
				...(s.ok === false ? [['r-want', s.expected]] : []));
		}
		if (steps.length > DESIGN_ROWS) {
			note(`… and ${steps.length - DESIGN_ROWS} more calls.`);
		}
	};

	const design = sol?.kind === 'design';
	cases.forEach((c, i) => {
		if (design) {
			if (cases.length > 1 || sol.partial?.length) {
				note(`Case ${i + 1}`);
			}
			const judged = designSteps(c.expected, c.ops ?? []);
			designRows(judged.steps);
			if (c.ok === false && !judged.fits) {
				note(designFact(judged, c.expected) || `Expected ${c.expected}.`);
			}
			return;
		}
		row('', markOf(c.ok),
			['r-args', callLabel(c.call, sol.method)],
			['r-val', c.inPlace ? `${c.inPlace} = ${c.shown}` : c.shown,
				c.inPlace ? `Returns nothing: this is ${c.inPlace} after the call` : ''],
			...(c.ok === false ? [['r-want', c.expected]] : []));
	});

	// The calls a design case made before one raised, or never returned.
	if (design && sol.partial?.length) {
		note(`Case ${cases.length + 1}, until it stopped`);
		designRows(sol.partial);
	}
	if (sol?.failed) {
		const at = designAt(sol.failed);
		note(at
			? `${at.call}, call ${at.n} of ${at.total}, raised an error, and nothing after it was run.`
			: `${callLabel(sol.failed, sol.method)} raised an error, and the cases after it were not run.`);
	}
	if (loop?.case && sol) {
		const at = designAt(loop.case);
		note(at ? `${at.call}, call ${at.n} of ${at.total}, never returned.` : `${callLabel(loop.case, sol.method)} never returned.`);
	}
	if (sol?.truncated) {
		note('Only the first 50 cases were run.');
	}
	// A leftover Expected box is easy to miss behind its tab, and pairs its
	// answers with the wrong cases without a word.
	const expectedCount = els.expect.value.split('\n').filter(l => l.trim()).length;
	if (expectedCount && cases.length && expectedCount !== cases.length && !sol?.failed && !loop) {
		note(`Expected has ${expectedCount} line${expectedCount === 1 ? '' : 's'} for ${cases.length} case${cases.length === 1 ? '' : 's'}; `
			+ 'each line is checked against the case in the same position.');
	}

	els.returns.hidden = !els.returns.childNodes.length;
	if (!els.returns.hidden) {
		els.outEmpty.hidden = true;
	}
}

/** The Solution ran: what it returned, whether that was right, or why it could not be called. */
function showSolution(result, sol, cases, plan) {
	els.card.hidden = true;
	els.values.hidden = true;

	if (sol.needsInput || sol.inputError) {
		showInputNeeded(sol, plan);
		return;
	}

	const wrong = cases.filter(c => c.ok === false);
	if (wrong.length && sol.kind === 'design') {
		showDesignWrong(cases, wrong);
		return;
	}
	if (wrong.length) {
		const first = wrong[0];
		// What the model is told about: the first wrong case, as values returned
		// rather than lines printed.
		lastRun.expected = first.expected;
		lastRun.call = first.call;
		lastRun.returned = first.shown;
		lastRun.caseIndex = cases.indexOf(first);
		lastRun.inPlace = first.inPlace;
		lastRun.difference = differenceOf(first.expected, first);
		showDiff(first.expected, first.shown);
		showWhere(els.diffCase, {
			lead: cases.length > 1 ? `Case ${cases.indexOf(first) + 1} of ${cases.length}` : '',
			call: callLabel(first.call, sol.method),
			note: wrong.length > 1 ? `${wrong.length} of the ${cases.length} are wrong; this is the first.` : '',
		});
		els.diffFact.textContent = lastRun.difference;
		els.diffFact.hidden = !lastRun.difference;
		explain(undefined, 'diff');
		return;
	}

	els.okCard.hidden = false;
	els.diffCard.hidden = true;
	els.okCard.classList.remove('stalled', 'asking');

	const n = cases.length;
	const checked = cases.filter(c => c.ok !== undefined).length;
	const examples = plan?.from === 'problem'
		? ` on the ${n === 1 ? 'example' : `${n} examples`} from the Problem`
		: '';

	// The answers themselves are listed once, in Output under the code.
	if (checked && checked === n) {
		els.okTitle.textContent = n === 1 ? 'Matches' : `All ${n} match`;
		els.okMeta.textContent = `${sol.method} returned the expected answer${n === 1 ? '' : ' every time'}${examples}.`;
	} else {
		els.okTitle.textContent = 'Ran cleanly';
		els.okMeta.textContent = checked
			? `${checked} of ${n} matched what was expected; the rest had nothing to check against.`
			: `No errors. What ${sol.method} returned${examples} is in Output, under the code.`;
	}
}

/**
 * A design case came back wrong: the card names the one call that did, with
 * its expected and returned values, rather than setting two long lists of
 * nulls side by side to be compared by eye. Output has the whole sequence.
 */
function showDesignWrong(cases, wrong) {
	const first = wrong[0];
	const judged = designSteps(first.expected, first.ops ?? []);
	const step = judged.steps[judged.first];
	const total = judged.steps.length;
	const before = judged.steps.slice(0, Math.max(0, judged.first)).map(callOf);
	const earlier = before.length > 6 ? [...before.slice(0, 2), '…', ...before.slice(-3)] : before;

	// What the model is told: the call that came back wrong, and the calls that led up to it.
	lastRun.expected = step ? step.expected : first.expected;
	lastRun.returned = step ? step.shown : first.shown;
	lastRun.call = step ? `${callOf(step)} - call ${judged.first + 1} of ${total}, after ${earlier.join(', ')}` : first.call;
	lastRun.method = step?.op;
	lastRun.caseIndex = cases.indexOf(first);
	lastRun.difference = designFact(judged, first.expected);
	lastRun.design = judged;   // each call, judged, with the object after it

	showDiff(lastRun.expected, lastRun.returned);
	showWhere(els.diffCase, {
		lead: cases.length > 1 ? `Case ${cases.indexOf(first) + 1} of ${cases.length}` : '',
		at: step ? { call: callOf(step), n: judged.first + 1, total } : undefined,
		note: wrong.length > 1 ? `${wrong.length} of the ${cases.length} cases are wrong; this is the first.` : '',
	});
	els.diffFact.textContent = lastRun.difference;
	els.diffFact.hidden = !lastRun.difference;
	explain(undefined, 'diff');
}

/** What the ok card's one action does, while it shows one. */
let okAction;

/** Puts an action under the ok card, or takes it away. */
function setOkAction(label, action) {
	okAction = action;
	els.okAct.textContent = label ?? '';
	els.okFoot.hidden = !action;
}

els.okAct.addEventListener('click', () => okAction?.());

/** Empties a remembered box, the way typing it empty would - saved, and its tab's dot updated. */
function clearBox(box) {
	box.value = '';
	box.dispatchEvent(new Event('input'));
}

/** There was nothing to call it with, or what there was does not fit the method. */
function showInputNeeded(sol, plan) {
	els.okCard.hidden = false;
	els.diffCard.hidden = true;
	els.okCard.classList.toggle('asking', Boolean(sol.needsInput));
	els.okCard.classList.toggle('stalled', !sol.needsInput);

	const design = sol.kind === 'design';
	const signature = design ? sol.method : `${sol.method}(${sol.params.join(', ')})`;
	// How a case is written for this code, with its own names in it.
	let example;
	if (design) {
		const shown = (sol.methods ?? []).slice(0, 2);
		const ops = [sol.method, ...shown].map(n => JSON.stringify(n)).join(',');
		const args = [sol.params, ...shown.map(m => sol.signatures?.[m] ?? [])]
			.map(names => `[${names.join(', ')}]`).join(',');
		example = `[${ops}]\n[${args}]`;
	} else {
		example = sol.params.map(p => `${p} = …`).join(', ');
	}

	// The commonest way to get here with input that does not fit: the Problem
	// tab still holds yesterday's exercise, and its examples were run against
	// today's code. That is worth saying plainly, with the way out beside it.
	const stale = Boolean(sol.inputError) && plan?.from === 'problem';
	if (sol.needsInput) {
		els.okTitle.textContent = 'Needs a test case';
		els.okMeta.textContent = design
			? `${signature} is ready to drive. Put its calls in Test cases the way LeetCode writes them - `
				+ `the operations on one line, their arguments on the next, with real values: ${example.replace('\n', ' then ')} - `
				+ 'or paste the problem under Problem, and its examples are used.'
			: `${signature} is ready to call. Put its arguments in Test cases - ${example} - `
				+ 'or paste the problem under Problem, and its examples are used.';
	} else if (stale) {
		els.okTitle.textContent = 'The Problem is for different code';
		els.okMeta.textContent = `Its examples were run against ${signature}, and they do not fit: ${sol.inputError}. `
			+ 'Is it the problem from an earlier exercise?';
	} else {
		els.okTitle.textContent = 'Input does not fit';
		els.okMeta.textContent = design
			? `${sol.inputError}. Write each case as two lines - the operations, then their arguments: ${example.replace('\n', ' then ')}.`
			: `${sol.inputError}. Write each case as ${example || `${sol.method}()`}, one per line.`;
	}
	setOkAction(stale ? 'Clear the Problem and run again' : undefined, stale ? () => {
		clearBox(els.problem);
		run();
	} : undefined);

	// Where the answer goes, opened and ready, with the method's own names in it.
	els.input.placeholder = design
		? `${example}\n\nThe operations on one line, their arguments on the next. Left empty, the Problem's examples are used.`
		: `${example}\n\nOne case per line, or paste a whole example. Left empty, the Problem's examples are used.`;
	selectTab(stale ? 'problem' : 'tests');
}

/**
 * A run that would not end, and where it was stuck.
 *
 * Only a while loop whose condition's names never changed while watched is
 * called infinite - that is a fact the harness observed, not a guess. Anything
 * else is reported as still running, with the values that were still moving.
 */
function showLoop(loop, code) {
	els.card.hidden = false;
	els.okCard.hidden = true;
	els.diffCard.hidden = true;

	const where = loop.loop;
	const line = where?.line ?? loop.line;
	const watched = loop.watched ?? [];
	const held = watched.map(n => `${n} stayed ${loop.locals?.[n]}`).join(', ');

	els.errType.textContent = loop.stuck ? 'Infinite loop' : 'Still running';
	if (loop.stuck) {
		els.errMsg.textContent = `${held} the whole time it was watched, so "${where.condition}" never turned false.`;
		els.errHint.textContent = `A while loop ends only when its condition turns false, and that can only happen `
			+ `if something inside it changes ${watched.join(' or ')}. What in this loop does?`;
	} else {
		els.errMsg.textContent = `Stopped after ${loop.seconds}s`
			+ (where ? `, still in the ${where.kind} loop on line ${where.line}.` : line ? `, on line ${line}.` : '.');
		els.errHint.textContent = where
			? 'Its values were still changing, so it may only be slow - or its end is never reached. '
				+ 'Does each pass bring it closer to the end?'
			: 'It had not finished. Is something here doing far more work than the input needs?';
	}
	const shown = inBuffer(line);
	if (shown) {
		markLine({
			type: els.errType.textContent,
			message: loop.stuck ? `${watched.join(', ')} never changes` : `still running after ${loop.seconds}s`,
			primary: { line: shown },
		}, code.split('\n')[shown - 1] ?? '');
		editor.revealLineInCenterIfOutsideViewport(shown, monaco.editor.ScrollType.Smooth);
	}
	const at = designAt(loop.case);
	showWhere(els.errWhere, {
		line: shown,
		fn: loop.function,
		call: at ? undefined : loop.case && lastRun.solution ? callLabel(loop.case, lastRun.solution.method) : loop.case,
		at,
	});

	// The values, with what the verdict rests on picked out: the names the
	// condition reads, which never moved, and the ones that did.
	els.valuesRows.textContent = '';
	const entries = Object.entries(loop.locals ?? {});
	els.values.hidden = entries.length === 0;
	els.valuesHead.textContent = loop.stuck ? 'Values while it was stuck' : 'Values when it was stopped';
	for (const [name, repr] of entries) {
		const changed = loop.changed?.includes(name);
		const row = valueRow(name, repr, changed);
		const note = watched.includes(name) && !changed ? 'never changed' : changed ? 'changing' : '';
		if (watched.includes(name) && !changed) {
			row.className = 'stuck';
		}
		if (note) {
			const span = document.createElement('span');
			span.className = 'vnote';
			span.textContent = note;
			row.lastChild.appendChild(span);
		}
		els.valuesRows.appendChild(row);
	}

	explain();
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
// The line number in a card's "On line 4, ..." sentence goes back to that line.
document.addEventListener('click', e => {
	const line = Number(e.target.closest?.('.jump')?.dataset.line);
	if (line && inBuffer(line)) {
		editor.revealLineInCenter(line, monaco.editor.ScrollType.Smooth);
		editor.setPosition({ lineNumber: line, column: 1 });
		editor.focus();
	}
});

// --- the model ----------------------------------------------------------------

/**
 * What the status line under an answer says while it is on its way.
 *
 * Seconds are counted on purpose. A number going up is the difference between
 * "working, slowly" and "broken", and the app used to show neither - just a
 * caret, for as long as the request took, which with no timeout could be for
 * ever.
 */
function phaseText(phase, ms, model) {
	const s = Math.round(ms / 1000);
	switch (phase) {
		case 'waiting':
			return s < 2 ? `Asking ${model}…` : `Waiting for ${model}… ${s}s (loading it, usually)`;
		case 'thinking':
			return `${model} is thinking before it answers… ${s}s`;
		default:
			return 'Writing…';
	}
}

/** Puts a status line into its busy, done or failed look. */
function setStatus(status, state, text = '') {
	status.textContent = text;
	status.classList.toggle('is-busy', state === 'busy');
	status.classList.toggle('is-error', state === 'error');
}

/** Says why an answer did not arrive, and offers the next thing to try. */
function paintFailure(box, status, err, retry) {
	box.innerHTML = `<p class="ai-error">${escapeHtml(err?.message ?? String(err))}</p>`;
	setStatus(status, 'error');
	if (retry) {
		status.append(button('Try again', retry));
	}
	if (err?.kind === 'offline') {
		status.append(button('Start it', () => startAndRetry(retry)));
	} else if (err?.kind === 'missing' || err?.kind === 'timeout' || err?.kind === 'empty') {
		status.append(button('Choose a model', openSettings));
	}
}

/** No model at all: say so where the answer would have been, rather than nothing. */
function paintNoModel(box, status, retry) {
	box.innerHTML = '<p class="ai-error">No model is running, so there is nothing to answer this yet.</p>';
	setStatus(status, 'error');
	status.append(button('Start it', () => startAndRetry(retry)));
	status.append(button('Settings', openSettings));
}

/**
 * Starts the model server the answer was meant for, then tries again.
 *
 * Only that one. Starting every installed server and then waiting for all of
 * them to answer cost the full 25-second wait whenever one was slow to come up
 * - measured with LM Studio on the machine this was fixed on, where recovering
 * from a dead Ollama took 36s of which the answer itself was 8.
 */
async function startAndRetry(retry) {
	const installed = await window.studio.probe().catch(() => ({}));
	const wanted = ai.provider ? [ai.provider]
		: installed.ollamaPath ? ['ollama']
			: undefined;
	els.status.textContent = 'Starting the model server…';
	try {
		const res = await window.studio.startServers(wanted);
		if (res?.starting?.length) {
			await waitForProviders(res.starting, 25000);
		}
	} catch {
		/* the retry reports whatever is still wrong */
	}
	els.status.textContent = '';
	await refreshSetup();
	retry?.();
}

/** Which request currently owns each answer box, so a superseded one cannot paint over it. */
const boxOwner = new WeakMap();

/**
 * Streams one answer into `box`, and keeps `status` honest about it.
 *
 * Every model request in the app goes through here, so they all behave alike,
 * and every one ends visibly: with the answer and how long it took, or with
 * what went wrong and something to press. Each request has its own controller.
 * There used to be one shared between everything, so asking a question
 * silently cancelled the explanation still arriving, and pressing Run
 * cancelled the question.
 *
 * @param {{ retry?: () => void, clean?: (text: string) => string }} [opts]
 *        `retry` is what "Try again" does; `clean` turns the model's text into
 *        what is shown, and defaults to removing any private reasoning.
 * @returns {{ done: Promise<string|undefined>, stop: () => void }}
 *          `done` resolves with the visible answer, or undefined if there was none.
 */
function answerInto(box, status, messages, { retry, clean = stripReasoning } = {}) {
	const ctrl = new AbortController();
	const { provider, model, thinks } = ai;
	boxOwner.set(box, ctrl);
	const mine = () => boxOwner.get(box) === ctrl;

	const done = (async () => {
		if (!provider) {
			paintNoModel(box, status, retry);
			return undefined;
		}

		box.innerHTML = '<span class="caret"></span>';
		const started = Date.now();
		let text = '';
		try {
			const { text: full, truncated } = await chat({
				provider, model, thinks, messages,
				signal: ctrl.signal,
				onStatus: (phase, ms) => {
					if (mine()) {
						setStatus(status, 'busy', phaseText(phase, ms, model));
					}
				},
				onToken: token => {
					text += token;
					const visible = clean(text);
					if (visible && mine()) {
						box.innerHTML = render(visible) + '<span class="caret"></span>';
					}
				},
			});

			const answer = clean(full);
			if (mine()) {
				box.innerHTML = render(answer);
				const secs = ((Date.now() - started) / 1000).toFixed(1);
				setStatus(status, 'done', `Answered by ${model} in ${secs}s${truncated ? ', cut short at the length limit' : ''}.`);
			}
			// An answer is proof the model is loaded, whatever the header last said.
			if (ai.provider === provider && ai.model === model && warmState !== 'ready') {
				warmState = 'ready';
				paintModelLabel();
			}
			return answer;
		} catch (err) {
			// A request replaced by a newer one says nothing: the newer one owns
			// the box now, and "Stopped." over its answer would be a lie.
			if (err?.kind !== 'stopped' && mine()) {
				paintFailure(box, status, err, retry);
			}
			return undefined;
		}
	})();

	return { done, stop: () => ctrl.abort() };
}

/**
 * Explains the last run: the crash, or the wrong answer.
 *
 * @param {string} [question] Free text, e.g. something said out loud.
 * @param {'error'|'diff'} [target] Which card the answer belongs in.
 * @param {boolean} [reveal] Show the fix outright, rather than teaching.
 */
async function explain(question, target = 'error', reveal = false) {
	if (!lastRun) {
		return undefined;
	}
	// One explanation at a time: a new one replaces whatever was still arriving.
	explaining?.stop();

	const out = target === 'diff' ? els.diffExplain : els.explain;
	const meta = target === 'diff' ? els.diffMeta : els.aiMeta;

	// The request and the cleaning of its answer are built in ai.js, where they
	// were measured: the teaching answer never shows the fix, in code or in
	// words, whatever the model wrote - Show the fix is where the fix lives.
	const { messages, clean } = buildTeaching({
		code: lastRun.code,
		parsed: lastRun.parsed,
		stdout: lastRun.stdout,
		expected: lastRun.expected,
		values: lastRun.values,
		trace: lastRun.trace,
		problem: els.problem.value,
		question,
		...solutionFacts(lastRun),
	}, { reveal });

	explaining = answerInto(out, meta, messages, {
		retry: () => explain(question, target, reveal),
		clean,
	});
	return explaining.done;
}

/**
 * What a Solution or design run adds to a prompt: the calls, what they
 * returned, which one was wrong, and any stuck loop. For a design case the
 * "method" is the one call that came back wrong.
 */
function solutionFacts(run) {
	return {
		loop: run?.loop,
		method: run?.method ?? run?.solution?.method,
		calls: run?.solution?.cases,
		call: run?.call,
		returned: run?.returned,
		difference: run?.difference,
		failed: run?.solution?.failed,
		caseIndex: run?.caseIndex,
		inPlace: run?.inPlace,
		design: run?.design,
	};
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

/*
 * The same for the panel under the code: a long traceback or forty test cases
 * want it tall, writing code wants it short. Remembered in pixels, and kept to
 * what leaves the editor some room in whatever window it comes back in.
 */
(() => {
	const work = els.hsplit.parentElement;
	const fit = h => Math.round(Math.min(work.clientHeight - 160, Math.max(120, h)));
	const set = h => document.documentElement.style.setProperty('--panel-h', `${fit(h)}px`);

	let saved;
	try {
		saved = Number(localStorage.getItem('panelHeight'));
	} catch {
		/* storage disabled; the panel starts at its default height */
	}
	if (saved >= 120) {
		set(saved);
	}

	let dragging = false;
	els.hsplit.addEventListener('mousedown', e => {
		dragging = true;
		els.hsplit.classList.add('dragging');
		e.preventDefault();
	});

	window.addEventListener('mousemove', e => {
		if (dragging) {
			set(work.getBoundingClientRect().bottom - e.clientY);
		}
	});

	window.addEventListener('mouseup', () => {
		if (!dragging) {
			return;
		}
		dragging = false;
		els.hsplit.classList.remove('dragging');
		try {
			localStorage.setItem('panelHeight', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--panel-h'), 10)));
		} catch {
			/* the height just will not persist */
		}
	});
})();

// --- the panel's tabs ----------------------------------------------------------

/** Shows one of Output, Test cases and Problem. */
function selectTab(name) {
	for (const tab of els.tabs) {
		const on = tab.id === `tab-${name}`;
		tab.setAttribute('aria-selected', String(on));
		tab.tabIndex = on ? 0 : -1;
		$(tab.getAttribute('aria-controls')).hidden = !on;
	}
}

for (const tab of els.tabs) {
	tab.addEventListener('click', () => selectTab(tab.id.slice('tab-'.length)));
	// Arrow keys move between tabs, as they do in any tab strip.
	tab.addEventListener('keydown', e => {
		const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
		if (!step) {
			return;
		}
		const next = els.tabs[(els.tabs.indexOf(tab) + step + els.tabs.length) % els.tabs.length];
		selectTab(next.id.slice('tab-'.length));
		next.focus();
		e.preventDefault();
	});
}

/**
 * A dot on a tab with something in it. A problem pasted yesterday, or an
 * expected output left over from the last exercise, is easy to forget behind a
 * tab - and a stale expected output turns every correct run red.
 */
function markFilled() {
	$('tab-tests').classList.toggle('filled', Boolean(els.input.value.trim() || els.expect.value.trim()));
	$('tab-problem').classList.toggle('filled', Boolean(els.problem.value.trim()));
}

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

	const changed = choice?.provider !== ai.provider || choice?.model !== ai.model;
	ai.provider = choice?.provider;
	ai.model = choice?.model;
	ai.thinks = choice ? modelThinks(servers.find(s => s.provider === choice.provider), choice.model) : false;
	// A warm-up that failed - usually because the server went away mid-load -
	// is tried again whenever the setup is re-checked, or the header would say
	// "could not load" long after the model was answering again.
	if (changed || warmState === 'failed') {
		warmUp();
	}
	paintModelLabel();

	// Never disabled for want of a model. Pressing one with nothing running
	// says so, in place; a greyed-out button said nothing at all.
	els.ask.disabled = false;
	els.diffAsk.disabled = false;
	els.reveal.disabled = false;
	els.diffReveal.disabled = false;
	setAskEnabled(true);

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
	forgetOldPicks();
	const remembered = readModelChoice();

	els.status.textContent = remembered
		? `Starting ${PROVIDERS[remembered.provider]?.label ?? remembered.provider}…`
		: 'Looking for a model…';

	try {
		// With nothing chosen, Ollama alone when it is installed: the default
		// model lives there, it is the server that can load a model ahead of the
		// first question, and starting LM Studio too on every launch cost memory
		// for a choice nobody had made. LM Studio is one press away in Settings.
		const installed = await window.studio.probe().catch(() => ({}));
		const only = remembered ? [remembered.provider]
			: installed.ollamaPath ? ['ollama']
				: undefined;
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

	// The automatic default is deliberately NOT saved as a pick. It used to
	// be, so a slow model chosen by the old rule stuck for good, and a better
	// default could never reach anyone who had launched the app once.
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
/** Whether the chosen model is in memory yet: 'loading', 'ready', 'failed', or undefined. */
let warmState;

/**
 * Loads the chosen model now, rather than at the first question, and says so
 * in the header while it happens. The first answer of a session used to pay
 * the whole load - seconds for a small model, the better part of a minute for
 * a large one - with nothing on screen to say so.
 */
async function warmUp() {
	const { provider, model } = ai;
	if (!provider || !model) {
		warmState = undefined;
		paintModelLabel();
		return;
	}
	warmState = 'loading';
	paintModelLabel();
	const ok = await warmModel(provider, model);
	// Someone may have picked another model while this one loaded.
	if (ai.provider === provider && ai.model === model) {
		warmState = ok ? 'ready' : 'failed';
		paintModelLabel();
	}
}

function paintModelLabel() {
	const note = !ai.model ? ''
		: warmState === 'loading' ? ' · loading…'
			: warmState === 'failed' ? ' · could not load'
				: ai.thinks ? ' · slow, thinks first' : '';
	els.modelLabel.textContent = ai.model ? `${ai.model}${note}` : 'no model running';
	// The dot on the bar: ready, loading, failed, or nothing to answer with.
	els.settingsOpen.dataset.state = !ai.model ? 'none' : (warmState ?? 'ready');
	els.settingsOpen.title = ai.model
		? `${PROVIDERS[ai.provider].label} · ${ai.model}  (Settings)`
		: 'No model is running  (Settings)';
}

/**
 * Model picks saved before this version are forgotten, once.
 *
 * They were made while the app gave no sign of whether anything was working.
 * The stored history on the machine this was fixed on shows eight models tried
 * in turn, a 27B among them; and the first run used to save its own automatic
 * default as if it had been chosen - a 7.6B that thinks for forty seconds
 * before writing a word. Keeping any of that would carry the original failure
 * straight past the fix. Picks made from here on are kept.
 */
const PICK_VERSION = '2';

function forgetOldPicks() {
	try {
		if (localStorage.getItem('modelPickVersion') !== PICK_VERSION) {
			localStorage.removeItem('model');
			localStorage.setItem('modelPickVersion', PICK_VERSION);
		}
	} catch {
		/* storage unavailable: nothing was remembered to forget */
	}
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
				if (modelThinks(server, model)) {
					const tag = document.createElement('span');
					tag.className = 'model-tag';
					tag.textContent = 'thinks first · slow';
					row.appendChild(tag);
				}
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
	ai.thinks = modelThinks((setupState?.servers ?? []).find(s => s.provider === provider), model);
	rememberModelChoice(provider, model);
	warmUp();
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
 * A box in the panel that remembers what was typed in it.
 *
 * The problem, the test cases and the expected answers are all things you
 * paste once and then run against twenty times, so losing any of them on
 * restart would make them not worth filling in.
 */
function rememberText(box, key) {
	try {
		box.value = localStorage.getItem(key) ?? '';
	} catch {
		/* storage disabled; the box simply starts empty */
	}
	markFilled();

	box.addEventListener('input', () => {
		markFilled();
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
	els.diffCase.hidden = true;
	els.diffFact.hidden = true;
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
const HISTORY_TURNS = 2;

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
 *
 * The question always lands in the thread, even when nothing can answer it. It
 * used to vanish - the box cleared, and nothing shown - whenever no model was
 * running, which is exactly when someone most needs to be told why.
 */
async function ask(question, mode = 'ask', scope = selection) {
	if (!editor) {
		return undefined;
	}

	const { answer, meta } = addTurn(question, scope);
	const system = mode === 'complexity' ? SYSTEM_PROMPT_COMPLEXITY
		: mode === 'optimise' ? SYSTEM_PROMPT_OPTIMISE
			: SYSTEM_PROMPT_ASK;

	const messages = [
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
				...solutionFacts(lastRun),
			}),
		},
	];

	const retry = () => {
		answer.closest('.qa')?.remove();
		ask(question, mode, scope);
	};

	const clean = await answerInto(answer, meta, messages, { retry }).done;
	if (clean) {
		history.push({ role: 'user', content: question }, { role: 'assistant', content: clean });
		turns.push({ q: question, scope, a: clean, meta: meta.textContent });
		saveThread();
	}
	return clean;
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
	els.valuesHead.textContent = 'Values at that moment';

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
		els.traceWhere.textContent = `Step ${traceAt + 1} of ${traceSteps.length}: line ${step.line}, where ${where} returned ${step.ret}.`;
	} else if (step.r) {
		els.traceWhere.textContent = `Step ${traceAt + 1} of ${traceSteps.length}: line ${step.line}, where ${where} ended.`;
	} else if (step.exc) {
		els.traceWhere.textContent = `Step ${traceAt + 1} of ${traceSteps.length}: line ${step.line} raised ${step.exc}.`;
	} else {
		// A line event fires before the line runs, so this is about to happen,
		// not just happened. Saying so is the difference between the panel
		// making sense and being off by one.
		els.traceWhere.textContent = `Step ${traceAt + 1} of ${traceSteps.length}: about to run line ${step.line} in ${where}.`;
	}

	// Landing on the first step after the gap without being told would read as
	// one continuous run that skipped from the second pass to the last.
	if (lastTrace?.dropped && traceAt === lastTrace.gapAt) {
		els.traceWhere.textContent += ` ${lastTrace.dropped} steps before this were not recorded.`;
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
