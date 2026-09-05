/*---------------------------------------------------------------------------------------------
 *  myIDE Studio - wiring.
 *
 *  The whole application flow is: edit -> Run -> Python tells us exactly what
 *  broke -> point at it -> optionally have a model explain it. There is no
 *  chat, no session, no history to manage; one file, one error at a time.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { parseTraceback, describe, hintFor } from './errors.js';
import { PROVIDERS, listModels, pickDefaultModel, buildPrompt, chat, stripReasoning } from './ai.js';
import { Voice } from './voice.js';

const STARTER = `# myIDE Studio - Python scratch\n# Ctrl+Enter to run.\n\n\n`;

const $ = id => document.getElementById(id);

const els = {
	run: $('run'), stop: $('stop'), status: $('status'), model: $('model'), mic: $('mic'),
	out: $('out'), card: $('card'), okCard: $('ok-card'), okMeta: $('ok-meta'),
	errType: $('err-type'), errHint: $('err-hint'), errLine: $('err-line'),
	explain: $('explain'), ask: $('ask'), aiMeta: $('ai-meta'), jump: $('jump'),
	overlay: $('voice-overlay'), wave: $('wave'), voiceState: $('voice-state'),
};

let editor;
let decorations;
let scratchPath = '';
let lastRun;
let aiAbort;
const ai = { provider: undefined, model: undefined };

// --- editor -------------------------------------------------------------------

window.addEventListener('monaco-ready', async () => {
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
	editor.setPosition({ lineNumber: session.line ?? 1, column: session.column ?? 1 });
	editor.focus();

	// Editing invalidates the marker: it is about code that no longer exists.
	editor.onDidChangeModelContent(() => {
		if (decorations.length) {
			decorations.clear();
		}
		scheduleSave();
	});
	editor.onDidChangeCursorPosition(scheduleSave);

	editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, run);

	await detectProvider();
});

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
	els.out.textContent = '';
	els.card.hidden = true;
	els.okCard.hidden = true;
	els.explain.innerHTML = '';
	els.aiMeta.textContent = '';

	els.run.disabled = true;
	els.stop.hidden = false;
	els.status.textContent = 'running…';

	const code = editor.getValue();
	const result = await window.studio.run(code);

	els.run.disabled = false;
	els.stop.hidden = true;
	els.status.textContent = `${(result.ms / 1000).toFixed(1)}s`;

	lastRun = { ...result, code };

	const parsed = parseTraceback(result.stderr, scratchPath || result.file);
	if (parsed) {
		showError(parsed, code);
	} else {
		showClean(result);
	}
}

function showError(parsed, code) {
	els.card.hidden = false;
	els.okCard.hidden = true;
	els.errType.textContent = describe(parsed);
	els.errHint.textContent = hintFor(parsed);

	const line = parsed.primary?.line;
	if (line) {
		const text = code.split('\n')[line - 1] ?? '';
		els.errLine.textContent = `${line}  ${text.trim()}`;
		markLine(parsed, text);
		editor.revealLineInCenterIfOutsideViewport(line, monaco.editor.ScrollType.Smooth);
	} else {
		els.errLine.textContent = '';
	}

	lastRun.parsed = parsed;
}

function showClean(result) {
	els.okCard.hidden = false;
	els.card.hidden = true;
	els.okMeta.textContent = result.timedOut
		? 'Stopped early — it was still running after 15 seconds.'
		: `Finished in ${(result.ms / 1000).toFixed(1)}s with exit code ${result.code}.`;
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

async function detectProvider() {
	for (const provider of ['lmstudio', 'ollama']) {
		try {
			const models = await listModels(provider);
			if (models.length) {
				ai.provider = provider;
				ai.model = pickDefaultModel(models);
				els.model.textContent = `${PROVIDERS[provider].label} · ${ai.model}`;
				return;
			}
		} catch {
			/* try the next provider */
		}
	}
	els.model.textContent = 'no model server';
	els.ask.disabled = true;
}

async function explain(question) {
	if (!ai.provider || !lastRun) {
		return;
	}
	aiAbort?.abort();
	aiAbort = new AbortController();

	els.explain.innerHTML = '<span class="caret"></span>';
	els.ask.disabled = true;
	const started = Date.now();
	let text = '';

	try {
		await chat({
			provider: ai.provider,
			model: ai.model,
			signal: aiAbort.signal,
			messages: [
				{ role: 'system', content: SYSTEM },
				{
					role: 'user',
					content: buildPrompt({
						code: lastRun.code,
						parsed: lastRun.parsed,
						stdout: lastRun.stdout,
						question,
					}),
				},
			],
		}, token => {
			text += token;
			els.explain.innerHTML = render(stripReasoning(text)) + '<span class="caret"></span>';
			els.explain.scrollTop = els.explain.scrollHeight;
		});

		els.explain.innerHTML = render(stripReasoning(text));
		els.aiMeta.textContent = `${ai.model} · ${((Date.now() - started) / 1000).toFixed(1)}s`;
	} catch (err) {
		if (err.name !== 'AbortError') {
			els.explain.innerHTML = `<p style="color:var(--bad)">${escapeHtml(err.message)}</p>`;
		}
	} finally {
		els.ask.disabled = false;
	}
	return text;
}

// Kept here rather than in ai.js so the prompt and the UI that renders it stay
// in one place; they change together.
const SYSTEM = [
	'You explain Python errors to someone learning data structures and algorithms.',
	'',
	'Python has ALREADY identified the error. You are given its exact traceback.',
	'Your job is to explain that specific error, not to look for other problems.',
	'',
	'Rules:',
	'- Explain what went wrong in one or two plain sentences. No jargon.',
	'- Say WHY it happened, referring to the actual line you were given.',
	'- Never claim a different error than the one in the traceback.',
	'- Then give the minimal fix as a short code snippet.',
	'- Under 120 words. No preamble, no restating the question.',
].join('\n');

els.ask.addEventListener('click', () => explain());

/** Just enough markdown for what the prompt asks the model to produce. */
function render(md) {
	const blocks = md.split(/```(?:python|py)?\n?/);
	return blocks.map((block, i) => {
		if (i % 2 === 1) {
			return `<pre><code>${escapeHtml(block.replace(/\n$/, ''))}</code></pre>`;
		}
		return block
			.split(/\n{2,}/)
			.filter(p => p.trim())
			.map(p => `<p>${
				escapeHtml(p.trim())
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
					.replace(/\n/g, '<br>')
			}</p>`)
			.join('');
	}).join('');
}

function escapeHtml(s) {
	return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

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
