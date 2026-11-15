/*
 * The harness runs the user's file, reports what the variables held, and traces
 * the path the run took.
 *
 * Three properties matter, and all of them are easy to break:
 *
 *   1. The traceback it prints, once the marker lines are removed, must be byte
 *      for byte what Python would have printed on its own. The editor parses it
 *      to choose the line to mark, and it is shown verbatim in the output panel.
 *      Running the file through exec() adds a frame of our own, and passing the
 *      path through unnormalised prints forward slashes where Python prints
 *      backslashes - both of which this catches.
 *
 *   2. A clean run must be untouched everywhere the reader can see: same stdout,
 *      same exit code, and nothing on stderr but the marker lines, which the
 *      editor strips. It is no longer marker-free - tracing a run that does not
 *      crash is the whole reason the tracer exists.
 *
 *   3. Tracing must stay bounded. It stops at the cap by switching itself off,
 *      so a hot loop costs the cap and not the loop.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const MARKER = '__MYIDE_VALUES__';
const TRACE = '__MYIDE_TRACE__';
const RESULT = '__MYIDE_RESULT__';
const LOOP = '__MYIDE_LOOP__';
const HARNESS = join(import.meta.dirname, '..', 'python', 'harness.py');
const dir = mkdtempSync(join(tmpdir(), 'myide-harness-'));

/** The interpreter to test with; mirrors what main.js probes for. */
const PYTHON = ['py', 'python3', 'python'].find(cmd => {
	const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
	return r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`);
});
assert.ok(PYTHON, 'no Python 3 found to test against');

function run(argv, env, stdin) {
	const r = spawnSync(PYTHON, ['-X', 'utf8', '-u', ...argv], {
		encoding: 'utf8',
		env: { ...process.env, ...env },
		...(stdin === undefined ? {} : { input: stdin }),
	});
	return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const MARKERS = [MARKER, TRACE, RESULT, LOOP];

/** Splits harness stderr the way main.js does. */
function split(stderr) {
	const lines = stderr.split('\n');
	const parse = prefix => lines
		.filter(l => l.startsWith(prefix))
		.map(l => JSON.parse(l.slice(prefix.length)))[0];

	return {
		values: parse(MARKER),
		trace: parse(TRACE),
		result: parse(RESULT),
		loop: parse(LOOP),
		text: lines.filter(l => !MARKERS.some(m => l.startsWith(m))).join('\n'),
	};
}

const cases = [
	{
		name: 'captures locals from an indented frame',
		source: 'def valid_tree(n, edges):\n    graph = [[] for _ in range(n)]\n    for u, v in edges:\n        graph[u].append(v)\n    return True\n\n\nprint(valid_tree(3, [(0, 1), (9, 0)]))\n',
		expect: v => {
			assert.strictEqual(v.line, 4);
			assert.strictEqual(v.function, 'valid_tree');
			assert.strictEqual(v.locals.u, '9');
			assert.strictEqual(v.locals.n, '3');
			assert.strictEqual(v.locals.graph, '[[1], [], []]');
		},
	},
	{
		name: 'captures at module level',
		source: 'xs = [1, 2, 3]\nprint(xs[9])\n',
		expect: v => {
			assert.strictEqual(v.line, 2);
			assert.strictEqual(v.function, '<module>');
			assert.strictEqual(v.locals.xs, '[1, 2, 3]');
		},
	},
	{
		name: 'a SyntaxError has no values - nothing ran',
		source: 'x = 1\nif x == 1\n    print("hi")\n',
		expect: v => assert.strictEqual(v, undefined),
		expectTrace: t => assert.strictEqual(t, undefined, 'nothing executed, so nothing to trace'),
	},
];

let failed = 0;
for (const c of cases) {
	const file = join(dir, 'case.py');
	writeFileSync(file, c.source, 'utf8');

	const direct = run([file]);
	const harnessed = run([HARNESS, file]);
	const { values, trace, text } = split(harnessed.stderr);

	try {
		assert.strictEqual(text, direct.stderr, 'traceback must survive unchanged');
		assert.strictEqual(harnessed.status, direct.status, 'exit code must match');
		assert.strictEqual(harnessed.stdout, direct.stdout, 'stdout must match');
		c.expect(values);
		c.expectTrace?.(trace);
		console.log(`ok    ${c.name}`);
	} catch (err) {
		console.log(`FAIL  ${c.name}\n        ${err.message}`);
		failed++;
	}
}

// A program that works must come through untouched everywhere the reader can
// see. It does emit a trace marker now - the editor strips it - but nothing
// else may reach stderr, and stdout and the exit code must be identical.
const cleanFile = join(dir, 'clean.py');
writeFileSync(cleanFile, 'print("hello")\nprint(sum([1, 2, 3]))\n', 'utf8');
const clean = run([HARNESS, cleanFile]);
const cleanSplit = split(clean.stderr);
assert.strictEqual(clean.status, 0, 'clean run exits 0');
assert.ok(!clean.stderr.includes(MARKER), 'clean run records no crash values');
assert.strictEqual(cleanSplit.text.trim(), '', 'clean run writes nothing else to stderr');
assert.strictEqual(clean.stdout, execFileSync(PYTHON, ['-X', 'utf8', '-u', cleanFile], { encoding: 'utf8' }));
console.log('ok    a clean run is untouched but for the marker');

// The case the tracer exists for: it finished, so nothing raised and there are
// no values - but the path it took was still recorded.
assert.ok(cleanSplit.trace, 'a run that does not crash is still traced');
assert.strictEqual(cleanSplit.trace.truncated, false);
assert.deepStrictEqual(cleanSplit.trace.steps.map(s => s.line), [1, 2, 2],
	'both lines, then the module frame returning');
console.log('ok    a run that never raises is still traced');

// Changed locals, in order, including a list mutated in place - which compares
// equal by identity and is exactly what a DSA loop does.
const traceFile = join(dir, 'trace.py');
writeFileSync(traceFile,
	'def build(n):\n    out = []\n    for i in range(n):\n        out.append(i * i)\n    return out\n\n\nprint(build(3))\n',
	'utf8');
const traced = split(run([HARNESS, traceFile]).stderr).trace;
assert.ok(traced, 'trace recorded');

const appended = traced.steps.filter(s => s.vars?.out).map(s => s.vars.out);
assert.deepStrictEqual(appended, ['[]', '[0]', '[0, 1]', '[0, 1, 4]'],
	'in-place mutation of a list must register as a change');

const returned = traced.steps.find(s => s.ret !== undefined);
assert.strictEqual(returned.ret, '[0, 1, 4]', 'the return value is recorded');
assert.strictEqual(returned.fn, 'build');
assert.ok(traced.steps.every(s => s.fn === 'build' || s.fn === '<module>'),
	'only the user file is traced - no range(), no harness frames');
console.log('ok    changed locals, in-place mutation, and the return value');

// A caught exception never reaches a traceback, so the trace is the only place
// it is visible - and swallowing one is a real way to print a wrong answer.
const caughtFile = join(dir, 'caught.py');
writeFileSync(caughtFile,
	'total = 0\nfor x in ["1", "two", "3"]:\n    try:\n        total += int(x)\n    except ValueError:\n        pass\nprint(total)\n',
	'utf8');
const caught = split(run([HARNESS, caughtFile]).stderr);
assert.strictEqual(caught.text.trim(), '', 'a caught exception prints nothing');
const exc = caught.trace.steps.filter(s => s.exc);
assert.strictEqual(exc.length, 1, 'the swallowed ValueError is recorded once');
assert.ok(exc[0].exc.startsWith('ValueError:'), exc[0].exc);
assert.strictEqual(exc[0].line, 4);
console.log('ok    a caught exception is recorded');

// A long run keeps both ENDS and drops the middle.
//
// Keeping the first N steps was the wrong half: setup is rarely where the bug
// is, and an answer produced on the last iteration fell off the recording
// entirely. The head is kept whole, the tail rolls, and the middle is dropped
// and counted.
const longFile = join(dir, 'long.py');
writeFileSync(longFile, 'total = 0\nfor i in range(5000):\n    if i == 4999:\n        total = -1\n    else:\n        total += i\nprint(total)\n', 'utf8');

const longTrace = split(run([HARNESS, longFile]).stderr).trace;
assert.ok(longTrace.dropped > 0, 'the middle of a long run is dropped');
assert.strictEqual(longTrace.steps.length, longTrace.limit, 'both ends are kept, and only those');
assert.strictEqual(longTrace.truncated, false, 'it reached the end within its budget');
assert.strictEqual(longTrace.steps[0].line, 1, 'the opening is kept exactly');
assert.strictEqual(longTrace.gapAt, 80, 'the gap is reported where it falls');

// The point of the change: the branch that only runs on the LAST iteration,
// and the print after the loop, are both in the recording.
assert.ok(longTrace.steps.some(s => s.line === 4),
	'the final-iteration branch must be recorded');
assert.ok(longTrace.steps.some(s => s.line === 7),
	'the line after the loop must be recorded');
console.log(`ok    a long run keeps both ends (${longTrace.steps.length} kept, ${longTrace.dropped} dropped)`);

// A genuinely hot loop cannot be traced to its end at any acceptable price, so
// tracing gives itself a wall-clock budget and says plainly that it stopped
// early. Bounded cost matters more here than a complete recording - and the
// prompt is told not to claim the program ended where the recording did.
const hotFile = join(dir, 'hot.py');
writeFileSync(hotFile, 'total = 0\nfor i in range(400000):\n    total += i\nprint(total)\n', 'utf8');

const bareStarted = Date.now();
run([hotFile]);
const bareMs = Date.now() - bareStarted;

const hotStarted = Date.now();
const hot = run([HARNESS, hotFile]);
const hotMs = Date.now() - hotStarted;
const hotTrace = split(hot.stderr).trace;

assert.strictEqual(hot.stdout.trim(), '79999800000', 'the program still runs to completion');
assert.strictEqual(hotTrace.truncated, true, 'it admits it stopped early');
assert.ok(hotMs - bareMs < 4000,
	`tracing must stay within its budget: ${hotMs}ms traced vs ${bareMs}ms bare`);
console.log(`ok    a hot loop is bounded and says so (+${hotMs - bareMs}ms over ${bareMs}ms)`);

// sys.exit codes belong to the program, not the harness.
const exitFile = join(dir, 'exit.py');
writeFileSync(exitFile, 'import sys\nsys.exit(3)\n', 'utf8');
assert.strictEqual(run([HARNESS, exitFile]).status, 3, 'sys.exit code is preserved');
console.log('ok    sys.exit code is preserved');

// --- LeetCode-style solutions ---------------------------------------------------
// A `class Solution` and nothing calling it. The harness calls the method on
// each test case and reports what it RETURNS - the whole answer, since such a
// solution prints nothing.

/** Runs `source` with `input` as the test cases, and returns the split report. */
function solve(name, source, input, env) {
	const file = join(dir, `${name}.py`);
	const casesFile = join(dir, `${name}.json`);
	writeFileSync(file, source, 'utf8');
	writeFileSync(casesFile, JSON.stringify({ input }), 'utf8');
	const r = run([HARNESS, file, casesFile], env);
	return { ...r, ...split(r.stderr) };
}

const shownOf = r => r.result.cases.map(c => c.shown);

const columns = solve('columns', [
	'class Solution:',
	'    def convertToTitle(self, columnNumber: int) -> str:',
	'        ans = []',
	'        while columnNumber > 0:',
	'            columnNumber -= 1',
	'            ans.append(chr(65 + columnNumber % 26))',
	'            columnNumber //= 26',
	'        return "".join(ans[::-1])',
	'',
].join('\n'), 'columnNumber = 1\ncolumnNumber = 28\nInput: columnNumber = 701\nOutput: "ZY"');
assert.strictEqual(columns.status, 0, columns.stderr);
assert.strictEqual(columns.result.method, 'convertToTitle');
assert.deepStrictEqual(shownOf(columns), ['"A"', '"AB"', '"ZY"'],
	'three cases, one per name repeated, an "Input:" prefix and an "Output:" line tolerated');
assert.strictEqual(columns.result.cases[1].call, 'convertToTitle(columnNumber = 28)');
assert.strictEqual(columns.result.cases[1].value, 'AB', 'the plain value, for comparing');
assert.ok(columns.trace.steps.some(s => s.fn === 'convertToTitle'), 'the method itself is traced');
console.log('ok    a Solution is called on each case and what it returns is reported');

const twoSum = solve('twosum', [
	'class Solution:',
	'    def twoSum(self, nums: List[int], target: int) -> List[int]:',
	'        seen = defaultdict(int)',
	'        for i, n in enumerate(nums):',
	'            if target - n in seen:',
	'                return [seen[target - n], i]',
	'            seen[n] = i',
	'',
].join('\n'), '[2,7,11,15]\n9\n[3,2,4]\n6');
assert.strictEqual(twoSum.status, 0, twoSum.text);
assert.deepStrictEqual(shownOf(twoSum), ['[0,1]', '[1,2]'],
	"one value per line, as LeetCode's testcase box has it, two cases of two");
console.log('ok    List and defaultdict work with no import, as on LeetCode');

const reverse = solve('reverse', [
	'class Solution:',
	'    def reverseList(self, head: Optional[ListNode]) -> Optional[ListNode]:',
	'        prev = None',
	'        while head:',
	'            head.next, prev, head = prev, head, head.next',
	'        return prev',
	'',
].join('\n'), 'head = [1,2,3]');
assert.deepStrictEqual(shownOf(reverse), ['[3,2,1]'], 'a list in becomes a ListNode, and back');
assert.ok(reverse.trace.steps.some(s => Object.values(s.vars ?? {}).some(v => v.startsWith('ListNode(1 -> 2 -> 3)'))),
	'a ListNode in the trace reads as its values, not an address');

const depth = solve('depth', [
	'class Solution:',
	'    def maxDepth(self, root: Optional[TreeNode]) -> int:',
	'        if not root:',
	'            return 0',
	'        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))',
	'',
].join('\n'), 'root = [3,9,20,null,null,15,7]');
assert.deepStrictEqual(shownOf(depth), ['3'], 'a level-order list becomes a TreeNode; recursion is fine');
console.log('ok    ListNode and TreeNode, in and out');

const rotate = solve('rotate', [
	'class Solution:',
	'    def rotate(self, nums: List[int], k: int) -> None:',
	'        k %= len(nums)',
	'        nums[:] = nums[-k:] + nums[:-k]',
	'',
].join('\n'), 'nums = [1,2,3,4,5,6,7], k = 3');
assert.deepStrictEqual(shownOf(rotate), ['[5,6,7,1,2,3,4]'], 'an in-place answer is the argument after the call');
assert.strictEqual(rotate.result.cases[0].inPlace, 'nums');
console.log('ok    "modify nums in-place" reports nums');

const helper = solve('helper', [
	'class Solution:',
	'    def count(self, s):',
	'        return len(s)',
	'',
	'    def longest(self, words: List[str]) -> int:',
	'        return max(self.count(w) for w in words)',
	'',
].join('\n'), '["a","abc"]');
assert.strictEqual(helper.result.method, 'longest', 'a method other methods call is a helper, not the answer');
assert.deepStrictEqual(shownOf(helper), ['3']);
console.log('ok    the answer method is chosen over a helper defined above it');

const waiting = solve('waiting', 'class Solution:\n    def f(self, n: int) -> int:\n        return n\n', '');
assert.strictEqual(waiting.result.needsInput, true);
assert.deepStrictEqual(waiting.result.params, ['n']);
assert.strictEqual(waiting.text.trim(), '', 'no input is not an error');

const wrongName = solve('wrongname', 'class Solution:\n    def f(self, n: int) -> int:\n        return n\n', 'x = 3');
assert.match(wrongName.result.inputError, /no parameter called 'x'/);
assert.strictEqual(wrongName.text.trim(), '', 'an input that does not fit is not reported as a crash');
console.log('ok    no input asks for one; input that does not fit says why');

const raises = solve('raises', [
	'class Solution:',
	'    def firstChar(self, words: List[str]) -> str:',
	'        return words[0][0]',
	'',
].join('\n'), 'words = ["ab"]\nwords = [""]');
assert.strictEqual(raises.status, 1);
assert.match(raises.text, /^Traceback \(most recent call last\):\r?\n {2}File ".*raises\.py", line 3, in firstChar\r?\n/,
	'the traceback starts in their method - none of the frames that called it');
assert.ok(!raises.text.includes('harness.py'), 'no harness frame anywhere');
assert.strictEqual(raises.result.failed, 'firstChar(words = [""])', 'which case raised');
assert.deepStrictEqual(shownOf(raises), ['"a"'], 'the cases before it still count');
assert.strictEqual(raises.values.function, 'firstChar');
console.log('ok    a case that raises: their traceback, their values, and which case');

// --- a run that never ends --------------------------------------------------------

const stuckStarted = Date.now();
const stuck = solve('stuck', [
	'class Solution:',
	'    def convertToTitle(self, columnNumber: int) -> str:',
	'        ans = []',
	'        while columnNumber > 0:',
	'            ans.append(chr(65 + (columnNumber - 1) % 26))',
	'        return "".join(ans)',
	'',
].join('\n'), 'columnNumber = 28', { MYIDE_LOOP_AFTER: '1' });
const stuckMs = Date.now() - stuckStarted;
assert.strictEqual(stuck.status, 124, 'it ends itself');
assert.ok(stuckMs < 5000, `reported promptly: ${stuckMs}ms`);
assert.strictEqual(stuck.loop.stuck, true, 'the condition can never change');
assert.deepStrictEqual(stuck.loop.watched, ['columnNumber']);
assert.strictEqual(stuck.loop.loop.line, 4);
assert.strictEqual(stuck.loop.loop.condition, 'columnNumber > 0');
assert.strictEqual(stuck.loop.locals.columnNumber, '28');
assert.ok(stuck.loop.changed.includes('ans'), 'what does change is reported too');
assert.ok(!('self' in stuck.loop.locals), 'self on a Solution is not a value worth showing');
assert.strictEqual(stuck.loop.case, 'convertToTitle(columnNumber = 28)');
assert.ok(stuck.trace?.steps.length, 'the step-through still has the start of the loop');
console.log(`ok    a loop whose condition never changes is caught and named (${stuckMs}ms)`);

const slowFile = join(dir, 'slow.py');
writeFileSync(slowFile, 'i = 0\nwhile i >= 0:\n    i += 1\n', 'utf8');
const slowStarted = Date.now();
const slow = { ...run([HARNESS, slowFile], { MYIDE_LOOP_AFTER: '1', MYIDE_LOOP_GIVE_UP: '2.5' }) };
const slowMs = Date.now() - slowStarted;
const slowLoop = split(slow.stderr).loop;
assert.strictEqual(slow.status, 124);
assert.ok(slowMs >= 2400, `not stopped at the first look, only at the give-up: ${slowMs}ms`);
assert.strictEqual(slowLoop.stuck, false, 'i is changing: maybe slow, maybe never ending - not claimed either way');
assert.strictEqual(slowLoop.seconds, 2.5);
assert.deepStrictEqual(slowLoop.changed, ['i']);
assert.strictEqual(slowLoop.loop.line, 2);
console.log(`ok    a loop that is still changing is given longer, then reported as running (${slowMs}ms)`);

// Slow but finite: the first look sees no stuck loop, so it is left to finish.
const napFile = join(dir, 'nap.py');
writeFileSync(napFile, 'import time\ntime.sleep(1.6)\nprint("woke")\n', 'utf8');
const nap = run([HARNESS, napFile], { MYIDE_LOOP_AFTER: '1', MYIDE_LOOP_GIVE_UP: '4' });
assert.strictEqual(nap.status, 0, 'a slow program that ends is not killed');
assert.strictEqual(nap.stdout.trim(), 'woke');
assert.strictEqual(split(nap.stderr).loop, undefined);
console.log('ok    a slow program that does end is left to finish');

// The cases that finished before the stuck one still have their answers.
const second = solve('second', [
	'class Solution:',
	'    def halve(self, n: int) -> int:',
	'        while n % 2 == 0 and n:',
	'            n // 2',
	'        return n',
	'',
].join('\n'), 'n = 3\nn = 4', { MYIDE_LOOP_AFTER: '1' });
assert.strictEqual(second.status, 124);
assert.strictEqual(second.loop.stuck, true);
assert.strictEqual(second.loop.case, 'halve(n = 4)');
assert.deepStrictEqual(shownOf(second), ['3'], 'case one returned before case two hung');
console.log('ok    a stuck case keeps the answers of the cases before it');

// A plain script is not a Solution and gets none of it.
assert.strictEqual(split(run([HARNESS, cleanFile]).stderr).result, undefined, 'no result for a plain script');
console.log('ok    a plain script is left alone');

// A Solution with its own call at the bottom, and no test cases, is a script
// that happens to use a class: it prints its own answer, and that is the run.
const selfCall = solve('selfcall', [
	'class Solution:',
	'    def twoSum(self, nums: List[int], target: int) -> List[int]:',
	'        seen = {}',
	'        for i, n in enumerate(nums):',
	'            if target - n in seen:',
	'                return [seen[target - n], i]',
	'            seen[n] = i',
	'',
	'print(Solution().twoSum([2, 7, 11, 15], 9))',
	'',
].join('\n'), '');
assert.strictEqual(selfCall.status, 0, selfCall.text);
assert.strictEqual(selfCall.stdout.trim(), '[0, 1]');
assert.strictEqual(selfCall.result, undefined, 'not asked for test cases it does not need');
console.log('ok    a Solution that calls itself runs as the script it is');

// --- design problems: LeetCode's list of operations ---------------------------------

const MIN_STACK = [
	'class MinStack:',
	'    def __init__(self):',
	'        self.s = []',
	'',
	'    def push(self, val: int) -> None:',
	'        self.s.append((val, min(val, self.s[-1][1]) if self.s else val))',
	'',
	'    def pop(self) -> None:',
	'        self.s.pop()',
	'',
	'    def top(self) -> int:',
	'        return self.s[-1][0]',
	'',
	'    def getMin(self) -> int:',
	'        return self.s[-1][1]',
	'',
].join('\n');

// Pasted from the problem page as it is: headings, the expected Output under them.
const minStack = solve('minstack', MIN_STACK, [
	'Example 1:',
	'Input',
	'["MinStack","push","push","push","getMin","pop","top","getMin"]',
	'[[],[-2],[0],[-3],[],[],[],[]]',
	'Output',
	'[null,null,null,null,-3,null,0,-2]',
	'Explanation',
	'MinStack minStack = new MinStack();',
].join('\n'));
assert.strictEqual(minStack.status, 0, minStack.text);
assert.strictEqual(minStack.result.kind, 'design');
assert.strictEqual(minStack.result.cases.length, 1, 'the Output under Input is not a second case');
assert.deepStrictEqual(minStack.result.cases[0].value, [null, null, null, null, -3, null, 0, -2]);
assert.strictEqual(minStack.result.cases[0].shown, '[null,null,null,null,-3,null,0,-2]');
assert.deepStrictEqual(minStack.result.cases[0].ops[1], { op: 'push', args: '-2', shown: 'null', value: null, state: { 'self.s': '[(-2, -2)]' } });
assert.match(minStack.result.cases[0].call, /^MinStack\(\), push\(-2\), push\(0\), push\(-3\), getMin\(\), pop\(\), top\(\), getMin\(\)$/);
assert.ok(minStack.trace.steps.some(s => s.vars?.['self.s'] === '[(-2, -2)]'),
	'what the object holds is traced, as self.s - self alone says nothing');
assert.deepStrictEqual(minStack.result.cases[0].ops.map(s => s.state['self.s']),
	['[]', '[(-2, -2)]', '[(-2, -2), (0, -2)]', '[(-2, -2), (0, -2), (-3, -3)]', '[(-2, -2), (0, -2), (-3, -3)]',
		'[(-2, -2), (0, -2)]', '[(-2, -2), (0, -2)]', '[(-2, -2), (0, -2)]'],
	'and what it held after each call, which is where a design bug shows');
console.log('ok    a design problem: the object is built and every operation called, as pasted');

const designWaiting = solve('designwaiting', MIN_STACK, '');
assert.strictEqual(designWaiting.result.needsInput, true);
assert.strictEqual(designWaiting.result.kind, 'design');
assert.deepStrictEqual(designWaiting.result.methods, ['push', 'pop', 'top', 'getMin']);
assert.deepStrictEqual(designWaiting.result.signatures.push, ['val'], 'so an example can be written in its own names');
assert.strictEqual(designWaiting.text.trim(), '');

const designNamed = solve('designnamed', MIN_STACK, 'val = 3');
assert.match(designNamed.result.inputError, /driven by a list of operations/);
const solutionOps = solve('solutionops', 'class Solution:\n    def f(self, n: int) -> int:\n        return n\n',
	'["MinStack","push"]\n[[],[1]]');
assert.match(solutionOps.result.inputError, /list of operations.*class Solution/);
console.log('ok    a design class asks for operations, and operations for a Solution say why they do not fit');

const designCrash = solve('designcrash', MIN_STACK, '["MinStack","push","pop","top"]\n[[],[1],[],[]]');
assert.strictEqual(designCrash.status, 1);
assert.match(designCrash.text, /IndexError: list index out of range/);
assert.strictEqual(designCrash.result.failed, 'top(), operation 4 of 4', 'which call of which case');
assert.deepStrictEqual(designCrash.result.partial.map(s => s.shown), ['null', 'null', 'null'],
	'the calls before it still count');
assert.strictEqual(designCrash.values.locals['self.s'], '[]', 'the object, as it was when it failed');
console.log('ok    a design call that raises: which call, what came before, and the object at that moment');

// --- input() reads the Input box --------------------------------------------------

const readsFile = join(dir, 'reads.py');
writeFileSync(readsFile, 'a = int(input())\nb = int(input())\nprint(a + b)\n', 'utf8');
const reads = run([HARNESS, readsFile], {}, '3\n4\n');
assert.strictEqual(reads.status, 0, reads.stderr);
assert.strictEqual(reads.stdout.trim(), '7');
const starved = run([HARNESS, readsFile], {}, '3\n');
assert.strictEqual(starved.status, 1);
assert.match(split(starved.stderr).text, /EOFError: EOF when reading a line/);
console.log('ok    input() reads a line of stdin per call, and running out is an EOFError');

// --- a crash beside a large value -------------------------------------------------

const bigFile = join(dir, 'big.py');
writeFileSync(bigFile, 'big = list(range(2_000_000))\nword = "x" * 100_000\nprint(big[len(big)])\n', 'utf8');
const bigStarted = Date.now();
const big = split(run([HARNESS, bigFile]).stderr);
const bigMs = Date.now() - bigStarted;
assert.match(big.values.locals.big, /^\[0, 1, 2, .*2000000 items\]$/);
assert.ok(big.values.locals.big.length < 200, 'a value is a glance, not the whole list');
assert.match(big.values.locals.word, /^'x{200}'\.\.\.$/, 'nor the whole string');
console.log(`ok    a crash beside a two-million-item list reports a glance at it (${bigMs}ms)`);

rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} harness cases passed`);
process.exit(failed ? 1 : 0);
