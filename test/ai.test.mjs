/*
 * Which model answers by default, that every request ends, and how a recorded
 * run is put to the model.
 *
 *   pickDefaultModel once preferred a 7.6B that reasons privately for forty
 *   seconds before writing a word. With the reasoning hidden, that looked like
 *   the app doing nothing, and it was the main reason it felt broken. The
 *   default is now small, coder-tuned, and never a thinking model.
 *
 *   chat() once had no timeout at all, so a question could wait for ever. The
 *   requests below are made against a fake server that misbehaves in each of
 *   the ways a real one does, and every one of them has to end - with the text,
 *   or with an error that says what happened.
 *
 *   formatTrace turns the harness's changed-locals history into the lines the
 *   model reads. When the recording hit its cap the steps shown are from the
 *   middle of a longer run, and a model told nothing about that will explain a
 *   program that stopped where the recording did.
 */
import assert from 'node:assert';
import http from 'node:http';
import {
	pickDefaultModel, pickDefaultServer, modelThinks, chat, withoutCode,
	formatTrace, buildPrompt,
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
const checkAsync = async (name, fn) => {
	try {
		await fn();
		console.log(`ok    ${name}`);
	} catch (err) {
		console.log(`FAIL  ${name}\n        ${err.message}`);
		failed++;
	}
};

// --- picking a model ---------------------------------------------------------

// The machine this was fixed on, with what Ollama reports for each tag.
const INSTALLED = ['qwen3:14b', 'qwen2.5-coder:1.5b', 'qwen3:4b', 'logic:latest', 'qwen2.5:1.5b'];
const SIZES = { 'qwen3:14b': 14.8, 'qwen2.5-coder:1.5b': 1.5, 'qwen3:4b': 4, 'logic:latest': 7.6, 'qwen2.5:1.5b': 1.5 };
const THINKING = { 'qwen3:14b': true, 'qwen2.5-coder:1.5b': false, 'qwen3:4b': true, 'logic:latest': true, 'qwen2.5:1.5b': false };

check('the small non-thinking coder wins - the case on the machine this was fixed on', () => {
	assert.strictEqual(pickDefaultModel(INSTALLED, SIZES, THINKING), 'qwen2.5-coder:1.5b');
});

check('a thinking model is never the default while anything else exists', () => {
	assert.strictEqual(
		pickDefaultModel(['logic:latest', 'llama3:8b'], { 'logic:latest': 7.6, 'llama3:8b': 8 }, { 'logic:latest': true }),
		'llama3:8b',
	);
});

check('the server saying "thinking" beats a name that gives nothing away', () => {
	// logic:latest is a reasoning model under a custom tag; only the capability list knows.
	assert.strictEqual(pickDefaultModel(['logic:latest', 'qwen2.5:1.5b'], {}, { 'logic:latest': true }), 'qwen2.5:1.5b');
});

check('with no capability list, a thinker is still recognised by its name', () => {
	assert.strictEqual(pickDefaultModel(['qwen3:4b', 'qwen2.5-coder:7b']), 'qwen2.5-coder:7b');
	assert.strictEqual(pickDefaultModel(['nvidia/nemotron-3-nano-4b', 'qwen2.5-coder-1.5b-instruct']), 'qwen2.5-coder-1.5b-instruct');
});

check('coder-tuned beats general at the same footing', () => {
	assert.strictEqual(pickDefaultModel(['qwen2.5:1.5b', 'qwen2.5-coder:1.5b']), 'qwen2.5-coder:1.5b');
});

check('smaller wins among coders, because it answers', () => {
	assert.strictEqual(pickDefaultModel(['qwen2.5-coder:7b', 'qwen2.5-coder:1.5b']), 'qwen2.5-coder:1.5b');
});

check('below 1B is passed over while something bigger exists', () => {
	assert.strictEqual(pickDefaultModel(['qwen2.5-coder:0.5b', 'qwen2.5-coder:3b']), 'qwen2.5-coder:3b');
});

check('a thinking model is still used when it is all there is', () => {
	assert.strictEqual(pickDefaultModel(['qwen3:4b'], {}, { 'qwen3:4b': true }), 'qwen3:4b');
});

check('embedding models are never picked', () => {
	assert.strictEqual(pickDefaultModel(['nomic-embed-text:latest', 'llama3:8b']), 'llama3:8b');
	assert.strictEqual(pickDefaultModel(['nomic-embed-text:latest']), undefined);
});

check('an unsized name is still better than a dead panel', () => {
	assert.strictEqual(pickDefaultModel(['some-local-build']), 'some-local-build');
});

check('modelThinks reads the server, then the name', () => {
	assert.strictEqual(modelThinks({ thinking: { 'logic:latest': true } }, 'logic:latest'), true);
	assert.strictEqual(modelThinks({ thinking: { 'qwen3:4b': false } }, 'qwen3:4b'), false);
	assert.strictEqual(modelThinks(undefined, 'qwen3:4b'), true);
	assert.strictEqual(modelThinks(undefined, 'qwen2.5-coder:1.5b'), false);
});

// --- picking across both servers ---------------------------------------------

check('the better model wins even when it is on the second server', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: ['nvidia/nemotron-3-nano-4b'], sizes: {} },
			{ provider: 'ollama', models: ['qwen2.5-coder:1.5b'], sizes: {} },
		]),
		{ provider: 'ollama', model: 'qwen2.5-coder:1.5b' },
	);
});

check('capabilities reported by one server count for the choice', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'ollama', models: ['logic:latest', 'qwen2.5:1.5b'], sizes: {}, thinking: { 'logic:latest': true } },
		]),
		{ provider: 'ollama', model: 'qwen2.5:1.5b' },
	);
});

check('on a tie Ollama wins, because only Ollama can be warmed up', () => {
	assert.deepStrictEqual(
		pickDefaultServer([
			{ provider: 'lmstudio', models: ['qwen2.5-coder:1.5b'], sizes: {} },
			{ provider: 'ollama', models: ['qwen2.5-coder:1.5b'], sizes: {} },
		]),
		{ provider: 'ollama', model: 'qwen2.5-coder:1.5b' },
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

check('nothing running, nothing chosen', () => {
	assert.strictEqual(pickDefaultServer([]), undefined);
	assert.strictEqual(pickDefaultServer(undefined), undefined);
	assert.strictEqual(pickDefaultServer([{ provider: 'ollama', models: [], sizes: {} }]), undefined);
});

// --- every request ends --------------------------------------------------------
// A fake Ollama that misbehaves in each of the ways a real one does. Limits are
// shrunk so the test takes seconds; the logic is the same at full size.

const LIMITS = { loadMs: 600, stallMs: 600, totalMs: 3000 };
const frame = obj => `${JSON.stringify(obj)}\n`;

/** Starts a server whose /api/chat does whatever `behave(res)` does. */
function fake(behave) {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			req.resume();
			behave(res);
		});
		server.listen(0, '127.0.0.1', () => {
			resolve({ server, endpoint: `http://127.0.0.1:${server.address().port}` });
		});
	});
}

async function ask(behave, extra = {}) {
	const { server, endpoint } = await fake(behave);
	const phases = [];
	try {
		const result = await chat({
			provider: 'ollama', model: 'test-model', endpoint,
			messages: [{ role: 'user', content: 'hi' }],
			limits: LIMITS,
			onStatus: phase => phases.push(phase),
			...extra,
		});
		return { result, phases };
	} catch (err) {
		return { err, phases };
	} finally {
		server.closeAllConnections?.();
		server.close();
	}
}

await checkAsync('a normal stream returns the text', async () => {
	const { result, err } = await ask(res => {
		res.write(frame({ message: { content: 'O(n)' } }));
		res.end(frame({ message: { content: ' time.' }, done: true, done_reason: 'stop' }));
	});
	assert.ifError(err);
	assert.strictEqual(result.text, 'O(n) time.');
	assert.strictEqual(result.truncated, false);
});

await checkAsync('nothing listening is reported as not running, at once', async () => {
	const t0 = Date.now();
	const err = await chat({
		provider: 'ollama', model: 'm', endpoint: 'http://127.0.0.1:9',
		messages: [], limits: LIMITS,
	}).then(() => undefined, e => e);
	assert.strictEqual(err?.kind, 'offline');
	assert.ok(Date.now() - t0 < 2000, 'took too long to notice nothing was there');
});

await checkAsync('a server that never replies times out, it does not wait for ever', async () => {
	const { err, phases } = await ask(() => { /* accept, then say nothing */ });
	assert.strictEqual(err?.kind, 'timeout');
	assert.match(err.message, /No reply from test-model/);
	assert.ok(phases.includes('waiting'), 'never reported that it was waiting');
});

await checkAsync('a stream that stops part-way times out as stalled', async () => {
	const { err } = await ask(res => {
		res.write(frame({ message: { content: 'Starting to' } }));
		/* and then nothing */
	});
	assert.strictEqual(err?.kind, 'timeout');
	assert.match(err.message, /stopped responding part-way/);
});

await checkAsync('reasoning with no answer after it is an error, not a blank', async () => {
	const { err, phases } = await ask(res => {
		res.write(frame({ message: { thinking: 'let me think about this...' } }));
		res.end(frame({ message: { content: '' }, done: true }));
	});
	assert.strictEqual(err?.kind, 'empty');
	assert.ok(phases.includes('thinking'), 'never reported that it was thinking');
});

await checkAsync('an answer written entirely inside <think> tags counts as empty', async () => {
	const { err } = await ask(res => {
		res.end(frame({ message: { content: '<think>hmm</think>' }, done: true }));
	});
	assert.strictEqual(err?.kind, 'empty');
});

await checkAsync('a model that is not installed says so', async () => {
	const { err } = await ask(res => {
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: "model 'test-model' not found" }));
	});
	assert.strictEqual(err?.kind, 'missing');
	assert.match(err.message, /test-model is not installed/);
});

await checkAsync('an error inside the stream surfaces, with its message', async () => {
	const { err } = await ask(res => {
		res.end(frame({ error: 'out of memory' }));
	});
	assert.strictEqual(err?.kind, 'server');
	assert.match(err.message, /out of memory/);
});

await checkAsync('hitting the length limit is reported, not hidden', async () => {
	const { result } = await ask(res => {
		res.end(frame({ message: { content: 'a long answer' }, done: true, done_reason: 'length' }));
	});
	assert.strictEqual(result.truncated, true);
});

await checkAsync('the caller can stop a request, and it ends as stopped', async () => {
	const ctrl = new AbortController();
	setTimeout(() => ctrl.abort(), 150);
	const { err } = await ask(() => { /* say nothing */ }, { signal: ctrl.signal });
	assert.strictEqual(err?.kind, 'stopped');
});

await checkAsync('a thinking model is asked not to think; others are not sent the flag', async () => {
	const seen = [];
	const { server, endpoint } = await fake(() => { });
	server.removeAllListeners('request');
	server.on('request', (req, res) => {
		let body = '';
		req.on('data', c => { body += c; });
		req.on('end', () => {
			seen.push(JSON.parse(body));
			res.end(frame({ message: { content: 'ok' }, done: true }));
		});
	});
	try {
		for (const thinks of [true, false]) {
			await chat({ provider: 'ollama', model: 'm', endpoint, messages: [], limits: LIMITS, thinks });
		}
	} finally {
		server.close();
	}
	assert.strictEqual(seen[0].think, false);
	assert.ok(!('think' in seen[1]), 'sent think to a model that does not think');
	assert.strictEqual(seen[1].keep_alive, '30m');
	assert.ok(seen[1].options.num_predict > 0, 'no cap on the answer length');
});

// --- the teaching answer never shows code ------------------------------------
// The 1.5B default writes a corrected line in a code block about a third of the
// time even when told not to, so the automatic explanation removes it.

const NOTE = /A code fix was left out here - press Show the fix/;

check('a code block is replaced by a pointer to Show the fix', () => {
	const t = withoutCode('It goes one too far.\n\n```python\nfor i in range(3):\n```\n\nWhat is len(xs)?');
	assert.doesNotMatch(t, /```|range\(3\)/);
	assert.match(t, NOTE);
	assert.match(t, /It goes one too far\./);
	assert.match(t, /What is len\(xs\)\?$/);
});

check('a block still streaming in is removed from its fence on', () => {
	const t = withoutCode('Here is how:\n```py\nfor i in rang');
	assert.doesNotMatch(t, /```|rang/);
	assert.match(t, NOTE);
});

check('an answer with no code comes through untouched', () => {
	assert.strictEqual(withoutCode('No code here. What is the base case?'), 'No code here. What is the base case?');
	assert.strictEqual(withoutCode(undefined), '');
});

check('inline code is explanation, not a fix, and is kept', () => {
	assert.strictEqual(withoutCode('Line 3 reads `xs[3]`.'), 'Line 3 reads `xs[3]`.');
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
