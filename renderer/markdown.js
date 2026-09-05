/*---------------------------------------------------------------------------------------------
 *  myIDE - the little bit of markdown the model is asked to produce.
 *
 *  This is the only place untrusted text reaches innerHTML. A local model is not
 *  an attacker, but its output is not trusted input either: it is influenced by
 *  whatever is in the traceback, which is influenced by whatever the user
 *  pasted. So everything is escaped FIRST, and the handful of tags we do emit
 *  are added afterwards, to text that can no longer contain markup.
 *
 *  Kept in its own module so it can be tested directly - see test/markdown.test.mjs.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

/** Escapes the four characters that matter in element content and attributes. */
export function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, c => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[c]));
}

/**
 * Models that have seen a lot of maths write complexity as \(O(n^2)\) or
 * \[O(n)\]. Nothing here renders LaTeX, so those delimiters arrive as literal
 * backslashes and parentheses and make every complexity answer harder to read
 * than the plain text underneath. Strip the delimiters, keep the content.
 *
 * Runs before escaping, so it cannot be used to smuggle markup through.
 */
function stripMath(md) {
	return md
		.replace(/\\\[([\s\S]*?)\\\]/g, '$1')
		.replace(/\\\(([\s\S]*?)\\\)/g, '$1');
}

/**
 * Renders fenced code blocks, inline code and bold - which is all the prompt
 * asks for. Anything else stays literal text.
 *
 * Order matters: escape, then add tags. Doing it the other way round would let
 * `<img onerror=...>` through inside a code span.
 */
export function render(md) {
	const blocks = stripMath(String(md ?? '')).split(/```(?:[a-z]*)?\n?/i);

	return blocks.map((block, i) => {
		// Odd indices are the insides of fences.
		if (i % 2 === 1) {
			return `<pre><code>${escapeHtml(block.replace(/\n$/, ''))}</code></pre>`;
		}

		return block
			.split(/\n{2,}/)
			.filter(p => p.trim())
			.map(p => `<p>${
				escapeHtml(p.trim())
					.replace(/`([^`]+)`/g, '<code>$1</code>')
					.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
					.replace(/\n/g, '<br>')
			}</p>`)
			.join('');
	}).join('');
}
