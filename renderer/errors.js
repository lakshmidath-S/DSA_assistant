/*---------------------------------------------------------------------------------------------
 *  myIDE - reading a Python traceback.
 *
 *  This is the piece that makes the difference between pointing at a real error
 *  and guessing at one. Python has already done the analysis; it reports the
 *  exact file, line, and often the exact column. Parsing that is a few dozen
 *  lines and is never wrong, whereas asking a model to find the bug by reading
 *  the source invites it to invent one.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/**
 * A stack frame as Python prints it:
 *   File "C:\...\main.py", line 12, in <module>
 */
/** Python echoes the offending source under a frame with this fixed indent. */
const ECHO_INDENT = 4;

const FRAME_RE = /^\s*File "(?<file>.+?)", line (?<line>\d+)(?:, in (?<func>.+))?\s*$/;

/**
 * The final line of a traceback: "ZeroDivisionError: division by zero".
 * Bare exceptions with no message ("KeyboardInterrupt") are allowed.
 */
const ERROR_RE = /^(?<type>[A-Za-z_][\w.]*(?:Error|Exception|Interrupt|Exit|Warning))(?::\s*(?<message>.*))?$/;

/**
 * Parses stderr into something that can be pointed at.
 *
 * @param {string} stderr Raw stderr from the run.
 * @param {string} scratchPath Absolute path of the file we executed; frames in
 *        other files (the standard library) are kept for context but never
 *        chosen as the place to put the marker.
 * @returns {{type: string, message: string, frames: Array, primary: object|undefined,
 *            caretOffset: number|undefined, markEnd: number|undefined,
 *            raw: string} | undefined}
 */
export function parseTraceback(stderr, scratchPath) {
	if (!stderr || !stderr.trim()) {
		return undefined;
	}

	const lines = stderr.replace(/\r\n/g, '\n').split('\n');
	const frames = [];
	let type = '';
	let message = '';
	let caretOffset;
	let markEnd;

	for (let i = 0; i < lines.length; i++) {
		const frameMatch = FRAME_RE.exec(lines[i]);
		if (frameMatch) {
			const { file, line, func } = frameMatch.groups;
			// The source line Python echoes under the frame, if it printed one.
			const next = lines[i + 1] ?? '';
			const source = next && !FRAME_RE.test(next) && !next.trim().startsWith('^')
				? next.trim()
				: '';

			frames.push({
				file,
				line: Number(line),
				func: func ?? '<module>',
				source,
				isUser: samePath(file, scratchPath),
			});
			continue;
		}

		// Python points at the offending span with a marker line. Since 3.11 it
		// mixes ~ (the surrounding expression) with ^ (the exact culprit):
		//     return 1 / 0
		//            ~~^~~
		// so a /^\s*\^+$/ test misses almost every modern traceback.
		//
		// These offsets are relative to the TRIMMED source line, because Python
		// discards the original indentation and re-indents the echo to exactly
		// four spaces - a line indented by 16 and one indented by 4 both come
		// back indented by 4. The caller re-adds the real leading whitespace.
		const marker = /^(?<indent>\s*)(?<marks>[~^]*\^[~^]*)\s*$/.exec(lines[i]);
		if (marker) {
			const { indent, marks } = marker.groups;
			caretOffset = Math.max(0, indent.length + marks.indexOf('^') - ECHO_INDENT);
			markEnd = Math.max(caretOffset + 1, indent.length + marks.length - ECHO_INDENT);
			continue;
		}

		const errorMatch = ERROR_RE.exec(lines[i].trim());
		if (errorMatch) {
			type = errorMatch.groups.type;
			message = (errorMatch.groups.message ?? '').trim();
		}
	}

	if (!type && frames.length === 0) {
		return undefined;
	}

	// Point at the deepest frame that is the user's own code. A KeyError raised
	// inside the standard library is still the user's line to fix.
	const userFrames = frames.filter(f => f.isUser);
	const primary = userFrames.length ? userFrames[userFrames.length - 1] : frames[frames.length - 1];

	return { type, message, frames, primary, caretOffset, markEnd, raw: stderr.trim() };
}

/** Windows paths differ in case and slash direction between Python and Electron. */
function samePath(a, b) {
	if (!a || !b) {
		return false;
	}
	const norm = p => p.replace(/\\/g, '/').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * A short, plain sentence for the headline. Deliberately not model-generated:
 * it must be instant and it must be true.
 */
export function describe(parsed) {
	if (!parsed) {
		return '';
	}
	const where = parsed.primary ? ` on line ${parsed.primary.line}` : '';
	return parsed.message
		? `${parsed.type}${where}: ${parsed.message}`
		: `${parsed.type}${where}`;
}

/**
 * The one-line hint shown inline next to the code. Covers the mistakes a
 * beginner actually makes; anything else falls back to Python's own wording,
 * which is already decent in 3.11+.
 */
export function hintFor(parsed) {
	if (!parsed) {
		return '';
	}
	const m = parsed.message;
	switch (parsed.type) {
		case 'IndentationError':
			return 'The indentation here does not line up with the block above.';
		case 'SyntaxError':
			return m.includes('was never closed')
				? 'A bracket opened here is never closed.'
				: 'Python could not parse this line.';
		case 'NameError':
			return `${quoted(m) || 'This name'} is used before it is given a value - check the spelling.`;
		case 'TypeError':
			return 'The values here are not the types this operation expects.';
		case 'IndexError':
			return 'This index is past the end of the sequence.';
		case 'KeyError':
			return `${quoted(m) || 'This key'} is not in the dictionary.`;
		case 'ZeroDivisionError':
			return 'The divisor is zero at this point.';
		case 'AttributeError':
			return 'This object does not have that attribute - check the type.';
		case 'RecursionError':
			return 'The recursion never reaches a base case.';
		case 'ValueError':
			return 'The value is the right type but not an acceptable value.';
		default:
			return m;
	}
}

/** Pulls 'name' out of messages like: name 'foo' is not defined. */
function quoted(message) {
	const m = /'([^']+)'/.exec(message ?? '');
	return m ? `'${m[1]}'` : '';
}
