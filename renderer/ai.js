/*---------------------------------------------------------------------------------------------
 *  myIDE - talking to a local model.
 *
 *  Ported from the fork's lmStudioClient/ollamaClient, minus the workbench's
 *  request service: in a renderer we can just use fetch, and both providers
 *  stream.
 *
 *  The important change is not the transport, it is the prompt. The old build
 *  told the model "you are given the REAL runtime state" and then, when the
 *  program had run to completion rather than stopping at a breakpoint, handed
 *  it source code only. Asked to explain a failure it could not see, a 7B model
 *  duly invented one - it claimed a conditional expression was missing a colon.
 *
 *  So: we never ask the model to find the bug. Python has already found it. We
 *  give it the traceback and ask it to explain that, which small models do
 *  well.
 *
 *  And we never ask it for the fix. The app exists to make its reader better at
 *  DSA, and being handed a corrected line skips the part that does that. The
 *  answer is available behind a button; it is not the default.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Newline, named so the templates above do not need an escape inline. */
const NL = String.fromCharCode(10);

export const PROVIDERS = {
	lmstudio: { label: 'LM Studio', endpoint: 'http://127.0.0.1:1234' },
	ollama: { label: 'Ollama', endpoint: 'http://127.0.0.1:11434' },
};

/** Reasoning models wrap their scratchpad in <think>; show the answer, not the working. */
export function stripReasoning(text) {
	if (!text) {
		return '';
	}
	return text
		.replace(/<think>[\s\S]*?<\/think>/g, '')
		// A response still streaming has an unterminated block; drop the tail.
		.replace(/<think>[\s\S]*$/, '')
		.trim();
}

/**
 * Names that mark a model as one that reasons privately before answering.
 *
 * Only a fallback. Ollama reports this outright - `capabilities` includes
 * "thinking" - and that is what listModels uses. LM Studio's listing carries an
 * id and nothing else, so for its models the name is all there is.
 */
const THINKER_NAME = /qwen3|deepseek-r1|-r1\b|qwq|nemotron|nanbeige|magistral|reason|think|gpt-oss/i;

/** A size in billions read out of a model name, e.g. "qwen2.5-coder:1.5b" -> 1.5. */
function sizeFromName(id) {
	const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id ?? '');
	return m ? Number(m[1]) : undefined;
}

/**
 * The model to answer with when nobody has chosen one.
 *
 * Small, coder-tuned, and above all not a model that thinks before it writes.
 * Measured on the machine this was built for (RTX 3050, 4 GB), asking the same
 * complexity question through the app's own prompt:
 *
 *   qwen2.5-coder:1.5b   1.4s warm, first word at 0.5s, answer correct
 *   qwen3:4b            30s warm, first word at 24s
 *   logic:latest (7.6B)  58s warm, first word at 43s, answered a different question
 *
 * The two slow ones spend most of that time reasoning privately, and with the
 * reasoning hidden that looked exactly like nothing happening - which is how
 * this app came to feel broken. An earlier version defaulted to the 7.6B on the
 * grounds that its answers were more careful. They were, when they arrived. A
 * model that answers every time beats one that seems not to work; Settings is
 * there for anyone with the hardware and the patience for more.
 *
 * Ranking, in order: does not think, is coder-tuned, is at least 1B (anything
 * smaller struggles to follow the prompt at all), then smallest.
 */
export function pickDefaultModel(models, sizes = {}, thinking = {}) {
	const usable = (models ?? [])
		.filter(m => !/embed/i.test(m))
		.map(model => {
			const b = sizes[model] ?? sizeFromName(model);
			return {
				model,
				thinks: thinking[model] ?? THINKER_NAME.test(model),
				coder: /coder|code/i.test(model),
				tiny: b !== undefined && b < 1,
				// Unknown sizes sort after every known one: a guess should not
				// beat a model we can measure.
				b: b ?? Number.POSITIVE_INFINITY,
			};
		});

	usable.sort((x, y) =>
		Number(x.thinks) - Number(y.thinks)
		|| Number(y.coder) - Number(x.coder)
		|| Number(x.tiny) - Number(y.tiny)
		|| x.b - y.b);

	return usable[0]?.model;
}

/**
 * The same choice, made across every server that answered. Returns which
 * server owns the winner, because that is what a request is addressed to.
 */
export function pickDefaultServer(servers) {
	// On a tie Ollama wins: it can be told to load the model before the first
	// question and keep it loaded, and LM Studio cannot - its first answer
	// always pays the load. The sort below is stable, so order is the tiebreak.
	const stocked = (servers ?? [])
		.filter(s => s.models?.length)
		.sort((a, b) => Number(b.provider === 'ollama') - Number(a.provider === 'ollama'));
	if (!stocked.length) {
		return undefined;
	}

	const names = [];
	const sizes = {};
	const thinking = {};
	for (const server of stocked) {
		for (const name of server.models) {
			names.push(name);
			if (!(name in sizes) && server.sizes?.[name] !== undefined) {
				sizes[name] = server.sizes[name];
			}
			if (!(name in thinking) && server.thinking?.[name] !== undefined) {
				thinking[name] = server.thinking[name];
			}
		}
	}

	const model = pickDefaultModel(names, sizes, thinking);
	if (!model) {
		return undefined;
	}
	return { provider: stocked.find(s => s.models.includes(model)).provider, model };
}

/** Whether a model reasons privately before answering, by what the server said or its name. */
export function modelThinks(server, model) {
	return server?.thinking?.[model] ?? THINKER_NAME.test(model ?? '');
}

/**
 * The installed models, as `{ name, params, thinks }`.
 *
 * `params` is the size in billions where the server says so, otherwise
 * undefined. `thinks` comes from Ollama's own capability list, one /api/show per
 * model, asked in parallel and each given a short deadline: a model whose
 * details cannot be read is reported anyway, falling back to its name.
 */
export async function listModels(provider) {
	const { endpoint } = PROVIDERS[provider];
	const quick = ms => AbortSignal.timeout(ms);

	if (provider === 'ollama') {
		const res = await fetch(`${endpoint}/api/tags`, { signal: quick(4000) });
		const json = await res.json();
		const models = json.models ?? [];

		return Promise.all(models.map(async m => {
			let thinks;
			try {
				const show = await fetch(`${endpoint}/api/show`, {
					method: 'POST',
					signal: quick(4000),
					body: JSON.stringify({ model: m.name }),
				}).then(r => r.json());
				thinks = Array.isArray(show.capabilities) ? show.capabilities.includes('thinking') : undefined;
			} catch {
				thinks = undefined;
			}
			return {
				name: m.name,
				params: sizeFromName(m.details?.parameter_size),
				thinks: thinks ?? THINKER_NAME.test(m.name),
			};
		}));
	}

	// LM Studio's OpenAI-compatible listing carries an id and nothing else.
	const res = await fetch(`${endpoint}/v1/models`, { signal: quick(4000) });
	const json = await res.json();
	return (json.data ?? []).map(m => ({
		name: m.id,
		params: sizeFromName(m.id),
		thinks: THINKER_NAME.test(m.id),
	}));
}

/*
 * The teaching prompt, and the default.
 *
 * The point of this app is to get better at DSA, not to receive working
 * solutions faster. Handing over a corrected line removes the one part that
 * actually builds skill - working out why your own reasoning was wrong.
 *
 * It is short, and it comes with one worked example, because the default model
 * is a 1.5B and a 1.5B follows short concrete instructions and copies examples;
 * a long list of rules it mostly ignores. Measured on three common crashes,
 * three answers each: the longer rule list this replaced gave away the fix in
 * 9 of 9 and never ended with a question. This shape, with the rules repeated
 * at the very end of the request, cut that to 4 of 9. The rest is enforced
 * mechanically - see withoutCode() - because "usually" is not good enough for
 * the one thing the app exists to do.
 */
export const SYSTEM_PROMPT = [
	'You are a tutor for a student learning data structures and algorithms.',
	'Explain their bug so they can fix it themselves.',
	'Never write code. Never show a corrected line.',
	'Reply in at most 4 sentences, then ask the student one question.',
].join(NL);

/** One worked exchange, on a different bug, so the model sees the shape of a good answer. */
export const TEACHING_EXAMPLE = [
	{
		role: 'user',
		content: [
			'PYTHON REPORTED THIS ERROR:',
			'```',
			'Traceback (most recent call last):',
			'  File "main.py", line 3, in <module>',
			'    print(nums[len(nums)])',
			'IndexError: list index out of range',
			'```',
			'THE FAILING LINE IS 3.',
			'What is going wrong here, and why?',
		].join(NL),
	},
	{
		role: 'assistant',
		content: 'Line 3 asks for `nums[len(nums)]`. A list of length 4 has positions 0 to 3, '
			+ 'so `len(nums)` is one past the last position, and there is nothing there to read. '
			+ 'The idea that does not hold is that the length is also a valid index. '
			+ 'What is the largest index this list actually has?',
	},
];

/** Repeated at the very end of the request, where a small model reads hardest. */
export const TEACHING_RULES = [
	'',
	'',
	'Reply rules: explain the mistake in plain words, at most 4 sentences.',
	'Do NOT write any code or a corrected line.',
	'Your LAST sentence must be one question for the student.',
].join(NL);

/**
 * Takes fenced code out of a teaching answer.
 *
 * The model is told not to write the fix, and a 1.5B often does anyway - a
 * corrected line in a code block is the commonest way. Removing the block, and
 * saying where it went, keeps the explanation and keeps the answer behind
 * "Show the fix" where it was meant to be. An unclosed fence - an answer still
 * streaming, or cut short - is removed from the fence to the end.
 */
export function withoutCode(text) {
	const NOTE = '(A code fix was left out here - press Show the fix if you want to see it.)';
	return String(text ?? '')
		.replace(/```[^\n]*\n[\s\S]*?```/g, NOTE)
		.replace(/```[\s\S]*$/, NOTE)
		.trim();
}

/**
 * Used only when the reader presses "Show the fix". Kept deliberately separate
 * so the default answer can never drift back into handing over the solution.
 */
export const SYSTEM_PROMPT_REVEAL = [
	'You are helping someone learning data structures and algorithms who has',
	'looked at the problem and asked to be shown the fix.',
	'',
	'Work only from the traceback, or the expected and actual output, you are given.',
	'',
	'Rules:',
	'- Give the corrected line or lines, and nothing more of the solution.',
	'- Follow it with one sentence on why the original was wrong.',
	'- Under 80 words. No preamble.',
].join('\n');

/**
 * The recorded path, as something a model can read.
 *
 * Only the tail: the end of a run is where a wrong answer is produced, and the
 * beginning is usually setup. When the recording hit its cap the steps shown
 * are from the middle of a longer run, and saying so matters - a model handed
 * the last recorded step silently would treat it as the end of the program and
 * explain a program that stopped there.
 */
export function formatTrace(trace, limit = 24) {
	const steps = trace?.steps ?? [];
	if (!steps.length) {
		return '';
	}

	const shown = steps.slice(-limit);
	const from = steps.length - shown.length;
	const lines = [];
	let frame = '';

	for (const [offset, step] of shown.entries()) {
		// The seam between the recorded opening and the recorded ending. Shown
		// where it falls, because a silent jump from the second iteration to
		// the fifteen-thousandth reads as a loop that ran twice.
		if (trace.dropped && from + offset === trace.gapAt) {
			lines.push(`  ... ${trace.dropped} steps not recorded ...`);
			frame = '';
		}

		const here = `${step.fn}#${step.d}`;
		if (here !== frame) {
			frame = here;
			lines.push(step.fn === '<module>' ? 'in the file itself:' : `in ${step.fn}():`);
		}

		const where = `  line ${String(step.line).padStart(3)}`;
		if (step.ret !== undefined) {
			lines.push(`${where}  returned ${step.ret}`);
		} else if (step.r) {
			lines.push(`${where}  ${step.fn === '<module>' ? 'end of the file' : 'left without returning a value'}`);
		} else if (step.exc) {
			lines.push(`${where}  raised ${step.exc}`);
		} else if (step.vars) {
			lines.push(`${where}  ${Object.entries(step.vars).map(([k, v]) => `${k} = ${v}`).join(', ')}`);
		} else {
			lines.push(where);
		}
	}

	return lines.join(NL);
}

/** How the trace should be introduced, given what was left out of it. */
function traceHeading(trace, shownCount) {
	const total = trace.steps.length;
	const dropped = trace.dropped ?? 0;

	if (trace.truncated) {
		return [
			'THIS IS WHAT ACTUALLY HAPPENED, STEP BY STEP - but recording stopped',
			'before the program did, so these steps are from the MIDDLE of the run.',
			'Do not say the program ended here.',
		].join(NL);
	}

	// The middle was dropped to keep the recording small. Saying so matters as
	// much as the truncation warning: without it the jump from the opening to
	// the closing steps reads as one continuous run, and a loop that ran
	// fifteen thousand times looks like it ran twice.
	if (dropped) {
		return [
			'THIS IS WHAT ACTUALLY HAPPENED. The opening and the ending are',
			`recorded exactly, but ${dropped} steps in the MIDDLE were dropped and are`,
			'marked below. The run did reach its end; the gap is missing detail,',
			'not a missing ending.',
		].join(NL);
	}

	if (shownCount < total) {
		return `THIS IS WHAT ACTUALLY HAPPENED - the last ${shownCount} of ${total} steps, ending where the program did:`;
	}
	return 'THIS IS WHAT ACTUALLY HAPPENED, EVERY STEP OF THE RUN:';
}

/**
 * The problem the code is meant to solve, when the reader has pasted it.
 *
 * Without it the model has only the code to infer intent from, which is
 * circular - the code is the thing that is wrong. With it, "your output
 * differs" can become "the problem asks for the indices in ascending order".
 */
function problemBlock(problem) {
	const text = (problem ?? '').trim();
	if (!text) {
		return [];
	}
	return [
		'THE PROBLEM THEY ARE SOLVING, in their own words or pasted from the site:',
		'```', text.slice(0, 4000), '```',
		'This is what the code is SUPPOSED to do. Judge the code against this, not',
		'against what the code appears to be trying to do.',
		'',
	];
}

/**
 * Builds the user message. Everything here is fact: the traceback came from
 * Python, the source is what ran, the output is what it printed, and the trace
 * is the path it actually took.
 */
export function buildPrompt({ code, parsed, stdout, expected, values, trace, problem, question }) {
	const parts = [...problemBlock(problem)];

	if (parsed) {
		parts.push('PYTHON REPORTED THIS ERROR:', '```', parsed.raw, '```', '');

		// The real variables at the moment it failed. This is the difference
		// between explaining and guessing: without them the model has to
		// simulate the program, and it makes arithmetic slips doing so.
		if (values?.locals && Object.keys(values.locals).length) {
			const rows = Object.entries(values.locals).map(([k, v]) => `  ${k} = ${v}`);
			parts.push(
				`THESE WERE THE ACTUAL VALUES AT THAT MOMENT, inside ${values.function}():`,
				'```', rows.join(NL), '```',
				'These were recorded from the run itself. They are not guesses and they',
				'are not examples. Quote these exact values in your explanation. Do NOT',
				'state a different value for any of these names, and do NOT say a',
				'variable "could be" something - you have been told what it was.', '',
			);
		}
		if (parsed.primary) {
			const lines = code.split('\n');
			const n = parsed.primary.line;
			// A few lines either side, so the model sees the context it needs
			// without being handed the whole file to wander through.
			const from = Math.max(1, n - 4);
			const to = Math.min(lines.length, n + 3);
			const window = [];
			for (let i = from; i <= to; i++) {
				window.push(`${String(i).padStart(4)}${i === n ? ' >' : '  '} ${lines[i - 1] ?? ''}`);
			}
			parts.push(`THE FAILING LINE IS ${n}, MARKED > BELOW:`, '```python', window.join('\n'), '```', '');
		}
	} else if (expected !== undefined) {
		// A wrong answer, not a crash. This is the common case in DSA work and
		// the one a cloud chat gets used for; the model is given both strings so
		// it compares them rather than reading the whole solution looking for
		// something to criticise.
		// Numbered, so the answer can cite a line the way the traceback path does.
		const numbered = code.split('\n')
			.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
			.join('\n');

		parts.push(
			'The program ran without crashing, but printed the wrong answer.',
			'',
			'EXPECTED:', '```', expected, '```', '',
			'ACTUALLY PRINTED:', '```', (stdout ?? '').trim() || '(nothing)', '```', '',
			'SOURCE:', '```python', numbered, '```', '',
		);

		// The run was recorded, so the model does not have to simulate the loop
		// it is being asked about - which is the step it gets wrong. Nothing
		// raised here, so there are no crash values; this is all there is.
		const steps = formatTrace(trace);
		if (steps) {
			parts.push(
				traceHeading(trace, Math.min(24, trace.steps.length)),
				'```', steps, '```',
				'Each step is a line about to run, and the names that changed since the',
				'step before it. This was recorded from the run. Quote these values; do',
				'NOT invent a different value for any name that appears here, and do not',
				'describe a path the program did not take.',
				'',
			);
		}

		parts.push(
			'The expected output and the test input are both CORRECT. The bug is in the',
			'logic, so never suggest changing the input or the expected value to match',
			'what was printed.',
			'Name the line that actually PRODUCES the wrong value - usually the one',
			'that returns or prints it - not merely a line involved in the working.',
			'Trace the real values through the loop to show how that line ends up',
			'with what was printed.',
		);
	} else {
		parts.push(
			'The program ran to completion with no error.',
			'Do NOT invent an error. If the output looks wrong, say why; otherwise say it looks correct.',
			'',
			'SOURCE:', '```python', code, '```', '',
		);
	}

	// Not in the expected-output path: that branch has already shown the output,
	// and repeating it invites the model to treat the two copies as different.
	if (expected === undefined && stdout && stdout.trim()) {
		parts.push('WHAT IT PRINTED:', '```', stdout.trim().slice(0, 2000), '```', '');
	}

	// Naming the values in the question itself, not just in the context above.
	// A 7B model reads the closing instruction hardest: given the values only
	// as context it still answered "u could be greater than or equal to n"
	// while holding u = 9, because a generic IndexError explanation is the
	// likelier continuation. Quoting them here makes hedging the harder path.
	const recorded = values?.locals
		? Object.entries(values.locals).slice(0, 6).map(([k, v]) => `${k} = ${v}`).join(', ')
		: '';

	// The same trick for the traced values, for the same reason: a model that is
	// shown a loop and asked why the answer is wrong will describe the loop it
	// expected rather than the one it was given, unless the real steps are in
	// the instruction it reads last.
	const lastStep = trace?.steps?.slice().reverse()
		.find(s => s.vars && Object.keys(s.vars).length);
	const returned = trace?.steps?.slice().reverse().find(s => s.ret !== undefined);
	const traced = lastStep
		? Object.entries(lastStep.vars).slice(0, 6).map(([k, v]) => `${k} = ${v}`).join(', ')
			+ (returned ? `, and ${returned.fn}() returned ${returned.ret}` : '')
		: '';

	const against = (problem ?? '').trim()
		? ' Answer against the problem statement, not against what the code looks like it is trying to do.'
		: '';

	const fallback = parsed
		? (recorded
			? `The recorded values were: ${recorded}. Using those exact numbers, what went wrong and why?`
			: 'What is going wrong here, and why?')
		: expected !== undefined
			? (traced
				? `By line ${lastStep.line} the recorded values were: ${traced}. Using the recorded steps, not your own reconstruction, why is the output different from what I expected?${against}`
				: `Why is the output different from what I expected?${against}`)
			: `Is this output correct?${against}`;

	parts.push(question || fallback);
	return parts.join('\n');
}

/*
 * Request limits.
 *
 * The version before these had no timeout of any kind. A model still loading,
 * one swapping out for another, or one reasoning privately for a minute all
 * looked identical from the outside - a caret that never moved - so a question
 * could sit there forever and nobody could tell whether anything was working.
 * Now every request ends: with an answer, or with a message saying why not.
 */

/** Nothing back at all. Generous, because loading a large model from disk is slow. */
const LOAD_TIMEOUT_MS = 120_000;

/** A gap between chunks once the model has started. A healthy stream never pauses this long. */
const STALL_TIMEOUT_MS = 45_000;

/** The whole answer, however it is going. */
const TOTAL_TIMEOUT_MS = 180_000;

/**
 * Long enough for any explanation the prompts ask for; short enough that a
 * rambling model stops. 450 cut one optimisation answer in three off mid-
 * sentence on a 1.5B, which ignores the word limits it is given; 600 costs at
 * most about nine seconds on a laptop GPU.
 */
export const MAX_ANSWER_TOKENS = 600;

/** Keep the model loaded between questions, so the second one does not pay to load it again. */
const KEEP_ALIVE = '30m';

/**
 * Ollama's options, shared by real requests and the warm-up. They must match:
 * Ollama reloads a model whose context size changes between requests, so a
 * warm-up with different options would load it twice.
 *
 * 4096 tokens of context covers every request the app builds - a long
 * solution, the trace, two earlier turns and the answer. 8192 doubled the
 * memory each model needs for nothing: with it, a 4B on a 4 GB card got
 * 2.3 GB of its 4.1 onto the GPU and ran the rest on the CPU.
 */
const OLLAMA_OPTIONS = { temperature: 0.2, num_ctx: 4096 };

/** A failed request, with a message a person can act on and a kind the UI can branch on. */
export class AiError extends Error {
	/**
	 * @param {'offline'|'missing'|'timeout'|'server'|'empty'|'stopped'} kind
	 * @param {string} message
	 */
	constructor(kind, message) {
		super(message);
		this.name = 'AiError';
		this.kind = kind;
	}
}

function endedBy(why, label, model, started) {
	const s = Math.round((Date.now() - started) / 1000);
	switch (why) {
		case 'stopped':
			return new AiError('stopped', 'Stopped.');
		case 'load':
			return new AiError('timeout', `No reply from ${model} after ${s}s. It may be too large for this machine - pick a smaller model in Settings.`);
		case 'stall':
			return new AiError('timeout', `${model} stopped responding part-way through, after ${s}s.`);
		default:
			return new AiError('timeout', `Gave up after ${s}s - ${model} was taking too long. A smaller model in Settings will be quicker.`);
	}
}

/**
 * One model request, with a guaranteed end.
 *
 * Resolves with the full text, or rejects with an AiError. Never neither.
 *
 * onStatus(phase, elapsedMs) reports where it has got to, and is called again
 * once a second while nothing visible is arriving, so the UI can count:
 *   'waiting'  - sent, nothing back yet (usually the model is being loaded)
 *   'thinking' - reasoning arriving, no visible answer yet
 *   'writing'  - the answer itself is arriving
 *
 * `thinks` should be true for a model that reasons before answering; for Ollama
 * that sends think:false, which most such models honour. Some do not - a
 * DeepSeek-R1 distill reasons regardless - and for those 'thinking' is at least
 * reported as it happens rather than shown as a dead caret.
 *
 * @returns {Promise<{ text: string, truncated: boolean }>}
 */
export async function chat({
	provider, model, messages, signal,
	onToken = () => { }, onStatus = () => { },
	thinks = false, maxTokens = MAX_ANSWER_TOKENS,
	// Overridable so the tests can prove each limit fires without waiting minutes.
	limits = {}, endpoint: endpointOverride,
}) {
	const { label } = PROVIDERS[provider];
	const endpoint = endpointOverride ?? PROVIDERS[provider].endpoint;
	const {
		loadMs = LOAD_TIMEOUT_MS, stallMs = STALL_TIMEOUT_MS, totalMs = TOTAL_TIMEOUT_MS,
	} = limits;
	const isOllama = provider === 'ollama';
	const started = Date.now();

	// Our own controller: a timeout and the caller's Stop both end the fetch,
	// and `why` records which, because by the time the rejection arrives the
	// two look the same.
	const ctrl = new AbortController();
	let why;
	const end = reason => {
		if (!why) {
			why = reason;
			ctrl.abort();
		}
	};
	if (signal?.aborted) {
		end('stopped');
	}
	signal?.addEventListener('abort', () => end('stopped'), { once: true });

	let phase = 'waiting';
	let lastChunk = started;
	const setPhase = next => {
		if (next !== phase) {
			phase = next;
			onStatus(phase, Date.now() - started);
		}
	};
	onStatus(phase, 0);

	// Checked four times a second so a limit fires close to when it should;
	// the status is re-reported only when the visible second changes.
	let shownSecond = 0;
	const ticker = setInterval(() => {
		const now = Date.now();
		if (now - started > totalMs) {
			end('total');
		} else if (phase === 'waiting' && now - started > loadMs) {
			end('load');
		} else if (phase !== 'waiting' && now - lastChunk > stallMs) {
			end('stall');
		}
		const second = Math.floor((now - started) / 1000);
		if (phase !== 'writing' && second !== shownSecond) {
			shownSecond = second;
			onStatus(phase, now - started);
		}
	}, 250);

	let full = '';
	let truncated = false;

	try {
		const body = isOllama
			? {
				model, messages, stream: true, keep_alive: KEEP_ALIVE,
				options: { ...OLLAMA_OPTIONS, num_predict: maxTokens },
				...(thinks ? { think: false } : {}),
			}
			: { model, messages, stream: true, temperature: 0.2, max_tokens: maxTokens };

		let res;
		try {
			res = await fetch(isOllama ? `${endpoint}/api/chat` : `${endpoint}/v1/chat/completions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				signal: ctrl.signal,
				body: JSON.stringify(body),
			});
		} catch {
			if (why) {
				throw endedBy(why, label, model, started);
			}
			// Connection refused comes back in milliseconds, so this is honest:
			// nothing is listening.
			throw new AiError('offline', `${label} is not running.`);
		}

		if (!res.ok) {
			const detail = await res.text().catch(() => '');
			if (res.status === 404 || /not found/i.test(detail)) {
				throw new AiError('missing', `${model} is not installed in ${label}.`);
			}
			throw new AiError('server', `${label} returned ${res.status}: ${detail.slice(0, 200)}`);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		const take = line => {
			const trimmed = line.trim();
			if (!trimmed) {
				return false;
			}

			let payload = trimmed;
			if (!isOllama) {
				if (!trimmed.startsWith('data:')) {
					return false;
				}
				payload = trimmed.slice('data:'.length).trim();
				if (payload === '[DONE]') {
					return true;
				}
			}

			let chunk;
			try {
				chunk = JSON.parse(payload);
			} catch {
				return false; // a malformed frame should not end the stream
			}

			if (chunk.error) {
				const message = typeof chunk.error === 'string' ? chunk.error : chunk.error.message;
				throw new AiError('server', `${label}: ${message ?? 'unknown error'}`);
			}

			const reasoning = isOllama ? chunk.message?.thinking : chunk.choices?.[0]?.delta?.reasoning_content;
			const content = isOllama ? chunk.message?.content : chunk.choices?.[0]?.delta?.content;
			const finish = isOllama ? chunk.done_reason : chunk.choices?.[0]?.finish_reason;
			if (finish === 'length') {
				truncated = true;
			}

			if (reasoning) {
				setPhase(phase === 'writing' ? 'writing' : 'thinking');
			}
			if (content) {
				full += content;
				// A model that writes its reasoning inline in <think> tags is
				// still thinking until something outside them appears.
				setPhase(stripReasoning(full) ? 'writing' : 'thinking');
				onToken(content);
			}
			return isOllama && chunk.done === true;
		};

		let finished = false;
		while (!finished) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			lastChunk = Date.now();
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split(NL);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				if (take(line)) {
					finished = true;
					break;
				}
			}
		}
		if (!finished && buffer) {
			take(buffer);
		}

		if (!stripReasoning(full)) {
			throw new AiError('empty', `${model} finished without writing an answer. Try again, or pick a different model in Settings.`);
		}
		return { text: full, truncated };
	} catch (err) {
		if (err instanceof AiError) {
			throw err;
		}
		if (why) {
			throw endedBy(why, label, model, started);
		}
		throw new AiError('server', `Lost the connection to ${label}: ${err.message}`);
	} finally {
		clearInterval(ticker);
	}
}

/**
 * Loads a model ahead of the first question, and keeps it loaded.
 *
 * Without this the first answer of a session pays the load - about 6s for a
 * 1.5B, 17s for a 7.6B on the machine this was measured on - while showing
 * nothing. Ollama only: LM Studio loads on first request and has no equivalent
 * call. Resolves true once the model is in memory, false if it could not be
 * loaded; never throws.
 */
export async function warmModel(provider, model) {
	if (provider !== 'ollama') {
		return true;
	}
	try {
		const res = await fetch(`${PROVIDERS.ollama.endpoint}/api/generate`, {
			method: 'POST',
			signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
			// No prompt: Ollama loads the model and returns, which is the point.
			body: JSON.stringify({ model, keep_alive: KEEP_ALIVE, options: OLLAMA_OPTIONS }),
		});
		// Read it through: the reply is written once loading has finished, and
		// "the model is ready" is the whole thing being waited for.
		await res.text();
		return res.ok;
	} catch {
		return false;
	}
}

/*
 * Follow-up prompts.
 *
 * Asking a second question is not the same as the first answer arriving, so
 * these are separate. They keep the same rule - explain, do not hand over a
 * solution - with two deliberate exceptions:
 *
 *   Complexity IS the lesson. Saying "O(n) because the loop visits each element
 *   once" teaches the thing being asked about, so it is answered directly.
 *
 *   Optimisation names the technique and why it removes the cost, but stops
 *   short of writing the faster solution. Knowing that a hash map turns the
 *   inner scan into a lookup is the insight; typing it is the exercise.
 */

export const SYSTEM_PROMPT_ASK = [
	'You are a tutor sitting next to someone learning data structures and algorithms.',
	'They are asking a follow-up question about their own code.',
	'',
	'Rules:',
	'- Answer the question they actually asked, directly, in plain language.',
	'- Ground it in their code: quote the line or the values involved.',
	'- If they are wrong about something, say so and explain why.',
	'- Do NOT write a corrected or complete solution unless they explicitly ask',
	'  to be shown the fix. Explaining is the job.',
	'- Under 120 words. No preamble, no praise.',
].join('\n');

export const SYSTEM_PROMPT_COMPLEXITY = [
	'You analyse the time and space complexity of a Python solution for someone',
	'learning data structures and algorithms.',
	'',
	'Rules:',
	'- Give the time complexity and the space complexity, in big-O.',
	'- Justify each one: which loop or recursion causes it, which structure holds',
	'  the memory, and say what n refers to in THEIR code.',
	'- Name the dominant term and say why the smaller ones drop out.',
	'- If a bound is amortised or average-case rather than worst-case, say so -',
	'  dictionary lookups being the usual example.',
	'- Count only their code, not the interpreter.',
	'- Under 140 words. No preamble.',
].join('\n');

export const SYSTEM_PROMPT_OPTIMISE = [
	'You help someone learning data structures and algorithms see how their own',
	'solution could be faster or use less memory.',
	'',
	'Rules:',
	'- Start with the complexity they have now, and the best achievable for this',
	'  problem. If those are the same, say it is already optimal and stop.',
	'- Name the technique that closes the gap - a hash map for lookup, two',
	'  pointers, a prefix sum, binary search, memoisation - and explain WHY it',
	'  removes the cost, in terms of the work their current code repeats.',
	'- Do NOT write the optimised code. The idea is the lesson; typing it is the',
	'  exercise.',
	'- Under 140 words. No preamble.',
].join('\n');

/** The old summary plus the turns now falling out of the window. */
/**
 * A follow-up question, optionally about a selected fragment.
 *
 * The selection is what makes this useful: "why is this O(n^2)" means nothing
 * without knowing which part "this" is.
 */
export function buildAskPrompt({ code, selection, question, parsed, expected, stdout, values, trace, problem }) {
	const parts = [...problemBlock(problem)];

	const numbered = code.split('\n')
		.map((l, i) => `${String(i + 1).padStart(4)}  ${l}`)
		.join('\n');
	parts.push('THEIR CODE:', '```python', numbered, '```', '');

	if (selection && selection.trim()) {
		parts.push(
			'THEY HAVE SELECTED THIS PART, AND THE QUESTION IS ABOUT IT:',
			'```', selection.trim(), '```', '',
		);
	}

	// Whatever the last run showed is still the context they are sitting in.
	if (parsed) {
		parts.push('THE LAST RUN FAILED WITH:', '```', parsed.raw, '```', '');
		if (values?.locals && Object.keys(values.locals).length) {
			const rows = Object.entries(values.locals).map(([k, v]) => `  ${k} = ${v}`);
			parts.push(`ACTUAL VALUES AT THE FAILURE, inside ${values.function}():`, '```', rows.join(NL), '```', '');
		}
	} else if (expected !== undefined) {
		parts.push(
			`THE LAST RUN PRINTED ${JSON.stringify((stdout ?? '').trim())}`,
			`BUT ${JSON.stringify(expected)} WAS EXPECTED.`, '',
		);
	} else if (stdout && stdout.trim()) {
		parts.push('THE LAST RUN PRINTED:', '```', stdout.trim().slice(0, 1000), '```', '');
	}

	// Shorter than the explanation's copy: a follow-up usually already has an
	// answer above it, and the turns kept as history are competing for the same
	// context. Enough to settle "how many times did that loop run".
	const steps = formatTrace(trace, 14);
	if (steps) {
		parts.push('THE PATH THAT RUN TOOK (line, then what changed):', '```', steps, '```', '');
	}

	parts.push(question);
	return parts.join('\n');
}
