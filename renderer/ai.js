/*---------------------------------------------------------------------------------------------
 *  myIDE Studio - talking to a local model.
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

const SYSTEM_PROMPT = [
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
	'- Under 120 words. No preamble, no restating the question, no pleasantries.',
].join('\n');

/**
 * Builds the user message. Everything here is fact: the traceback came from
 * Python, the source is what ran, the output is what it printed.
 */
export function buildPrompt({ code, parsed, stdout, question }) {
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
	} else {
		parts.push(
			'The program ran to completion with no error.',
			'Do NOT invent an error. If the output looks wrong, say why; otherwise say it looks correct.',
			'',
			'SOURCE:', '```python', code, '```', '',
		);
	}

	if (stdout && stdout.trim()) {
		parts.push('WHAT IT PRINTED:', '```', stdout.trim().slice(0, 2000), '```', '');
	}

	parts.push(question || (parsed ? 'Explain this error and how to fix it.' : 'Is this output correct?'));
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
