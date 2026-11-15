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
 * mechanically - see teachingOnly() - because "usually" is not good enough for
 * the one thing the app exists to do.
 */
export const SYSTEM_PROMPT = [
	'You are a tutor for a student learning data structures and algorithms.',
	'Explain their bug so they can fix it themselves.',
	'Never write code. Never show a corrected line.',
	'Reply in at most 4 sentences, then ask the student one question.',
].join(NL);

/**
 * One worked exchange, on a different bug, so the model sees the shape of a good
 * answer. A crash, so it is only sent with a crash: next to a wrong answer the
 * 1.5B copies the IndexError into it (see buildTeaching()).
 */
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

/** Said once, at the end, wherever a fix was taken out of a teaching answer. */
export const FIX_LEFT_OUT = '(How to fix it was left out - press Show the fix if you want it.)';

/** What is shown when the model wrote nothing but the fix. */
export const ONLY_A_FIX = 'The answer that came back was only the fix, so it is not shown here. '
	+ 'Press Explain again for an explanation, or Show the fix to see it.';

/**
 * A sentence that hands over the fix instead of explaining the mistake.
 *
 * Measured on the 1.5B default, 24 automatic explanations of four bugs: 21
 * gave the fix away in words, nearly always straight after a correct
 * diagnosis - "To fix this, change `columnNumber -= 1` to ...", "Here's how
 * you can do it:", "you should use `counts[ch] = 1` instead". Code blocks were
 * already removed; this is the same thing in prose. Tested a sentence at a
 * time, with inline code blanked so a word inside it cannot match.
 */
const FIX_SENTENCE = new RegExp([
	// Announcing one.
	String.raw`\bto (fix|correct|resolve|solve|repair) (this|it|that|the)\b`,
	String.raw`\b(one|another|a simple|the simplest|an easy|the easiest|a better|the correct|the right|the proper) (way|fix|solution|approach) (to|is|would|here)\b`,
	String.raw`\bthe (fix|solution) (is|would be|here)\b`,
	String.raw`\b(can|could) be (fixed|solved|corrected|resolved) by\b`,
	String.raw`\b(here'?s|here is|below is) (how|what|the|a|an)\b`,
	String.raw`\b(corrected|fixed|modified|updated|revised) (code|version|line|function|loop|condition|solution)\b`,
	// Telling them what to type.
	String.raw`\b(you|we) (should|need to|must|have to|can|could|might want to|may want to|'ll need to|will need to|would need to)( simply| just| first| also)? (add|change|replace|use|initiali[sz]e|insert|reverse|decrement|increment|update|modify|remove|delete|move|set|check|append|prepend|subtract|swap|start|begin|include|rewrite|put|wrap|convert|return|break|declare|define|assign|switch|adjust|ensure|make sure)\b`,
	String.raw`^(simply |just |first,? |instead,? )?(add|change|replace|use|initiali[sz]e|insert|swap|move|rewrite|remove|wrap|switch|adjust|ensure|make sure)\b`,
	String.raw`\b(consider|try|start by) (using|adding|changing|replacing|initiali[sz]ing|checking|reversing|moving|removing|swapping)\b`,
	String.raw`\bshould (be|read|say|look like) \x60`,
].join('|'), 'i');

/** Words that make a sentence about what the code ought to be, rather than what it is. */
const OUGHT = /\b(should|needs? to|must|ought to|has to|have to|instead)\b/i;

/** Inline code that reads as a statement or expression, not a bare value like "AB" or 12. */
const STATEMENT = /[A-Za-z_]\w*\s*(?:[-+*/%]?=|[([.<>]|\b(?:in|not|and|or)\b)/;

/** `nums[0]`, `self.count`, `memo["a"]`: one of their names and a value it holds. */
const REFERENCE = /^([A-Za-z_]\w*)(?:\.[A-Za-z_]\w*|\[\s*(?:-?\d+|'[^']*'|"[^"]*")\s*\])*$/;

const squash = s => String(s).replace(/\s+/g, '');

/**
 * "The loop should start from `i = 0`, not `i = 1`" - the corrected code, in a
 * sentence. Told apart from "it should return `"AB"`" (a value, the expected
 * answer), "`columnNumber` should go down" (their own code, a hint) and
 * "`nums[0]` should be added too" (a value of theirs, the symptom) by whether
 * the code it puts forward is code the student did not write.
 */
function proposesNewCode(sentence, code) {
	if (!OUGHT.test(sentence)) {
		return false;
	}
	const theirs = squash(code);
	const theirValue = span => {
		const name = REFERENCE.exec(span)?.[1];
		return name !== undefined && new RegExp(`\\b${name}\\b`).test(code);
	};
	return [...sentence.matchAll(/`([^`]+)`/g)]
		.map(m => m[1].trim())
		.some(span => STATEMENT.test(span) && !theirs.includes(squash(span)) && !theirValue(span));
}

/** One line of code, as it would be compared: no line-number prefix, spaces collapsed. */
function codeLine(line) {
	return line.replace(/^\s*\d+\s*>?\s/, '').replace(/\s+/g, ' ').trim();
}

/**
 * Whether a fenced block only quotes the student's own code. "The line that
 * produces the wrong value is:" followed by that line is pointing, not fixing,
 * and is worth keeping; a block with any line they did not write is a fix.
 */
function quotesOnly(block, code) {
	const theirs = new Set(String(code ?? '').split('\n').map(codeLine).filter(Boolean));
	const lines = block.split('\n').map(codeLine).filter(l => l && l !== '...');
	return lines.length > 0 && lines.every(l => theirs.has(l));
}

/**
 * The sentences of some prose, each with its own trailing space, so joining
 * them gives the prose back. A full stop ends one only when a space follows
 * it, so `nums.append` and 1.5 stay whole.
 */
function sentencesOf(prose) {
	return prose.match(/(?:[^.!?\n]|[.!?](?!\s|$))*(?:[.!?]+(?=\s|$)|\n|$)\s*/g)?.filter(Boolean) ?? [];
}

const sameWords = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Keeps a teaching answer to teaching.
 *
 * The 1.5B default explains well and then, nearly every time, goes on to say
 * how to fix it - in a code block, or in words. Asking it not to does not hold,
 * so this is enforced here: the answer is cut at the first sentence or block
 * that hands over the fix, and a note says so. A block that only quotes the
 * student's own lines stays, since pointing at a line is the explanation.
 *
 * Two tidy-ups ride along. It sometimes repeats the question it was asked, as
 * if a heading ("Why does the loop on line 4 never end?"), so a sentence of
 * the request's closing question is dropped; and told to "ask the student a
 * question" it writes "Ask the student:" in front of one, which is removed.
 *
 * Safe on a partial answer: a fence still arriving is held back until it
 * closes, so a fix being typed out is never shown, even briefly.
 *
 * @param {string} text The model's answer, reasoning already removed.
 * @param {{ code?: string, closing?: string }} [context] The student's code,
 *        and the last line of the request.
 */
export function teachingOnly(text, { code = '', closing = '' } = {}) {
	const source = String(text ?? '');
	const asked = new Set(sentencesOf(String(closing)).map(sameWords).filter(s => s.length > 12));

	const kept = [];
	let cut = false;
	const fence = /```[^\n]*\n?([\s\S]*?)(```|$)/g;
	let at = 0;

	const prose = segment => {
		for (const sentence of sentencesOf(segment)) {
			const flat = sentence.replace(/\s+/g, ' ').trim();
			if (FIX_SENTENCE.test(flat.replace(/`[^`]*`/g, '`x`')) || proposesNewCode(flat, code)) {
				cut = true;
				return;
			}
			if (asked.has(sameWords(flat))) {
				continue;
			}
			// "Question:", and its bold forms "**Question:**" and "**Question**:".
			kept.push(sentence.replace(/^(\s*)[*_]{0,2}(?:ask the student|question for the student|question)[*_]{0,2}\s*:\s*[*_]{0,2}\s*/i, '$1'));
		}
	};

	for (let m = fence.exec(source); m && !cut; m = fence.exec(source)) {
		prose(source.slice(at, m.index));
		at = fence.lastIndex;
		if (cut) {
			break;
		}
		if (m[2] !== '```') {
			break;   // still arriving: shown once it closes, if it is only a quote
		}
		if (quotesOnly(m[1], code)) {
			kept.push(m[0]);
		} else {
			cut = true;
			// "Change line 7 to:" with nothing after it reads as broken.
			while (kept.length && /:\s*$/.test(kept[kept.length - 1])) {
				kept.pop();
			}
		}
	}
	if (!cut && at < source.length && !/```/.test(source.slice(at))) {
		prose(source.slice(at));
	}

	const answer = kept.join('').trim();
	if (!cut) {
		return answer;
	}
	return answer ? `${answer}\n\n${FIX_LEFT_OUT}` : ONLY_A_FIX;
}

/**
 * Used only when the reader presses "Show the fix". Kept deliberately separate
 * so the default answer can never drift back into handing over the solution.
 */
export const SYSTEM_PROMPT_REVEAL = [
	'You are helping someone learning data structures and algorithms who has',
	'looked at the problem and asked to be shown the fix.',
	'',
	'Work only from the facts you are given: the traceback, the expected and',
	'actual answer, or where a loop that never ended was stuck.',
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

/**
 * The one call that produced the answer, folded into how each name changed.
 *
 * The step-by-step recording is exact, and a 1.5B cannot follow it: given the
 * twelve steps of a convertToTitle that returns "BA" for "AB", it blamed the
 * arithmetic on a correct line in four answers of six. Folded down to
 * `ans: [] -> ['B'] -> ['B', 'A']` beside the line that returned it, the order
 * the letters were made in is on one line.
 *
 * Which call: for a Solution, the method's `caseIndex`-th outermost call - the
 * harness calls it once per case, in order. For anything else, the last
 * function that returned a value, which is the one that produced the answer.
 * Undefined when that call cannot be found whole: the middle of a long run was
 * dropped across it, or recording stopped before it ended. Better no summary
 * than one of the wrong call.
 *
 * @returns {{ fn: string, names: Array<[string, string[]]>, returned?: { line: number, value: string } } | undefined}
 */
export function callHistory(trace, { method, caseIndex = 0 } = {}) {
	const steps = trace?.steps ?? [];
	let key;
	if (method) {
		const depths = steps.filter(s => s.fn === method).map(s => s.d);
		key = depths.length ? `${method}#${Math.min(...depths)}` : undefined;
	} else {
		const last = steps.findLast(s => s.ret !== undefined && s.fn !== '<module>');
		key = last && `${last.fn}#${last.d}`;
	}
	if (!key) {
		return undefined;
	}

	// One entry per call: a call ends at its frame's "r" step.
	const calls = [];
	let current;
	steps.forEach((step, at) => {
		if (`${step.fn}#${step.d}` !== key) {
			return;
		}
		current ??= { from: at, steps: [] };
		current.steps.push(step);
		if (step.r) {
			calls.push({ ...current, to: at });
			current = undefined;
		}
	});

	// Recording that stopped early saw only the start of a run: its last call
	// is not the one that made the answer. A Solution's call for one case is
	// either recorded to its end, and counted, or not counted at all.
	const call = method ? calls[caseIndex] : trace.truncated ? undefined : calls.at(-1);
	const gap = trace.dropped ? trace.gapAt : undefined;
	// A dropped middle shifts the count for every call after it, and a call
	// the gap runs through is missing its own middle.
	if (!call || (gap !== undefined && (method ? call.to >= gap : call.from < gap && call.to >= gap))) {
		return undefined;
	}

	const names = new Map();
	for (const step of call.steps) {
		for (const [name, value] of Object.entries(step.vars ?? {})) {
			const seen = names.get(name) ?? [];
			if (seen.at(-1) !== value) {
				seen.push(value);
			}
			names.set(name, seen);
		}
	}
	const ret = call.steps.find(s => s.ret !== undefined);
	return {
		fn: key.split('#')[0],
		names: [...names],
		returned: ret && { line: ret.line, value: ret.ret },
	};
}

/**
 * A wrong design case as the calls up to the first wrong one: what each
 * returned, and the object's self.<name> values after it, where they changed.
 *
 * A design bug is nearly always a call that answered correctly and left the
 * object wrong - pop() taking from one list and not the other - so the state
 * between calls is the evidence. Measured on two such bugs, 8 answers each,
 * against the raw steps of the run: about twice as many named the cause (it is
 * still a minority on the 1.5B), states that never happened were invented
 * less, and answers came back sooner.
 *
 * @param {{ steps: Array<{op: string, args: string, shown: string, expected?: string, state?: object}>, first: number }} design
 */
function designStory({ steps, first }) {
	let before = '';
	const rows = steps.slice(0, first + 1).map((s, i) => {
		const state = Object.entries(s.state ?? {}).map(([k, v]) => `${k} = ${v}`).join(', ');
		const ret = i === first ? ` returned ${s.shown}, expected ${s.expected}`
			: s.shown === 'null' ? '' : ` returned ${s.shown}`;
		const after = state && state !== before ? `${ret ? ';' : ' ->'} then ${state}` : '';
		before = state || before;
		return `  ${i + 1}. ${s.op}(${s.args})${ret}${after}`;
	});
	return rows.length > 16 ? [...rows.slice(0, 3), '  ...', ...rows.slice(-12)] : rows;
}

/** `a -> b -> c`, keeping both ends of a long run of values. */
function arrows(values, keep = 8) {
	const shown = values.length > keep ? [...values.slice(0, 3), '...', ...values.slice(-(keep - 4))] : values;
	return shown.join(' -> ');
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

/** The source with line numbers, and `mark` flagged with a >. */
function numbered(code, mark) {
	return code.split('\n')
		.map((l, i) => `${String(i + 1).padStart(4)}${i + 1 === mark ? ' >' : '  '} ${l}`)
		.join('\n');
}

/** What each test case of a Solution returned, one per line. */
function callsBlock(calls) {
	return (calls ?? []).slice(0, 12).map(c => `  ${c.call} returned ${c.shown}`).join(NL);
}

/**
 * Where a run that would not end was stuck, as the harness's watchdog saw it.
 * The verdict is the harness's, from facts: a while loop is called stuck only
 * when none of the names its condition reads changed while it was watched.
 */
function loopBlock(code, loop) {
	const where = loop.loop;
	const line = where?.line ?? loop.line;
	const parts = [
		loop.stuck
			? `The program never finished. It was stopped after ${loop.seconds} seconds, stuck in a loop that cannot end.`
			: `The program had not finished after ${loop.seconds} seconds and was stopped. It may be very slow, or it may never end.`,
		'',
	];
	if (loop.case) {
		parts.push(`IT WAS RUNNING THIS TEST CASE: ${loop.case}`, '');
	}
	if (where) {
		parts.push(where.kind === 'while'
			? `IT WAS INSIDE THE while LOOP ON LINE ${where.line}, WHOSE CONDITION IS: ${where.condition}`
			: `IT WAS INSIDE THE for LOOP ON LINE ${where.line}, OVER: ${where.condition}`, '');
	}
	const locals = Object.entries(loop.locals ?? {});
	if (locals.length) {
		const rows = locals.map(([k, v]) => `  ${k} = ${v}   (${loop.changed?.includes(k) ? 'was changing' : 'did NOT change'})`);
		parts.push(
			`THE VALUES, WATCHED WHILE IT RAN, inside ${loop.function}():`,
			'```', rows.join(NL), '```',
			'These were recorded from the run itself. Quote them; do not invent different ones.', '',
		);
	}
	if (loop.stuck && loop.watched?.length) {
		parts.push(
			`The condition reads ${loop.watched.join(', ')}, and NONE of them changed while it was watched,`,
			'so the condition can never become false. Do not say the program is merely slow.', '',
		);
	}
	if (line) {
		parts.push(`THE LOOP IS ON LINE ${line}, MARKED > BELOW:`, '```python', numbered(code, line), '```', '');
	}
	return parts;
}

/**
 * Builds the user message. Everything here is fact: the traceback came from
 * Python, the source is what ran, the output is what it printed (or, for a
 * LeetCode-style Solution, what each call returned), and the trace is the path
 * it actually took.
 */
export function buildPrompt({
	code, parsed, stdout, expected, values, trace, problem, question,
	loop, method, calls, call, returned, failed, difference, caseIndex, inPlace, design, reveal = false,
}) {
	const parts = [...problemBlock(problem)];
	// A design case: the calls that led to the wrong one, and the object between them.
	const designed = expected !== undefined && !parsed && !loop && design?.first >= 0 ? designStory(design) : undefined;
	// The call that produced a wrong answer, folded into how its values moved.
	// A design problem's answer comes from several calls, so it has none.
	const story = expected !== undefined && !parsed && !loop && !calls?.[0]?.ops
		? callHistory(trace, { method: call ? method : undefined, caseIndex })
		: undefined;
	if (story && inPlace) {
		story.returned = undefined;   // it returns None; the answer is the argument
	}

	if (parsed) {
		parts.push('PYTHON REPORTED THIS ERROR:', '```', parsed.raw, '```', '');
		if (failed) {
			parts.push(`IT WAS RUNNING THIS TEST CASE: ${failed}`, '');
		}

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
	} else if (loop) {
		parts.push(...loopBlock(code, loop));
	} else if (expected !== undefined) {
		// A wrong answer, not a crash: the common case in DSA work, and the one
		// a cloud chat gets used for.
		//
		// Short, and nothing but facts. This used to carry the problem
		// statement, the steps one by one and six lines of instructions, and
		// the 1.5B named the cause of a reversed answer in 2 answers of 6 -
		// blaming a correct `columnNumber -= 1` in the rest. Given the two
		// answers, the code, and how each value moved, and asked to walk
		// through how the code gets there, it did so correctly in about 6 of 8,
		// and an off-by-one sum went from 2 of 6 to 5 of 8. Retelling recorded
		// values is a thing a small model does well; finding a cause is not.
		parts.length = 0;
		const got = (call ? returned : (stdout ?? '').trim()) || '(nothing)';
		const field = (label, text) => (String(text).includes('\n')
			? [`${label}:`, '```', text, '```']
			: [`${label}: ${text}`]);
		parts.push(
			`A student's code ${call ? 'returned' : 'printed'} the wrong answer.`,
			'',
			...(call ? [`THE CALL: ${call}`] : []),
			...field('EXPECTED', expected),
			...field(call ? 'RETURNED' : 'PRINTED', got),
			// A difference worked out by comparing the two, not by the model.
			...(difference ? [`CHECKED: ${difference}`] : []),
			'',
			'THE CODE:', '```python', numbered(code), '```', '',
		);

		// The run was recorded, so the model does not have to simulate the loop
		// it is being asked about - which is the step it gets wrong. One line
		// per name where the call can be found whole; the raw steps otherwise.
		const steps = story || designed ? '' : formatTrace(trace);
		if (designed) {
			parts.push('RECORDED WHILE IT RAN (each call, what it returned, and the object after it):', ...designed, '');
		} else if (story) {
			parts.push('RECORDED WHILE IT RAN (exact values, in order):');
			for (const [name, seen] of story.names.slice(0, 10)) {
				parts.push(`  ${name}: ${arrows(seen)}`);
			}
			if (story.returned) {
				const text = (code.split('\n')[story.returned.line - 1] ?? '').trim();
				parts.push(`Line ${story.returned.line} (${text}) returned ${story.returned.value}.`);
			}
			parts.push('');
		} else if (steps) {
			parts.push(
				traceHeading(trace, Math.min(24, trace.steps.length)),
				'```', steps, '```',
				'Each step is a line about to run, and the names that changed since the step before it.',
				'',
			);
		}
		// Without this the model "fixes" the test: a 7B once suggested
		// reordering two_sum's input to match the bug.
		parts.push('The expected answer and the test input are both correct.', '');
	} else {
		parts.push(
			'The program ran to completion with no error.',
			'Do NOT invent an error. If the output looks wrong, say why; otherwise say it looks correct.',
			'',
			'SOURCE:', '```python', code, '```', '',
		);
		if (calls?.length) {
			parts.push(`WHAT ${method ?? 'THE METHOD'} RETURNED FOR EACH TEST CASE:`, '```', callsBlock(calls), '```', '');
		}
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
	const returnStep = trace?.steps?.slice().reverse().find(s => s.ret !== undefined);
	const traced = lastStep
		? Object.entries(lastStep.vars).slice(0, 6).map(([k, v]) => `${k} = ${v}`).join(', ')
			+ (returnStep ? `, and ${returnStep.fn}() returned ${returnStep.ret}` : '')
		: '';

	const against = (problem ?? '').trim()
		? ' Answer against the problem statement, not against what the code looks like it is trying to do.'
		: '';

	const why = text => `${text[0].toUpperCase()}${text.slice(1)}`;
	// The two answers named in the question itself, where they are short
	// enough to: a model reads the closing line hardest.
	const printed = (stdout ?? '').trim();
	const short = s => s && s.length <= 40 && !s.includes('\n');
	const whyWrong = call
		? `why does ${call} return ${returned} instead of ${expected}?`
		: short(printed) && short(String(expected ?? ''))
			? `why does it print ${printed} instead of ${expected}?`
			: 'why is the output different from what I expected?';
	const differs = difference ? `${difference} ${why(whyWrong)}` : whyWrong;
	// The teaching close for a wrong answer: walk through it, then one question.
	// Show the fix asks the plain question instead, and gets the corrected line.
	const gotText = (call ? returned : printed) || '(nothing)';
	const ends = short(String(gotText)) && short(String(expected ?? ''))
		? `${gotText} instead of ${expected}`
		: 'that output instead of the expected one';
	const walkThrough = `${story || designed || traced ? 'Using only these recorded values, explain' : 'Explain'} step by step how the code `
		+ `ends up with ${ends}. Then ask the student one question that points at the cause. Do not say how to fix it.`;
	const stuckOn = loop?.stuck && loop.watched?.length
		? `${loop.watched.map(n => `${n} = ${loop.locals?.[n]}`).join(', ')} never changed. `
		: '';

	const fallback = parsed
		? (recorded
			? `The recorded values were: ${recorded}. Using those exact numbers, what went wrong and why?`
			: 'What is going wrong here, and why?')
		: loop
			? (loop.stuck
				? `${stuckOn}Why does the loop on line ${loop.loop?.line ?? loop.line} never end?`
				: `Why has this not finished after ${loop.seconds} seconds?${against}`)
			: expected !== undefined
				? (reveal ? why(differs) : walkThrough)
				: `${calls?.length ? 'Are these answers correct?' : 'Is this output correct?'}${against}`;

	parts.push(question || fallback);
	return parts.join('\n');
}

/**
 * The automatic explanation's request, and how its answer is cleaned.
 *
 * In one place so the app and the measurements behind these prompts send the
 * same thing. `reveal` is Show the fix: its own prompt, and nothing removed.
 *
 * @returns {{ messages: Array<{role: string, content: string}>, clean: (text: string) => string, closing: string }}
 */
export function buildTeaching(facts, { reveal = false } = {}) {
	const user = buildPrompt({ ...facts, reveal });
	const closing = user.split(NL).pop();
	// A wrong answer's request ends on its own instruction - walk through it,
	// then ask - and was measured that way; the rules block stays with crashes
	// and loops, where it was measured.
	const wrongAnswer = facts.expected !== undefined && !facts.parsed && !facts.loop;
	return {
		messages: [
			{ role: 'system', content: reveal ? SYSTEM_PROMPT_REVEAL : SYSTEM_PROMPT },
			// One worked example, for a crash only: a small model copies its
			// shape - and its content. Beside a wrong answer the 1.5B invented
			// the example's IndexError in 4 answers of 12.
			...(reveal || !facts.parsed ? [] : TEACHING_EXAMPLE),
			{ role: 'user', content: user + (reveal || wrongAnswer ? '' : TEACHING_RULES) },
		],
		// The teaching answer never shows the fix, whatever the model wrote;
		// Show the fix is where the fix lives.
		clean: reveal
			? stripReasoning
			: text => teachingOnly(stripReasoning(text), { code: facts.code, closing }),
		closing,
	};
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
export function buildAskPrompt({
	code, selection, question, parsed, expected, stdout, values, trace, problem,
	loop, method, calls, call, returned, failed, difference,
}) {
	const parts = [...problemBlock(problem)];

	parts.push('THEIR CODE:', '```python', numbered(code), '```', '');

	if (selection && selection.trim()) {
		parts.push(
			'THEY HAVE SELECTED THIS PART, AND THE QUESTION IS ABOUT IT:',
			'```', selection.trim(), '```', '',
		);
	}

	// Whatever the last run showed is still the context they are sitting in.
	if (parsed) {
		parts.push('THE LAST RUN FAILED WITH:', '```', parsed.raw, '```', '');
		if (failed) {
			parts.push(`WHILE RUNNING THIS TEST CASE: ${failed}`, '');
		}
		if (values?.locals && Object.keys(values.locals).length) {
			const rows = Object.entries(values.locals).map(([k, v]) => `  ${k} = ${v}`);
			parts.push(`ACTUAL VALUES AT THE FAILURE, inside ${values.function}():`, '```', rows.join(NL), '```', '');
		}
	} else if (loop) {
		const where = loop.loop;
		const unchanged = (loop.watched ?? []).map(n => `${n} = ${loop.locals?.[n]}`).join(', ');
		parts.push(
			`THE LAST RUN NEVER FINISHED: it was stopped after ${loop.seconds}s`
			+ (where ? ` in the ${where.kind} loop on line ${where.line} (${where.condition})` : '')
			+ (loop.case ? `, running ${loop.case}` : '') + '.',
			...(loop.stuck && unchanged ? [`The loop's condition can never change: ${unchanged} stayed the same the whole time.`] : []),
			'',
		);
	} else if (expected !== undefined && call) {
		parts.push(
			`IN THE LAST RUN, ${call} RETURNED ${returned}`,
			`BUT ${expected} WAS EXPECTED.`,
			...(difference ? [`WHAT IS DIFFERENT, CHECKED: ${difference}`] : []), '',
		);
	} else if (expected !== undefined) {
		parts.push(
			`THE LAST RUN PRINTED ${JSON.stringify((stdout ?? '').trim())}`,
			`BUT ${JSON.stringify(expected)} WAS EXPECTED.`, '',
		);
	} else if (calls?.length) {
		parts.push(`IN THE LAST RUN, ${method ?? 'THE METHOD'} RETURNED:`, '```', callsBlock(calls), '```', '');
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
