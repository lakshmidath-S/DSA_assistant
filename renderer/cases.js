/*---------------------------------------------------------------------------------------------
 *  myIDE - test cases for a LeetCode-style `class Solution`.
 *
 *  A solution like that prints nothing: what it RETURNS is the answer. The
 *  harness calls the method on each case and reports what came back; this
 *  module decides what the cases are, and whether each answer is right.
 *
 *  Where the cases come from, first match wins:
 *    1. the Input box, typed the way LeetCode's testcase box has it, or with a
 *       whole example pasted in ("Input: ... Output: ...");
 *    2. the examples in the pasted Problem, when the Input box is empty.
 *  What each should return comes from the Expected box, one line per case, or
 *  else from the examples' own "Output:" lines.
 *
 *  Kept free of the DOM so it can be tested directly - see test/cases.test.mjs.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** The harness's own test for a Solution file - see SOLUTION_RE in python/harness.py. */
export function isSolution(code) {
	return /^class\s+Solution\b/m.test(String(code ?? ''));
}

/**
 * A heading in a problem statement. Usually "Input: nums = [1,2]", but a design
 * problem's examples have "Input" and "Output" on lines of their own, with the
 * values on the lines under them:
 *     Input
 *     ["MinStack","push","getMin"]
 *     [[],[-2],[]]
 *     Output
 *     [null,null,-2]
 */
const LABEL = /^\s*(Input|Output|Explanation|Constraints|Example\s*\d*|Note|Follow[- ]?up)\s*(?::|$)/i;

/**
 * The worked examples in a LeetCode problem statement, or in an example pasted
 * whole: [{ input, output }], in order. An example without an Output line still
 * counts; its output is then undefined.
 */
export function examplesFrom(text) {
	const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
	const examples = [];
	let current;
	let field;

	for (const line of lines) {
		const label = LABEL.exec(line);
		if (label) {
			const kind = label[1].toLowerCase();
			const rest = line.slice(label[0].length).trim();
			if (kind === 'input') {
				current = { input: rest, output: undefined };
				examples.push(current);
				field = 'input';
			} else if (kind === 'output' && current && current.output === undefined) {
				current.output = rest;
				field = 'output';
			} else {
				// An explanation, the constraints, the next example's heading: none
				// of it is a value, and it ends the one before.
				field = undefined;
			}
			continue;
		}
		// A value that wraps onto the next line belongs to the field above it;
		// a blank line ends it - once it has one. A design problem's "Input" is
		// a heading on a line of its own, and its value can follow a blank.
		if (!line.trim()) {
			if (!current || !field || current[field]) {
				field = undefined;
			}
		} else if (current && field) {
			current[field] = `${current[field]}\n${line.trim()}`.trim();
		}
	}

	return examples.filter(e => e.input);
}

/**
 * What to run, and what each case should return.
 *
 * @returns {{ input: string, expectations?: string[], from: 'input'|'problem'|'none' }}
 *          `input` is what the harness parses; `expectations` the answer per
 *          case, when known; `from` says where the cases came from, so the card
 *          can say so - running examples nobody typed must not be a surprise.
 */
export function planRun({ input, expected, problem }) {
	const typed = String(input ?? '');
	const fromExpected = expectedLines(expected);
	const pick = (examples, from) => ({
		input: examples.map(e => e.input).join('\n'),
		expectations: fromExpected ?? (examples.every(e => e.output !== undefined)
			? examples.map(e => e.output)
			: undefined),
		from,
	});

	if (typed.trim()) {
		const pasted = examplesFrom(typed);
		return pasted.length ? pick(pasted, 'input') : { input: typed, expectations: fromExpected, from: 'input' };
	}
	const examples = examplesFrom(problem);
	if (examples.length) {
		return pick(examples, 'problem');
	}
	return { input: '', expectations: fromExpected, from: 'none' };
}

/** The Expected box as one answer per case, or undefined when it is empty. */
function expectedLines(text) {
	const lines = String(text ?? '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map(l => l.replace(/^\s*Output\s*:\s*/i, '').trim())
		.filter(Boolean);
	return lines.length ? lines : undefined;
}

/**
 * Reads an answer as written in a problem statement: JSON, mostly, with
 * Python's own spelling of true, false, null and strings allowed.
 */
function readValue(text) {
	const t = String(text).trim();
	try {
		return { ok: true, value: JSON.parse(t) };
	} catch {
		/* not JSON as written */
	}
	const python = t
		.replace(/\bTrue\b/g, 'true')
		.replace(/\bFalse\b/g, 'false')
		.replace(/\bNone\b/g, 'null')
		.replace(/'/g, '"')
		.replace(/\(/g, '[')
		.replace(/\)/g, ']');
	try {
		return { ok: true, value: JSON.parse(python) };
	} catch {
		return { ok: false };
	}
}

/** LeetCode accepts a floating-point answer within 1e-5. */
const FLOAT_TOLERANCE = 1e-5;

function same(a, b) {
	if (typeof a === 'number' && typeof b === 'number') {
		return a === b || Math.abs(a - b) <= FLOAT_TOLERANCE;
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((v, i) => same(v, b[i]));
	}
	if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every(k => k in b && same(a[k], b[k]));
	}
	return a === b;
}

/** A stable order for "return the answer in any order": by each element's own text. */
function ordered(list) {
	return list.map(v => [JSON.stringify(Array.isArray(v) ? ordered(v) : v), v])
		.sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
		.map(([, v]) => (Array.isArray(v) ? ordered(v) : v));
}

/**
 * Whether a returned answer is the expected one.
 *
 * @param {string} expected As written in the Expected box or the example.
 * @param {{ value: unknown, shown: string }} got The harness's report of one case:
 *        `value` is the answer as plain data (null when it has none), `shown`
 *        its text.
 * @param {{ anyOrder?: boolean }} [opts] The problem says the answer may be in
 *        any order, so a list is compared as a collection.
 */
export function sameAnswer(expected, got, { anyOrder = false } = {}) {
	const want = readValue(expected);
	const hasData = got.value !== null || got.shown === 'null';
	if (want.ok && hasData) {
		if (anyOrder && Array.isArray(want.value) && Array.isArray(got.value)) {
			return same(ordered(want.value), ordered(got.value));
		}
		return same(want.value, got.value);
	}
	// An unquoted string - `AB` for "AB" - is how people type one.
	if (typeof got.value === 'string' && String(expected).trim() === got.value) {
		return true;
	}
	const squash = s => String(s).replace(/\s+/g, '');
	return squash(expected) === squash(got.shown);
}

/**
 * What is different about a wrong answer, when it is something simple enough
 * to state as a fact: reversed, reordered, off by one, the wrong length, or
 * nothing returned at all. Empty when it is none of those.
 *
 * Measured on the 1.5B default: given "AB" expected and "BA" returned, it
 * blamed the arithmetic on a line that was correct. Told the answer is the
 * right letters reversed, the question becomes where the order comes from -
 * which is the bug. Every sentence here is checked, never guessed.
 */
export function differenceOf(expected, got) {
	const want = readValue(expected);
	const wanted = want.ok ? want.value : String(expected).trim();
	const value = got.value;

	if (value === null && got.shown === 'null' && wanted !== null) {
		return 'It returned None - the method finished without returning a value.';
	}
	const sequence = v => typeof v === 'string' || Array.isArray(v);
	if (sequence(wanted) && sequence(value) && typeof wanted === typeof value) {
		const a = typeof wanted === 'string' ? [...wanted] : wanted;
		const b = typeof value === 'string' ? [...value] : value;
		const unit = typeof wanted === 'string' ? 'characters' : 'items';
		if (a.length > 1 && same(a, [...b].reverse())) {
			return `It is the expected answer reversed: the right ${unit}, in the opposite order.`;
		}
		if (a.length === b.length && a.length > 1 && same(ordered(a), ordered(b))) {
			return `It has the right ${unit}, in a different order.`;
		}
		if (a.length !== b.length) {
			return `It has ${b.length} ${unit} where ${a.length} were expected.`;
		}
	}
	if (typeof wanted === 'number' && typeof value === 'number' && Math.abs(wanted - value) === 1) {
		return `It is one ${value > wanted ? 'more' : 'less'} than expected.`;
	}
	return '';
}

/** Whether the problem allows the answer in any order. */
export function anyOrderIn(problem) {
	return /\bin any order\b/i.test(String(problem ?? ''));
}

/**
 * Each case with its verdict: `expected` is undefined where nothing was given,
 * and then `ok` is too.
 */
export function judge(cases, expectations, opts) {
	return (cases ?? []).map((c, i) => {
		const expected = expectations?.[i];
		return expected === undefined
			? { ...c, expected: undefined, ok: undefined }
			: { ...c, expected, ok: sameAnswer(expected, c, opts) };
	});
}

/**
 * A design problem's case, call by call, against the expected list - so the
 * one call that went wrong can be named, rather than two long lists of nulls
 * set side by side to be compared by eye.
 *
 * @param {string|undefined} expected The expected list as written, e.g. "[null,null,-3]".
 * @param {Array<{op: string, args: string, shown: string, value: unknown}>} ops
 * @returns {{ steps: Array<object>, first: number, fits: boolean }} `first` is the
 *          index of the first call that differs, -1 for none; `fits` is false when
 *          the expected list is missing or a different length, and then no call
 *          is marked.
 */
export function designSteps(expected, ops) {
	const want = expected === undefined ? { ok: false } : readValue(expected);
	const list = want.ok && Array.isArray(want.value) && want.value.length === ops.length ? want.value : undefined;
	const steps = ops.map((step, i) => {
		if (!list) {
			return { ...step };
		}
		const wanted = JSON.stringify(list[i]);
		return { ...step, expected: wanted, ok: sameAnswer(wanted, step) };
	});
	return { steps, first: steps.findIndex(s => s.ok === false), fits: Boolean(list) };
}

/** A design call as it is written: "push(-2)", "top()". */
export function callOf(step) {
	return `${step.op}(${step.args})`;
}

/**
 * What is checked about a wrong design case, as a sentence. The calls before
 * the first wrong one matching is worth saying: it puts the bug in what
 * happened between the last right answer and the first wrong one.
 */
export function designFact({ steps, first, fits }, expected) {
	if (!fits) {
		const want = readValue(expected ?? '');
		return want.ok && Array.isArray(want.value)
			? `It made ${steps.length} calls, and the expected answer has ${want.value.length} entries.`
			: '';
	}
	if (first < 0) {
		return '';
	}
	const more = steps.filter(s => s.ok === false).length - 1;
	const after = more > 0 ? `, and ${more} more after it ${more === 1 ? 'differs' : 'differ'} too.` : '.';
	if (first === 0) {
		return `${callOf(steps[0])}, the first call, did not return what was expected${after}`;
	}
	const before = first === 1 ? 'The call before it' : `The ${first} calls before it`;
	return `${before} returned what was expected; ${callOf(steps[first])} is the first that did not${after}`;
}

/** "columnNumber = 1" from "convertToTitle(columnNumber = 1)". */
export function argumentsOf(call, method) {
	const text = String(call ?? '');
	return method && text.startsWith(`${method}(`) && text.endsWith(')')
		? text.slice(method.length + 1, -1)
		: text;
}
