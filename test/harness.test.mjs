/*
 * The harness runs the user's file and reports what the variables held.
 *
 * Two properties matter, and both are easy to break:
 *
 *   1. The traceback it prints, once the values line is removed, must be byte
 *      for byte what Python would have printed on its own. The editor parses it
 *      to choose the line to mark, and it is shown verbatim in the output panel.
 *      Running the file through exec() adds a frame of our own, and passing the
 *      path through unnormalised prints forward slashes where Python prints
 *      backslashes - both of which this catches.
 *
 *   2. A clean run must be completely untouched: same stdout, no marker, exit 0.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const MARKER = '__MYIDE_VALUES__';
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
	return {
		values: lines.filter(l => l.startsWith(MARKER)).map(l => JSON.parse(l.slice(MARKER.length)))[0],
		text: lines.filter(l => !l.startsWith(MARKER)).join('\n'),
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
	},
];

let failed = 0;
for (const c of cases) {
	const file = join(dir, 'case.py');
	writeFileSync(file, c.source, 'utf8');

	const direct = run([file]);
	const harnessed = run([HARNESS, file]);
	const { values, text } = split(harnessed.stderr);

	try {
		assert.strictEqual(text, direct.stderr, 'traceback must survive unchanged');
		assert.strictEqual(harnessed.status, direct.status, 'exit code must match');
		assert.strictEqual(harnessed.stdout, direct.stdout, 'stdout must match');
		c.expect(values);
		console.log(`ok    ${c.name}`);
	} catch (err) {
		console.log(`FAIL  ${c.name}\n        ${err.message}`);
		failed++;
	}
}

// A program that works must come through completely untouched.
const cleanFile = join(dir, 'clean.py');
writeFileSync(cleanFile, 'print("hello")\nprint(sum([1, 2, 3]))\n', 'utf8');
const clean = run([HARNESS, cleanFile]);
assert.strictEqual(clean.status, 0, 'clean run exits 0');
assert.ok(!clean.stderr.includes(MARKER), 'clean run emits no marker');
assert.strictEqual(clean.stdout, execFileSync(PYTHON, ['-X', 'utf8', '-u', cleanFile], { encoding: 'utf8' }));
console.log('ok    a clean run is untouched');

// sys.exit codes belong to the program, not the harness.
const exitFile = join(dir, 'exit.py');
writeFileSync(exitFile, 'import sys\nsys.exit(3)\n', 'utf8');
assert.strictEqual(run([HARNESS, exitFile]).status, 3, 'sys.exit code is preserved');
console.log('ok    sys.exit code is preserved');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} harness cases passed`);
process.exit(failed ? 1 : 0);
