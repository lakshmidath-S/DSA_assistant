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
const HARNESS = join(import.meta.dirname, '..', 'python', 'harness.py');
const dir = mkdtempSync(join(tmpdir(), 'myide-harness-'));

/** The interpreter to test with; mirrors what main.js probes for. */
const PYTHON = ['py', 'python3', 'python'].find(cmd => {
	const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
	return r.status === 0 && /Python 3/.test(`${r.stdout}${r.stderr}`);
});
assert.ok(PYTHON, 'no Python 3 found to test against');

function run(argv) {
	const r = spawnSync(PYTHON, ['-X', 'utf8', '-u', ...argv], { encoding: 'utf8' });
	return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/** Splits harness stderr the way main.js does. */
function split(stderr) {
	const lines = stderr.split('\n');
	const parse = prefix => lines
		.filter(l => l.startsWith(prefix))
		.map(l => JSON.parse(l.slice(prefix.length)))[0];

	return {
		values: parse(MARKER),
		trace: parse(TRACE),
		text: lines.filter(l => !l.startsWith(MARKER) && !l.startsWith(TRACE)).join('\n'),
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

// The cap has to switch tracing off rather than keep paying for it: this loop
// runs 200k times, and a run that recorded all of it would not finish here.
const hotFile = join(dir, 'hot.py');
writeFileSync(hotFile, 'total = 0\nfor i in range(200000):\n    total += i\nprint(total)\n', 'utf8');
const hotStarted = Date.now();
const hot = run([HARNESS, hotFile]);
const hotMs = Date.now() - hotStarted;
const hotTrace = split(hot.stderr).trace;
assert.strictEqual(hot.stdout.trim(), '19999900000', 'the program still runs to completion');
assert.strictEqual(hotTrace.truncated, true, 'the cap was hit');
assert.strictEqual(hotTrace.steps.length, hotTrace.limit, 'and stopped exactly at it');
assert.ok(hotMs < 10_000, `tracing must switch off at the cap, took ${hotMs}ms`);
console.log(`ok    tracing stops at the cap (${hotTrace.limit} steps, ${hotMs}ms)`);

// sys.exit codes belong to the program, not the harness.
const exitFile = join(dir, 'exit.py');
writeFileSync(exitFile, 'import sys\nsys.exit(3)\n', 'utf8');
assert.strictEqual(run([HARNESS, exitFile]).status, 3, 'sys.exit code is preserved');
console.log('ok    sys.exit code is preserved');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} harness cases passed`);
process.exit(failed ? 1 : 0);
