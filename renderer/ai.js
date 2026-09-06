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
 * Below this, a model cannot hold the teaching rules.
 *
 * Measured, not assumed. Asked to explain the two_sum that returns its indices
 * in discovery order, qwen2.5-coder:1.5b answered in 3.5s and again in 9.3s
 * with the recorded trace - and both times wrote out a corrected line under a
 * "Here's the corrected line:" heading, which is the one thing SYSTEM_PROMPT
 * forbids, and both times blamed the wrong line. A 7.6B on the same prompt
 * named line 6, explained the ordering assumption, and closed with a question,
 * in 51-74s. Slow and right beats instant and confidently wrong: being handed a
 * fix you did not ask for defeats the point of the app, and being handed the
 * wrong one wastes the session.
 *
 * The 1.5B stays selectable in the picker - it is genuinely quicker, and for
 * "what does this error mean" that can be the better trade. It is just not the
 * default.
 */
const MIN_TEACHING_B = 3;

/** Above this, a laptop GPU starts swapping and the wait stops being worth it. */
const MAX_LOCAL_B = 8;

/**
 * Prefer a coder-tuned model, largest that is still sane on a small GPU - but
 * never one so small it argues with its own instructions.
 */
export function pickDefaultModel(models, sizes = {}) {
	const fromName = id => {
		const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id);
		return m ? Number(m[1]) : undefined;
	};

	const usable = models
		.filter(m => !/embed/i.test(m))
		// What the server says it is, and only then what the name suggests.
		.map(model => ({ model, b: sizes[model] ?? fromName(model), coder: /coder|code/i.test(model) }));

	// Coder-tuned first, then largest - but only among models big enough to be
	// worth defaulting to. A 1.5B coder used to win here purely by being the
	// only name with "coder" in it, beating a 7.6B sitting right beside it.
	const candidates = usable
		.filter(c => c.b !== undefined && c.b >= MIN_TEACHING_B && c.b <= MAX_LOCAL_B)
		.sort((a, b) => Number(b.coder) - Number(a.coder) || b.b - a.b);

	// Nothing in range: take a coder of any size, then anything at all. Some
	// model is better than a dead panel, and the picker can correct it.
	return candidates[0]?.model
		?? usable.find(c => c.coder)?.model
		?? usable[0]?.model;
}

/**
 * The installed models, as `{ name, params }`.
 *
 * `params` is the size in billions where the server will say - Ollama reports
 * it as "7.6B" in the tag details - and undefined otherwise. It matters because
 * a name is not a reliable size: a model pulled under a custom tag carries no
 * number at all, and picking a default by reading the name would rank a 7.6B
 * called `logic:latest` below a 1.5B that spells its size out.
 */
export async function listModels(provider) {
	const billions = text => {
		const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(text ?? '');
		return m ? Number(m[1]) : undefined;
	};

	const { endpoint } = PROVIDERS[provider];
	if (provider === 'ollama') {
		const res = await fetch(`${endpoint}/api/tags`);
		const json = await res.json();
		return (json.models ?? []).map(m => ({
			name: m.name,
			params: billions(m.details?.parameter_size),
		}));
	}

	// LM Studio's OpenAI-compatible listing carries an id and nothing else.
	const res = await fetch(`${endpoint}/v1/models`);
	const json = await res.json();
	return (json.data ?? []).map(m => ({ name: m.id, params: undefined }));
}

/*
 * The teaching prompt, and the default.
 *
 * The point of this app is to get better at DSA, not to receive working
 * solutions faster. Handing over a corrected line removes the one part that
 * actually builds skill - working out why your own reasoning was wrong - and a
 * model will do exactly that unless told not to, because "give the minimal fix"
 * is what these prompts usually ask for.
 *
 * So: explain the mistake, never write the fix. The escape hatch is explicit
 * (SYSTEM_PROMPT_REVEAL, behind a button) rather than being the default, so
 * seeing the answer stays a decision instead of a habit.
 */
export const SYSTEM_PROMPT = [
	'You are a tutor sitting next to someone learning data structures and algorithms.',
	'',
	'Your job is to make them understand their own mistake so they can fix it',
	'themselves. You are NOT here to hand them a working solution.',
	'',
	'You are given either the exact traceback Python produced, or the expected and',
	'actual output of a run. Work only from that. Never claim a different failure,',
	'and do not go looking for other problems.',
	'',
	'Rules:',
	'- Say what is happening in plain language, and name the line it happens on.',
	'- Explain WHY the code does that: the assumption or idea that does not hold.',
	'  This is the part that matters - spend most of your words here.',
	'- NEVER write the corrected code. No fixed line, no rewritten function, no',
	'  "change X to Y", not even as an example. Describe the problem, not the edit.',
	'- Finish with one specific question that points them at the fix.',
	'- Under 120 words. No preamble, no praise, no restating the question.',
].join('\n');

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
	const lines = [];
	let frame = '';

	for (const step of shown) {
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
	if (trace.truncated) {
		return [
			`THIS IS WHAT ACTUALLY HAPPENED, STEP BY STEP. Recording stopped after`,
			`${total} steps and the program carried on past them, so these are steps`,
			`from the MIDDLE of the run, not the end. Do not say the program ended here.`,
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

/**
 * Streams a completion, calling onToken with each fragment.
 * Returns the full text.
 */
export async function chat({ provider, model, messages, signal }, onToken) {
	const { endpoint } = PROVIDERS[provider];
	const isOllama = provider === 'ollama';

	const res = await fetch(
		isOllama ? `${endpoint}/api/chat` : `${endpoint}/v1/chat/completions`,
		{
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			signal,
			body: JSON.stringify(
				isOllama
					? { model, messages, stream: true, options: { temperature: 0.2 } }
					: { model, messages, stream: true, temperature: 0.2 },
			),
		},
	);

	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`${PROVIDERS[provider].label} returned ${res.status}: ${body.slice(0, 300)}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let full = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });

		// Both providers are line-delimited; keep the partial tail for next time.
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			let payload = trimmed;
			if (!isOllama) {
				if (!trimmed.startsWith('data:')) {
					continue;
				}
				payload = trimmed.slice('data:'.length).trim();
				if (payload === '[DONE]') {
					return full;
				}
			}

			let chunk;
			try {
				chunk = JSON.parse(payload);
			} catch {
				continue; // a malformed frame should not kill the stream
			}

			const token = isOllama
				? chunk.message?.content
				: chunk.choices?.[0]?.delta?.content;

			if (token) {
				full += token;
				onToken(token);
			}
		}
	}

	return full;
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
