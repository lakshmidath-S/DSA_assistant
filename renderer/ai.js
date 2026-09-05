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

/** Prefer a coder-tuned model, largest that is still sane on a small GPU. */
export function pickDefaultModel(models) {
	const size = id => {
		const m = /(\d+(?:\.\d+)?)\s*b\b/i.exec(id);
		return m ? Number(m[1]) : undefined;
	};
	const coders = models.filter(m => /coder|code/i.test(m) && !/embed/i.test(m));
	const sized = coders
		.map(model => ({ model, b: size(model) }))
		.filter(c => c.b !== undefined)
		.sort((a, b) => b.b - a.b);

	return sized.find(c => c.b <= 8)?.model ?? sized[0]?.model ?? coders[0] ?? models.find(m => !/embed/i.test(m));
}

export async function listModels(provider) {
	const { endpoint } = PROVIDERS[provider];
	if (provider === 'ollama') {
		const res = await fetch(`${endpoint}/api/tags`);
		const json = await res.json();
		return (json.models ?? []).map(m => m.name);
	}
	const res = await fetch(`${endpoint}/v1/models`);
	const json = await res.json();
	return (json.data ?? []).map(m => m.id);
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
 * Builds the user message. Everything here is fact: the traceback came from
 * Python, the source is what ran, the output is what it printed.
 */
export function buildPrompt({ code, parsed, stdout, expected, question }) {
	const parts = [];

	if (parsed) {
		parts.push('PYTHON REPORTED THIS ERROR:', '```', parsed.raw, '```', '');
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

	const fallback = parsed
		? 'What is going wrong here, and why?'
		: expected !== undefined
			? 'Why is the output different from what I expected?'
			: 'Is this output correct?';
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
