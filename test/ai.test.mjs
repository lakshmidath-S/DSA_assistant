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
	pickDefaultModel, pickDefaultServer, modelThinks, chat, teachingOnly, FIX_LEFT_OUT, ONLY_A_FIX,
	formatTrace, buildPrompt, buildTeaching, callHistory, stripReasoning,
	SYSTEM_PROMPT, SYSTEM_PROMPT_REVEAL, TEACHING_EXAMPLE, TEACHING_RULES,
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

// --- the teaching answer never hands over the fix -----------------------------
// Measured on the 1.5B default: 21 of 24 automatic explanations gave the fix
// away - mostly in words, after a correct diagnosis, where removing code
// blocks could not reach it. These are the shapes it used.

const SUM = 'def total(nums):\n    s = 0\n    for i in range(1, len(nums)):\n        s += nums[i]\n    return s';
const only = (text, ctx = {}) => teachingOnly(text, { code: SUM, ...ctx });

check('a fix in words is cut, from its sentence on, and the cut is said', () => {
	const t = only('The loop starts at 1, so `nums[0]` is never added. To fix this, change `range(1, len(nums))` '
		+ 'to `range(len(nums))`. Then it adds all three.');
	assert.strictEqual(t, `The loop starts at 1, so \`nums[0]\` is never added.\n\n${FIX_LEFT_OUT}`);
});

check('each shape of handing it over is caught', () => {
	for (const fix of [
		"Here's how you can do it:",
		'You should check if the key exists before incrementing.',
		'You need to add a check before the loop.',
		'Change line 3 so that it starts at zero.',
		'This can be fixed by starting at zero.',
		'The correct way to do this is with a dictionary.',
		'Consider using a set instead.',
		'The loop should start from `i = 0`, not `i = 1`.',
		'Here is the corrected code:',
	]) {
		const t = only(`It skips the first item. ${fix} More after.`);
		assert.strictEqual(t, `It skips the first item.\n\n${FIX_LEFT_OUT}`, fix);
	}
});

check('saying what a value should have been is not a fix, and is kept', () => {
	const keep = [
		'It should return `"AB"`, but it returns `"BA"`.',
		'`s` should end at 12, and it ends at 9.',
		'It appends B before A, so the result is "BA" instead of "AB".',
		'The value of `nums[0]` should be added too.',
	];
	for (const sentence of keep) {
		assert.strictEqual(only(sentence), sentence, sentence);
	}
});

check('a block of new code is cut, with the sentence leading into it', () => {
	const t = only('It never adds nums[0]. Change it to:\n```python\nfor i in range(len(nums)):\n```\nNow it works.');
	assert.strictEqual(t, `It never adds nums[0].\n\n${FIX_LEFT_OUT}`);
});

check('a block that only quotes their own code is pointing, and stays', () => {
	const answer = 'The line that makes the answer is:\n```python\n   5 >     return s\n```\nWhat is `s` when it runs?';
	assert.strictEqual(only(answer), answer);
});

check('a block still streaming in is held back until it closes', () => {
	assert.strictEqual(only('It never adds nums[0]. Look at:\n```python\nfor i in rang'), 'It never adds nums[0]. Look at:');
});

check('the request\'s own question, repeated as a heading, is dropped; a label is taken off', () => {
	const t = only('`columnNumber` never changes. Why does the loop on line 4 never end? Ask the student: What changes it?', {
		closing: 'columnNumber = 28 never changed. Why does the loop on line 4 never end?',
	});
	assert.strictEqual(t, '`columnNumber` never changes. What changes it?');
	for (const label of ['Question:', '**Question:**', '**Question**:', 'Question for the student:']) {
		assert.strictEqual(only(`It stays 3.\n\n${label} What changes it?`), 'It stays 3.\n\nWhat changes it?', label);
	}
});

check('an answer that was nothing but the fix says so, rather than showing nothing', () => {
	assert.strictEqual(only('To fix this, use counts.get(ch, 0) + 1.'), ONLY_A_FIX);
});

check('an answer with no fix comes through untouched', () => {
	const answer = 'It calls `nums.append(x)` 3.5 times.\n\nSecond paragraph: `i` starts at 1.\n\nWhat is nums[0]?';
	assert.strictEqual(only(answer), answer);
	assert.strictEqual(teachingOnly(undefined), '');
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

const TWO_SUM = [
	'def two_sum(nums, target):',
	'    seen = {}',
	'    for i, n in enumerate(nums):',
	'        want = target - n',
	'        if want in seen:',
	'            return [i, seen[want]]',
	'        seen[n] = i',
].join('\n');

// A wrong answer is put as the two answers and how each value moved while the
// call that made it ran: the 1.5B retells recorded values well, and named the
// cause of a reversed answer in about 6 of 8 this way against 2 of 6 when it
// was handed the steps one by one beside the problem statement.
check('a wrong answer is retold as each value\'s history, and the line that returned it', () => {
	const prompt = buildPrompt({ code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace });
	assert.doesNotMatch(prompt, /MIDDLE of the run|EVERY STEP/);
	assert.match(prompt, /^A student's code printed the wrong answer\.\n\nEXPECTED: \[0, 1\]\nPRINTED: \[1, 0\]\n/);
	assert.ok(prompt.includes([
		'RECORDED WHILE IT RAN (exact values, in order):',
		'  nums: [2, 7, 11, 15]',
		'  target: 9',
		'  i: 0',
		'  n: 2',
		'  want: 7',
		'Line 6 (return [i, seen[want]]) returned [1, 0].',
	].join('\n')), prompt);
	assert.match(prompt, /The expected answer and the test input are both correct\./);
});

check('a value that moved is shown moving, with both ends of a long run kept', () => {
	const steps = [{ line: 1, fn: 'count', d: 2, vars: { n: '0' } }];
	for (let k = 1; k <= 20; k++) {
		steps.push({ line: 3, fn: 'count', d: 2, vars: { n: String(k) } });
	}
	steps.push({ line: 4, fn: 'count', d: 2, r: 1, ret: '20' });
	const story = callHistory({ steps });
	assert.deepStrictEqual(story.names, [['n', steps.slice(0, 21).map(s => s.vars.n)]]);
	const prompt = buildPrompt({ code: 'x\n', expected: '21', stdout: '20', trace: { steps } });
	assert.match(prompt, /\n {2}n: 0 -> 1 -> 2 -> \.\.\. -> 17 -> 18 -> 19 -> 20\n/);
});

// The lesson from the crash values, applied to the traced ones: a model reads
// the closing instruction hardest, so both answers have to be in it.
check('the closing asks for the walk to the answer it got, then one question - not the fix', () => {
	const prompt = buildPrompt({ code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace });
	assert.strictEqual(prompt.trimEnd().split('\n').pop(), 'Using only these recorded values, explain step by step '
		+ 'how the code ends up with [1, 0] instead of [0, 1]. Then ask the student one question that points at the '
		+ 'cause. Do not say how to fix it.');
});

check('a wrong answer leaves out the problem statement; it was measured as a distraction', () => {
	const prompt = buildPrompt({
		code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace, problem: 'Return the indices in ascending order.',
	});
	assert.doesNotMatch(prompt, /THE PROBLEM THEY ARE SOLVING|ascending order|Answer against the problem/);
});

check('a run with nothing to compare is judged against the problem statement', () => {
	const prompt = buildPrompt({ code: 'x = 1\n', stdout: '[1, 0]', problem: 'Return the indices in ascending order.' });
	assert.match(prompt, /THE PROBLEM THEY ARE SOLVING/);
	assert.match(prompt, /Return the indices in ascending order\./);
	assert.match(prompt.trimEnd().split('\n').pop(), /^Is this output correct\? Answer against the problem statement/);
});

check('no problem statement, no mention of one', () => {
	const prompt = buildPrompt({ code: 'x = 1\n', stdout: '[1, 0]' });
	assert.doesNotMatch(prompt, /THE PROBLEM THEY ARE SOLVING/);
	assert.doesNotMatch(prompt, /Answer against the problem statement/);
});

// Each case calls the method once, in order; the history must be of the call
// that came back wrong, or the model explains a case that was right.
const CASES_TRACE = {
	steps: [
		{ line: 1, fn: '<module>', d: 1 },
		{ line: 3, fn: 'convertToTitle', d: 3, vars: { columnNumber: '1' } },
		{ line: 6, fn: 'convertToTitle', d: 3, r: 1, ret: '"A"' },
		{ line: 3, fn: 'convertToTitle', d: 3, vars: { columnNumber: '28' } },
		{ line: 4, fn: 'convertToTitle', d: 3, vars: { ans: '[]' } },
		{ line: 5, fn: 'convertToTitle', d: 3, vars: { ans: "['B']", columnNumber: '27' } },
		{ line: 5, fn: 'convertToTitle', d: 3, vars: { ans: "['B', 'A']", columnNumber: '0' } },
		{ line: 6, fn: 'convertToTitle', d: 3, r: 1, ret: '"BA"' },
	],
};

check('a Solution\'s history is of the case that came back wrong', () => {
	const story = callHistory(CASES_TRACE, { method: 'convertToTitle', caseIndex: 1 });
	assert.deepStrictEqual(story.names, [
		['columnNumber', ['28', '27', '0']],
		['ans', ['[]', "['B']", "['B', 'A']"]],
	]);
	assert.deepStrictEqual(story.returned, { line: 6, value: '"BA"' });
	assert.deepStrictEqual(callHistory(CASES_TRACE, { method: 'convertToTitle' }).names, [['columnNumber', ['1']]]);
	assert.strictEqual(callHistory(CASES_TRACE, { method: 'convertToTitle', caseIndex: 2 }), undefined);
});

check('no history at all rather than one of the wrong call', () => {
	// The middle was dropped before this call ended: its count, and its own
	// middle, are unknown.
	const dropped = { ...CASES_TRACE, dropped: 40, gapAt: 4 };
	assert.strictEqual(callHistory(dropped, { method: 'convertToTitle', caseIndex: 1 }), undefined);
	assert.ok(callHistory(dropped, { method: 'convertToTitle', caseIndex: 0 }), 'a call wholly before the gap is known');
	// Recording stopped early: the last call seen is not the one that answered.
	assert.strictEqual(callHistory({ ...trace, truncated: true }), undefined);
	assert.strictEqual(callHistory(undefined), undefined);
});

// A design bug is a call that answered right and left the object wrong, so
// the object between calls is the evidence.
check('a wrong design case is told call by call, with the object after each', () => {
	const steps = [
		{ op: 'MinStack', args: '', shown: 'null', expected: 'null', state: { 'self.s': '[]', 'self.mins': '[]' } },
		{ op: 'push', args: '-3', shown: 'null', expected: 'null', state: { 'self.s': '[-3]', 'self.mins': '[-3]' } },
		{ op: 'getMin', args: '', shown: '-3', expected: '-3', state: { 'self.s': '[-3]', 'self.mins': '[-3]' } },
		{ op: 'pop', args: '', shown: 'null', expected: 'null', state: { 'self.s': '[]', 'self.mins': '[-3]' } },
		{ op: 'push', args: '5', shown: 'null', expected: 'null', state: { 'self.s': '[5]', 'self.mins': '[-3]' } },
		{ op: 'getMin', args: '', shown: '-3', expected: '5', state: { 'self.s': '[5]', 'self.mins': '[-3]' } },
		{ op: 'top', args: '', shown: '5', expected: '5', state: { 'self.s': '[5]', 'self.mins': '[-3]' } },
	];
	const prompt = buildPrompt({
		code: 'class MinStack:\n    pass\n', expected: '5', returned: '-3', method: 'getMin',
		call: 'getMin() - call 6 of 7', calls: [{ ops: steps }], design: { steps, first: 5, fits: true },
		trace: { steps: [{ line: 2, fn: 'getMin', d: 2, vars: { x: '1' } }] },
	});
	assert.ok(prompt.includes([
		'RECORDED WHILE IT RAN (each call, what it returned, and the object after it):',
		'  1. MinStack() -> then self.s = [], self.mins = []',
		'  2. push(-3) -> then self.s = [-3], self.mins = [-3]',
		'  3. getMin() returned -3',
		'  4. pop() -> then self.s = [], self.mins = [-3]',
		'  5. push(5) -> then self.s = [5], self.mins = [-3]',
		'  6. getMin() returned -3, expected 5',
		'',
	].join('\n')), prompt);
	assert.doesNotMatch(prompt, /top\(\)|THIS IS WHAT ACTUALLY HAPPENED/, 'nothing after the wrong call, and not the raw steps too');
	assert.match(prompt.trimEnd().split('\n').pop(), /^Using only these recorded values, explain step by step how the code ends up with -3 instead of 5\./);
});

check('a method that sorts in place has no return to tell; its argument is the answer', () => {
	const code = 'class Solution:\n    def sortColors(self, nums):\n        nums[0], nums[1] = nums[1], nums[0]\n';
	const steps = [
		{ line: 3, fn: 'sortColors', d: 3, vars: { nums: '[1, 2]' } },
		{ line: 3, fn: 'sortColors', d: 3, r: 1, ret: 'None', vars: { nums: '[2, 1]' } },
	];
	const prompt = buildPrompt({
		code, expected: '[1, 2]', method: 'sortColors', inPlace: 'nums',
		call: 'sortColors(nums = [1, 2])', returned: 'nums = [2, 1]', trace: { steps },
	});
	assert.match(prompt, /RECORDED WHILE IT RAN \(exact values, in order\):\n {2}nums: \[1, 2\] -> \[2, 1\]\n\n/);
	assert.doesNotMatch(prompt, /returned None/);
});

// A Solution prints nothing; its answer is what one call returned. Told it
// "printed the wrong answer" and shown an empty stdout, a model explains why
// nothing was printed - which is not the bug.
const SOLUTION_CODE = [
	'class Solution:',
	'    def convertToTitle(self, columnNumber: int) -> str:',
	'        ans = []',
	'        while columnNumber > 0:',
	'            ans.append(chr(65 + (columnNumber - 1) % 26))',
	'        return "".join(ans)',
].join('\n');

check('a wrong answer from a Solution is put as a call and what it returned', () => {
	const prompt = buildPrompt({
		code: SOLUTION_CODE, expected: '"AB"', stdout: '', method: 'convertToTitle',
		call: 'convertToTitle(columnNumber = 28)', returned: '"BA"',
	});
	assert.match(prompt, /^A student's code returned the wrong answer\.\n\nTHE CALL: convertToTitle\(columnNumber = 28\)\nEXPECTED: "AB"\nRETURNED: "BA"\n/);
	assert.doesNotMatch(prompt, /PRINTED/);
	// Nothing was recorded, so it is not told to use recorded values.
	assert.strictEqual(prompt.trimEnd().split('\n').pop(), 'Explain step by step how the code ends up with "BA" '
		+ 'instead of "AB". Then ask the student one question that points at the cause. Do not say how to fix it.');
});

check('an answer over several lines is fenced, so its lines stay apart', () => {
	const prompt = buildPrompt({ code: 'x\n', expected: '1\n2', stdout: '1\n3' });
	assert.match(prompt, /EXPECTED:\n```\n1\n2\n```\nPRINTED:\n```\n1\n3\n```/);
	assert.match(prompt.trimEnd().split('\n').pop(), /ends up with that output instead of the expected one\./);
});

check('a checked difference is stated; Show the fix asks the plain question, led by it', () => {
	const facts = {
		code: SOLUTION_CODE, expected: '"AB"', method: 'convertToTitle',
		call: 'convertToTitle(columnNumber = 28)', returned: '"BA"',
		difference: 'It is the expected answer reversed: the right characters, in the opposite order.',
	};
	assert.match(buildPrompt(facts), /\nCHECKED: It is the expected answer reversed/);
	assert.match(buildPrompt({ ...facts, reveal: true }).trimEnd().split('\n').pop(),
		/^It is the expected answer reversed.* Why does convertToTitle\(columnNumber = 28\) return "BA" instead of "AB"\?$/);
});

check('the worked example goes only with a crash; the rules block not with a wrong answer', () => {
	const wrong = buildTeaching({ code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace });
	assert.deepStrictEqual(wrong.messages.map(m => m.role), ['system', 'user']);
	assert.strictEqual(wrong.messages[0].content, SYSTEM_PROMPT);
	assert.ok(!wrong.messages[1].content.endsWith(TEACHING_RULES));
	assert.strictEqual(wrong.closing, wrong.messages[1].content.split('\n').pop());

	const crash = buildTeaching({ code: 'x = [1]\nprint(x[1])\n', parsed: { raw: 'IndexError: list index out of range', primary: { line: 2 } } });
	assert.deepStrictEqual(crash.messages.slice(1, -1), TEACHING_EXAMPLE);
	assert.ok(crash.messages.at(-1).content.endsWith(TEACHING_RULES));

	const reveal = buildTeaching({ code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace }, { reveal: true });
	assert.deepStrictEqual(reveal.messages.map(m => m.role), ['system', 'user']);
	assert.strictEqual(reveal.messages[0].content, SYSTEM_PROMPT_REVEAL);
});

check('a teaching answer is cleaned of the fix; Show the fix keeps it', () => {
	const facts = { code: TWO_SUM, expected: '[0, 1]', stdout: '[1, 0]', trace };
	const answer = '<think>hm</think>`i` is 1 when it returns. To fix this, swap the two. What is `seen[want]`?';
	assert.strictEqual(buildTeaching(facts).clean(answer), `\`i\` is 1 when it returns.\n\n${FIX_LEFT_OUT}`);
	assert.strictEqual(buildTeaching(facts, { reveal: true }).clean(answer), stripReasoning(answer));
});

check('a stuck loop is put as the facts the watchdog saw', () => {
	const prompt = buildPrompt({
		code: SOLUTION_CODE,
		loop: {
			seconds: 5, stuck: true, case: 'convertToTitle(columnNumber = 28)', line: 5,
			loop: { line: 4, kind: 'while', condition: 'columnNumber > 0', names: ['columnNumber'] },
			function: 'convertToTitle', locals: { columnNumber: '28', ans: "['B', 'B', 'B']" },
			changed: ['ans'], watched: ['columnNumber'],
		},
	});
	assert.match(prompt, /stuck in a loop that cannot end/);
	assert.match(prompt, /WHOSE CONDITION IS: columnNumber > 0/);
	assert.match(prompt, /columnNumber = 28 {3}\(did NOT change\)/);
	assert.match(prompt, /ans = \['B', 'B', 'B'\] {3}\(was changing\)/);
	assert.match(prompt, / {3}4 > {9}while columnNumber > 0:/, 'the loop line is marked');
	assert.doesNotMatch(prompt, /PYTHON REPORTED THIS ERROR/);
	assert.match(prompt.trimEnd().split('\n').pop(), /^columnNumber = 28 never changed\. Why does the loop on line 4 never end\?$/);
});

check('a loop that was still changing is not called infinite', () => {
	const prompt = buildPrompt({
		code: 'i = 0\nwhile i >= 0:\n    i += 1\n',
		loop: {
			seconds: 12, stuck: false, line: 3,
			loop: { line: 2, kind: 'while', condition: 'i >= 0', names: ['i'] },
			function: '<module>', locals: { i: '81234567' }, changed: ['i'], watched: ['i'],
		},
	});
	assert.match(prompt, /may be very slow, or it may never end/);
	assert.doesNotMatch(prompt, /cannot end|can never become false/);
	assert.match(prompt.trimEnd().split('\n').pop(), /not finished after 12 seconds/);
});

check('a crash inside a Solution names the test case it was given', () => {
	const prompt = buildPrompt({
		code: SOLUTION_CODE,
		parsed: { raw: 'IndexError: list index out of range', primary: { line: 5 } },
		failed: 'convertToTitle(columnNumber = 0)',
	});
	assert.match(prompt, /IT WAS RUNNING THIS TEST CASE: convertToTitle\(columnNumber = 0\)/);
});

console.log(`\n${failed ? `${failed} failed` : 'all model and prompt cases passed'}`);
process.exit(failed ? 1 : 0);
