/*
 * Where a Solution's test cases come from, and whether an answer is right.
 *
 * The examples are copied from LeetCode problem pages as a browser copies them:
 * headings, blank lines, explanations that run over several lines, the
 * constraints after. Getting the cases wrong is quiet - the method is called
 * on something nobody wrote - so each shape is pinned here.
 */
import assert from 'node:assert';
import {
	isSolution, examplesFrom, planRun, sameAnswer, judge, anyOrderIn, argumentsOf, differenceOf,
	designSteps, designFact, callOf,
} from '../renderer/cases.js';

let failed = 0;
let count = 0;
const check = (name, fn) => {
	count++;
	try {
		fn();
		console.log(`ok    ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL  ${name}\n      ${err.message}`);
	}
};

const EXCEL = [
	'Given an integer columnNumber, return its corresponding column title as it appears in an Excel sheet.',
	'',
	'Example 1:',
	'',
	'Input: columnNumber = 1',
	'Output: "A"',
	'Example 2:',
	'',
	'Input: columnNumber = 28',
	'Output: "AB"',
	'Example 3:',
	'',
	'Input: columnNumber = 701',
	'Output: "ZY"',
	' ',
	'',
	'Constraints:',
	'',
	'1 <= columnNumber <= 231 - 1',
].join('\r\n');

const TWO_SUM = [
	'Example 1:',
	'',
	'Input: nums = [2,7,11,15], target = 9',
	'Output: [0,1]',
	'Explanation: Because nums[0] + nums[1] == 9,',
	'we return [0, 1].',
	'Example 2:',
	'',
	'Input: nums = [3,2,4], target = 6',
	'Output: [1,2]',
	'',
	'You can return the answer in any order.',
].join('\n');

check('a Solution is recognised the way the harness recognises it', () => {
	assert.ok(isSolution('class Solution:\n    def f(self): pass'));
	assert.ok(isSolution('from typing import List\n\nclass Solution(object):\n    pass'));
	assert.ok(!isSolution('print(1)'));
	assert.ok(!isSolution('    class Solution:'), 'indented is not top level');
	assert.ok(!isSolution('class SolutionHelper:'));
});

check('examples come out of a problem page, constraints and all', () => {
	assert.deepStrictEqual(examplesFrom(EXCEL), [
		{ input: 'columnNumber = 1', output: '"A"' },
		{ input: 'columnNumber = 28', output: '"AB"' },
		{ input: 'columnNumber = 701', output: '"ZY"' },
	]);
});

check('an explanation over two lines is not part of the output', () => {
	assert.deepStrictEqual(examplesFrom(TWO_SUM), [
		{ input: 'nums = [2,7,11,15], target = 9', output: '[0,1]' },
		{ input: 'nums = [3,2,4], target = 6', output: '[1,2]' },
	]);
});

check('a value that wraps onto the next line is joined back on', () => {
	assert.deepStrictEqual(examplesFrom('Input: grid = [[1,1],\n[0,1]]\nOutput: 3'), [
		{ input: 'grid = [[1,1],\n[0,1]]', output: '3' },
	]);
});

check('text with no examples has none', () => {
	assert.deepStrictEqual(examplesFrom('Return the sum of the list.'), []);
	assert.deepStrictEqual(examplesFrom(''), []);
	assert.deepStrictEqual(examplesFrom(undefined), []);
});

check('typed input is used as it is', () => {
	assert.deepStrictEqual(planRun({ input: 'columnNumber = 28\n', expected: '', problem: EXCEL }),
		{ input: 'columnNumber = 28\n', expectations: undefined, from: 'input' });
});

check('an empty Input box runs the examples in the Problem, with their outputs', () => {
	assert.deepStrictEqual(planRun({ input: '  ', expected: '', problem: EXCEL }), {
		input: 'columnNumber = 1\ncolumnNumber = 28\ncolumnNumber = 701',
		expectations: ['"A"', '"AB"', '"ZY"'],
		from: 'problem',
	});
});

check('a whole example pasted into Input is split into input and output', () => {
	assert.deepStrictEqual(planRun({ input: 'Input: columnNumber = 28\nOutput: "AB"', expected: '' }), {
		input: 'columnNumber = 28', expectations: ['"AB"'], from: 'input',
	});
});

check('the Expected box wins over the examples, one line per case', () => {
	const plan = planRun({ input: '', expected: 'Output: "A"\n\nAB\r\n"ZY"', problem: EXCEL });
	assert.deepStrictEqual(plan.expectations, ['"A"', 'AB', '"ZY"']);
});

check('nothing anywhere asks for input', () => {
	assert.deepStrictEqual(planRun({ input: '', expected: '', problem: '' }),
		{ input: '', expectations: undefined, from: 'none' });
});

check('answers compare as values, not as text', () => {
	assert.ok(sameAnswer('"AB"', { value: 'AB', shown: '"AB"' }));
	assert.ok(sameAnswer('AB', { value: 'AB', shown: '"AB"' }), 'an unquoted string');
	assert.ok(sameAnswer('[0, 1]', { value: [0, 1], shown: '[0,1]' }), 'spacing');
	assert.ok(sameAnswer("['a', 'b']", { value: ['a', 'b'], shown: '["a","b"]' }), 'Python quotes');
	assert.ok(sameAnswer('True', { value: true, shown: 'true' }), 'Python booleans');
	assert.ok(sameAnswer('null', { value: null, shown: 'null' }), 'an empty answer');
	assert.ok(sameAnswer('2.00000', { value: 2, shown: '2' }));
	assert.ok(sameAnswer('2.50000', { value: 2.500001, shown: '2.500001' }), 'within 1e-5');
	assert.ok(!sameAnswer('2.5', { value: 2.51, shown: '2.51' }));
	assert.ok(!sameAnswer('"AB"', { value: 'BA', shown: '"BA"' }));
	assert.ok(!sameAnswer('[0,1]', { value: [1, 0], shown: '[1,0]' }), 'order matters by default');
	assert.ok(!sameAnswer('1', { value: true, shown: 'true' }), 'true is not 1');
	assert.ok(!sameAnswer('[1,2]', { value: [1, 2, 3], shown: '[1,2,3]' }));
});

check('"in any order" compares lists as collections', () => {
	assert.ok(anyOrderIn(TWO_SUM));
	assert.ok(!anyOrderIn(EXCEL));
	assert.ok(sameAnswer('[0,1]', { value: [1, 0], shown: '[1,0]' }, { anyOrder: true }));
	assert.ok(sameAnswer('[[1,2],[3]]', { value: [[3], [2, 1]], shown: '[[3],[2,1]]' }, { anyOrder: true }));
	assert.ok(!sameAnswer('[0,1]', { value: [0, 2], shown: '[0,2]' }, { anyOrder: true }));
});

check('an answer with no plain form is compared by its text', () => {
	assert.ok(sameAnswer('<Thing 3>', { value: null, shown: '<Thing 3>' }));
	assert.ok(!sameAnswer('null', { value: null, shown: '<Thing 3>' }), 'no data is not None');
});

check('each case gets a verdict where there is something to judge it by', () => {
	const cases = [{ shown: '"A"', value: 'A' }, { shown: '"BA"', value: 'BA' }, { shown: '"ZY"', value: 'ZY' }];
	const judged = judge(cases, ['"A"', '"AB"']);
	assert.deepStrictEqual(judged.map(c => c.ok), [true, false, undefined]);
	assert.strictEqual(judged[1].expected, '"AB"');
	assert.deepStrictEqual(judge(cases, undefined).map(c => c.ok), [undefined, undefined, undefined]);
});

check('a simple difference is stated as a fact', () => {
	assert.match(differenceOf('"AB"', { value: 'BA', shown: '"BA"' }), /reversed: the right characters/);
	assert.match(differenceOf('[1,2,3]', { value: [3, 2, 1], shown: '[3,2,1]' }), /reversed: the right items/);
	assert.match(differenceOf('[1,2,3]', { value: [2, 1, 3], shown: '[2,1,3]' }), /right items, in a different order/);
	assert.match(differenceOf('[1,2,3]', { value: [1, 2], shown: '[1,2]' }), /2 items where 3 were expected/);
	assert.match(differenceOf('5', { value: 4, shown: '4' }), /one less than expected/);
	assert.match(differenceOf('5', { value: 6, shown: '6' }), /one more than expected/);
	assert.match(differenceOf('"A"', { value: null, shown: 'null' }), /returned None/);
	assert.match(differenceOf('AB', { value: 'BA', shown: '"BA"' }), /reversed/, 'unquoted expected');
});

check('anything else is left unsaid', () => {
	assert.strictEqual(differenceOf('5', { value: 9, shown: '9' }), '');
	assert.strictEqual(differenceOf('"AB"', { value: 'CD', shown: '"CD"' }), '');
	assert.strictEqual(differenceOf('"A"', { value: 'B', shown: '"B"' }), '', 'one letter cannot be reversed');
	assert.strictEqual(differenceOf('null', { value: null, shown: 'null' }), '');
	assert.strictEqual(differenceOf('<Thing>', { value: null, shown: '<Other>' }), '', 'no data, no claim');
});

// A design problem's example, as the page copies: the headings on lines of
// their own, two lists under Input, and Java under Explanation.
const MIN_STACK = [
	'Design a stack that supports push, pop, top, and retrieving the minimum element in constant time.',
	'',
	'Example 1:',
	'',
	'Input',
	'["MinStack","push","push","push","getMin","pop","top","getMin"]',
	'[[],[-2],[0],[-3],[],[],[],[]]',
	'',
	'Output',
	'',
	'[null,null,null,null,-3,null,0,-2]',
	'',
	'Explanation',
	'MinStack minStack = new MinStack();',
	'minStack.push(-2);',
	'',
	'Constraints:',
	'',
	'-2^31 <= val <= 2^31 - 1',
].join('\n');

check('a design example: bare headings, two lines of input, a value after a blank', () => {
	assert.deepStrictEqual(planRun({ input: '', expected: '', problem: MIN_STACK }), {
		input: '["MinStack","push","push","push","getMin","pop","top","getMin"]\n[[],[-2],[0],[-3],[],[],[],[]]',
		expectations: ['[null,null,null,null,-3,null,0,-2]'],
		from: 'problem',
	});
});

const OPS = [
	{ op: 'MinStack', args: '', shown: 'null', value: null },
	{ op: 'push', args: '-2', shown: 'null', value: null },
	{ op: 'top', args: '', shown: '0', value: 0 },
	{ op: 'getMin', args: '', shown: '-2', value: -2 },
];

check('a design case is judged call by call, and the first wrong call is named', () => {
	const checked = designSteps('[null,null,-2,-2]', OPS);
	assert.deepStrictEqual(checked.steps.map(s => s.ok), [true, true, false, true]);
	assert.strictEqual(checked.steps[2].expected, '-2');
	assert.strictEqual(checked.first, 2);
	assert.strictEqual(designFact(checked),
		'The 2 calls before it returned what was expected; top() is the first that did not.');
	assert.strictEqual(designFact(designSteps('[null,null,-2,-3]', OPS)),
		'The 2 calls before it returned what was expected; top() is the first that did not, and 1 more after it differs too.');
	assert.strictEqual(designFact(designSteps('[1,null,0,-2]', OPS)),
		'MinStack(), the first call, did not return what was expected.');
	assert.strictEqual(callOf(OPS[1]), 'push(-2)');
});

check('an expected answer that does not line up with the calls is said so, not judged', () => {
	const checked = designSteps('[null,null]', OPS);
	assert.strictEqual(checked.fits, false);
	assert.deepStrictEqual(checked.steps.map(s => s.ok), [undefined, undefined, undefined, undefined]);
	assert.strictEqual(designFact(checked, '[null,null]'), 'It made 4 calls, and the expected answer has 2 entries.');
	assert.strictEqual(designFact(designSteps(undefined, OPS), undefined), '');
});

check('the arguments of a call, for a short label', () => {
	assert.strictEqual(argumentsOf('convertToTitle(columnNumber = 1)', 'convertToTitle'), 'columnNumber = 1');
	assert.strictEqual(argumentsOf('f()', 'f'), '');
	assert.strictEqual(argumentsOf('something else', 'f'), 'something else');
});

console.log(`\n${count - failed}/${count} case checks passed`);
process.exit(failed ? 1 : 0);
