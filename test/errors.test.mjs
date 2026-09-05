/*
 * The traceback parser is the piece everything visual hangs off: if it picks the
 * wrong line or the wrong span, the editor points confidently at the wrong code,
 * which is worse than pointing at nothing.
 *
 * These cases are not hand-written traceback strings - hand-written ones drift
 * from what Python actually prints, and two details are easy to get wrong (the
 * ~^^^ marker mix, and the re-indentation of the echoed source). Each case runs
 * real Python and parses whatever comes back.
 */
import { parseTraceback, describe, hintFor } from '../renderer/errors.js';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert';

const dir = mkdtempSync(join(tmpdir(), 'myide-errors-'));

/** Runs a snippet and returns what the parser makes of its stderr. */
function parseOf(source) {
	const file = join(dir, 'case.py');
	writeFileSync(file, source, 'utf8');
	let stderr = '';
	try {
		execFileSync('python', ['-X', 'utf8', file], { stdio: ['ignore', 'pipe', 'pipe'] });
	} catch (e) {
		stderr = e.stderr.toString();
	}
	return { parsed: parseTraceback(stderr, file), source };
}

/** The exact text the editor would underline, indentation included. */
function underlined(parsed, source) {
	const line = source.split('\n')[parsed.primary.line - 1] ?? '';
	const indent = line.length - line.trimStart().length;
	return line.slice(indent + (parsed.caretOffset ?? 0), indent + (parsed.markEnd ?? line.length));
}

const cases = [
	{
		name: 'ZeroDivisionError, indented inside a function',
		source: 'def f(n):\n    return 1 / n\n\nprint(f(0))\n',
		line: 2, type: 'ZeroDivisionError', span: '/ n',
	},
	{
		name: 'IndexError at module level',
		source: 'xs = [1, 2, 3]\nprint(xs[10])\n',
		line: 2, type: 'IndexError', span: '[10]',
	},
	{
		name: 'KeyError',
		source: "d = {'a': 1}\nprint(d['b'])\n",
		line: 2, type: 'KeyError', span: "['b']",
	},
	{
		name: 'deep indentation - 16 spaces, echoed by Python as 4',
		source: 'class A:\n    def go(self):\n        for i in range(3):\n            if i > 1:\n                return 1 / 0\nA().go()\n',
		line: 5, type: 'ZeroDivisionError', span: '/ 0',
	},
	{
		name: 'NameError',
		source: 'print(undefined_name)\n',
		line: 1, type: 'NameError',
	},
	{
		name: 'deepest USER frame wins, not the outermost call',
		source: 'def inner(xs):\n    return xs[99]\n\ndef outer(xs):\n    return inner(xs)\n\nprint(outer([1]))\n',
		line: 2, type: 'IndexError', span: '[99]',
	},
	{
		name: 'AttributeError',
		source: 'x = 5\nx.append(1)\n',
		line: 2, type: 'AttributeError',
	},
];

let failed = 0;
for (const c of cases) {
	const { parsed, source } = parseOf(c.source);
	try {
		assert.ok(parsed, 'should parse');
		assert.strictEqual(parsed.type, c.type, 'error type');
		assert.strictEqual(parsed.primary.line, c.line, 'line number');
		assert.ok(parsed.primary.isUser, 'should blame the user file');
		assert.ok(describe(parsed).includes(c.type), 'describe mentions the type');
		assert.ok(hintFor(parsed).length > 0, 'has a hint');
		if (c.span) {
			assert.strictEqual(underlined(parsed, source), c.span, 'underlined span');
		}
		console.log(`ok    ${c.name}`);
	} catch (err) {
		console.log(`FAIL  ${c.name}\n        ${err.message}`);
		failed++;
	}
}

// A clean run must not be reported as an error - inventing one is exactly the
// failure this whole design exists to avoid.
const clean = parseOf('print("fine")\n');
assert.strictEqual(clean.parsed, undefined, 'a clean run must parse to nothing');
console.log('ok    clean run reports no error');

rmSync(dir, { recursive: true, force: true });
console.log(`\n${cases.length - failed}/${cases.length} traceback cases passed`);
process.exit(failed ? 1 : 0);
