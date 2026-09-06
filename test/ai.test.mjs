/*
 * Which model answers by default, and how a recorded run is put to it.
 *
 * Both were got wrong once and neither is visible when it is:
 *
 *   pickDefaultModel used to consider only models with "coder" in the name, so
 *   a 1.5B coder beat a 7.6B general model sitting beside it - and the 1.5B
 *   writes the corrected code the prompt forbids. The panel still answered, so
 *   nothing looked broken.
 *
 *   formatTrace turns the harness's changed-locals history into the lines the
 *   model reads. When the recording hit its cap the steps shown are from the
 *   middle of a longer run, and a model told nothing about that will explain a
 *   program that stopped where the recording did.
 */
import assert from 'node:assert';
import {
	pickDefaultModel, pickDefaultServer, pickSmallestModel,
	formatTrace, buildPrompt, buildSummaryPrompt, SYSTEM_PROMPT_SUMMARY,
} from '../renderer/ai.js';

let failed = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok    ${name}`);
	} catch (err) {
		console.log(`FAIL  ${name}\n        ${err.message}`);
		failed++;
	}
};

// --- picking a model ---------------------------------------------------------

// The machine this was written on, with the sizes Ollama reports for those tags.
const INSTALLED = ['qwen2.5-coder:1.5b', 'qwen3:4b', 'logic:latest', 'qwen2.5:1.5b'];
const SIZES = { 'qwen2.5-coder:1.5b': 1.5, 'qwen3:4b': 4, 'logic:latest': 7.6, 'qwen2.5:1.5b': 1.5 };

check('a 7.6B beats a 1.5B coder - the case on the machine this was written on', () => {
	assert.strictEqual(pickDefaultModel(INSTALLED, SIZES), 'logic:latest');
});

// Without the server's own numbers, a custom tag has no size in it at all and
// there is nothing to rank it by. It is still selectable in the picker.
check('an unsized custom tag falls behind a model that spells its size out', () => {
	assert.strictEqual(pickDefaultModel(INSTALLED), 'qwen3:4b');
});

check('the reported size wins over a misleading name', () => {
	assert.strictEqual(
		pickDefaultModel(['tiny-name-7b', 'real:latest'], { 'tiny-name-7b': 1.5, 'real:latest': 7 }),
		'real:latest',
	);
});

check('coder-tuned wins among models that are big enough', () => {
	assert.strictEqual(
		pickDefaultModel(['llama3:8b', 'qwen2.5-coder:7b']),
		'qwen2.5-coder:7b',
	);
});

check('largest still wins within the coders', () => {
	assert.strictEqual(
		pickDefaultModel(['qwen2.5-coder:3b', 'qwen2.5-coder:7b']),
		'qwen2.5-coder:7b',
	);
});

check('anything over the local ceiling is passed over', () => {
	assert.strictEqual(
		pickDefaultModel(['qwen2.5-coder:32b', 'qwen2.5-coder:7b']),
		'qwen2.5-coder:7b',
	);
});

check('a small coder is still better than nothing when it is all there is', () => {
	assert.strictEqual(pickDefaultModel(['qwen2.5-coder:1.5b']), 'qwen2.5-coder:1.5b');
});

check('embedding models are never picked', () => {
	assert.strictEqual(pickDefaultModel(['nomic-embed-text:latest', 'llama3:8b']), 'llama3:8b');
	assert.strictEqual(pickDefaultModel(['nomic-embed-text:latest']), undefined);
});

check('an unsized name is still better than a dead panel', () => {
	assert.strictEqual(pickDefaultModel(['some-local-build']), 'some-local-build');
});

// --- picking across both servers ---------------------------------------------
// Running LM Studio and Ollama at once is a normal setup. The panel used to
// take whichever answered first and never look at the other, so half the
// models were invisible and which half depended on probe order.

check('the best model wins even when it is on the second server', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: ['qwen2.5-coder:1.5b'], sizes: {} },
			{ provider: 'ollama', models: ['qwen2.5-coder:7b'], sizes: {} },
		]),
		{ provider: 'ollama', model: 'qwen2.5-coder:7b' },
	);
});

check('a size reported by one server counts for the choice', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: ['some-1.5b-thing'], sizes: {} },
			{ provider: 'ollama', models: ['logic:latest'], sizes: { 'logic:latest': 7.6 } },
		]),
		{ provider: 'ollama', model: 'logic:latest' },
	);
});

check('a server that is up but empty is skipped, not chosen', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: [], sizes: {} },
			{ provider: 'ollama', models: ['qwen2.5-coder:7b'], sizes: {} },
		]),
		{ provider: 'ollama', model: 'qwen2.5-coder:7b' },
	);
});

check('the same model on both servers resolves to one of them', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: ['qwen2.5-coder:7b'], sizes: {} },
			{ provider: 'ollama', models: ['qwen2.5-coder:7b'], sizes: {} },
		]),
		{ provider: 'lmstudio', model: 'qwen2.5-coder:7b' },
	);
});

check('nothing running, nothing chosen', () => {
	assert.strictEqual(pickDefaultServer([]), undefined);
	assert.strictEqual(pickDefaultServer(undefined), undefined);
	assert.strictEqual(pickDefaultServer([{ provider: 'ollama', models: [], sizes: {} }]), undefined);
});

// --- compressing the conversation --------------------------------------------
// Turns past the window used to be dropped. They are summarised now, by the
// cheapest model on the server already running - this is bookkeeping, and it
// must not cost the price of an answer.

check('the smallest model is chosen for the bookkeeping', () => {
	assert.strictEqual(
		pickSmallestModel(['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b', 'qwen3:4b']),
		'qwen2.5-coder:1.5b',
	);
});

check('a reported size beats the name here too', () => {
	assert.strictEqual(
		pickSmallestModel(['looks-7b', 'real:latest'], { 'looks-7b': 7, 'real:latest': 1.5 }),
		'real:latest',
	);
});

check('embedding models are not summarisers', () => {
	assert.strictEqual(pickSmallestModel(['nomic-embed-text-1.5b', 'qwen3:4b']), 'qwen3:4b');
});

check('nothing sized, nothing chosen - the caller falls back', () => {
	assert.strictEqual(pickSmallestModel(['some-local-build']), undefined);
	assert.strictEqual(pickSmallestModel([]), undefined);
});

check('the summariser is told to add nothing of its own', () => {
	assert.match(SYSTEM_PROMPT_SUMMARY, /Do NOT add anything that is not in the notes/);
	assert.match(SYSTEM_PROMPT_SUMMARY, /leave it out rather than guessing/);
	// It must be forbidden from producing code or corrections: the real
	// artifacts cover those, and they are sent in full on every request.
	assert.match(SYSTEM_PROMPT_SUMMARY, /No advice, no/);
	assert.match(SYSTEM_PROMPT_SUMMARY, /no code, no speculation/);
});

check('the first fold has no previous notes to rewrite', () => {
	const prompt = buildSummaryPrompt('', [
		{ role: 'user', content: 'why is this O(n squared)?' },
		{ role: 'assistant', content: 'the inner loop runs n - i times.' },
	]);
	assert.doesNotMatch(prompt, /THE NOTES SO FAR/);
	assert.match(prompt, /They asked: why is this O\(n squared\)\?/);
	assert.match(prompt, /The tutor answered: the inner loop runs n - i times\./);
	assert.match(prompt, /Write the notes/);
});

check('later folds carry the notes forward instead of starting again', () => {
	const prompt = buildSummaryPrompt('They established the loop is O(n squared).', [
		{ role: 'user', content: 'what about space?' },
	]);
	assert.match(prompt, /THE NOTES SO FAR:/);
	assert.match(prompt, /They established the loop is O\(n squared\)\./);
	assert.match(prompt, /Rewrite the notes/);
});

check('a runaway turn is truncated, not sent whole', () => {
	const prompt = buildSummaryPrompt('', [{ role: 'user', content: 'x'.repeat(5000) }]);
	assert.ok(prompt.length < 2000, `summary prompt was ${prompt.length} chars`);
});

// --- putting a run to it ------------------------------------------------------

const trace = {
	truncated: false,
	limit: 300,
	steps: [
		{ line: 1, fn: '<module>', d: 1 },
		{ line: 2, fn: 'two_sum', d: 2, vars: { nums: '[2, 7, 11, 15]', target: '9' } },
		{ line: 4, fn: 'two_sum', d: 2, vars: { i: '0', n: '2' } },
		{ line: 5, fn: 'two_sum', d: 2, vars: { want: '7' } },
		{ line: 6, fn: 'two_sum', d: 2, r: 1, ret: '[1, 0]' },
	],
};

check('the trace reads as lines, values and a return', () => {
	const text = formatTrace(trace);
	assert.match(text, /in the file itself:/);
	assert.match(text, /in two_sum\(\):/);
	assert.match(text, /line\s+4\s+i = 0, n = 2/);
	assert.match(text, /line\s+6\s+returned \[1, 0\]/);
});

check('a frame is only announced when it changes', () => {
	assert.strictEqual((formatTrace(trace).match(/in two_sum\(\):/g) ?? []).length, 1);
});

check('no trace, no lines - never an empty code fence', () => {
	assert.strictEqual(formatTrace(undefined), '');
	assert.strictEqual(formatTrace({ steps: [] }), '');
});

check('a truncated recording says so, in the words the model reads', () => {
	const prompt = buildPrompt({
		code: 'x = 1\n',
		expected: '[0, 1]',
		stdout: '[1, 0]',
		trace: { ...trace, truncated: true },
	});
	assert.match(prompt, /MIDDLE of the run/);
	assert.match(prompt, /Do not say the program ended here/);
});

check('an untruncated recording does not claim to be cut short', () => {
	const prompt = buildPrompt({ code: 'x = 1\n', expected: '[0, 1]', stdout: '[1, 0]', trace });
	assert.doesNotMatch(prompt, /MIDDLE of the run/);
	assert.match(prompt, /EVERY STEP OF THE RUN/);
});

// The lesson from the crash values, applied to the traced ones: a model reads
// the closing instruction hardest, so the real numbers have to be in it.
check('the closing question names the recorded values and the returned one', () => {
	const prompt = buildPrompt({ code: 'x = 1\n', expected: '[0, 1]', stdout: '[1, 0]', trace });
	const closing = prompt.trimEnd().split('\n').pop();
	assert.match(closing, /want = 7/);
	assert.match(closing, /two_sum\(\) returned \[1, 0\]/);
	assert.match(closing, /not your own reconstruction/);
});

check('the problem statement is given as the thing to judge against', () => {
	const prompt = buildPrompt({
		code: 'x = 1\n',
		expected: '[0, 1]',
		stdout: '[1, 0]',
		trace,
		problem: 'Return the indices in ascending order.',
	});
	assert.match(prompt, /THE PROBLEM THEY ARE SOLVING/);
	assert.match(prompt, /Return the indices in ascending order\./);
	assert.match(prompt.trimEnd().split('\n').pop(), /Answer against the problem statement/);
});

check('no problem statement, no mention of one', () => {
	const prompt = buildPrompt({ code: 'x = 1\n', expected: '[0, 1]', stdout: '[1, 0]', trace });
	assert.doesNotMatch(prompt, /THE PROBLEM THEY ARE SOLVING/);
	assert.doesNotMatch(prompt, /Answer against the problem statement/);
});

console.log(`\n${failed ? `${failed} failed` : 'all model and prompt cases passed'}`);
process.exit(failed ? 1 : 0);
