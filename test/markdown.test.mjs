/*
 * Model output is the only untrusted text this app puts into innerHTML. It is
 * shaped by the traceback, which is shaped by whatever the user pasted, so it
 * gets treated as untrusted.
 *
 * The check that matters is which tags actually SURVIVE as markup - not whether
 * the string "onerror=" appears somewhere. Escaped text may legitimately read
 * "&lt;img onerror=...&gt;"; that renders as characters on screen and executes
 * nothing. So: parse out every real tag and assert it is one we meant to emit,
 * carrying no attributes.
 */
import { render, escapeHtml } from '../renderer/markdown.js';
import assert from 'node:assert';

const ALLOWED = new Set(['p', 'br', 'code', 'strong', 'pre', '/p', '/code', '/strong', '/pre']);

/** Every real tag in the output, as it would be parsed by the browser. */
function tagsIn(html) {
	return [...html.matchAll(/<(\/?[a-zA-Z][^\s>\/]*)([^>]*)>/g)]
		.map(m => ({ name: m[1].toLowerCase(), attrs: m[2].trim() }));
}

const attacks = [
	['plain script', '<script>alert(1)</script>'],
	['img onerror', '<img src=x onerror=alert(1)>'],
	['svg onload', '<svg/onload=alert(1)>'],
	['inside inline code', '`<img src=x onerror=alert(1)>`'],
	['inside a fence', '```\n<img src=x onerror=alert(1)>\n```'],
	['inside bold', '**<img src=x onerror=alert(1)>**'],
	['attribute break', '" onmouseover="alert(1)'],
	['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>">'],
	['entity double-encode', '&lt;script&gt;alert(1)&lt;/script&gt;'],
	['nested backtick escape', '`</code><img src=x onerror=alert(1)>`'],
	['bold tag injection', '**</strong><script>alert(1)</script>**'],
	['fence lang injection', '```python"><script>alert(1)</script>\nx\n```'],
	['unclosed fence', '```\n<script>alert(1)</script>'],
	['javascript: url', '[x](javascript:alert(1))'],
	['style injection', '<style>body{background:url(javascript:alert(1))}</style>'],
];

let bad = 0;
for (const [name, payload] of attacks) {
	const html = render(payload);
	const offending = tagsIn(html).filter(t => !ALLOWED.has(t.name) || t.attrs.length > 0);
	if (offending.length) {
		console.log(`FAIL  ${name}`);
		console.log(`        tags: ${JSON.stringify(offending)}`);
		console.log(`        html: ${html}`);
		bad++;
	} else {
		console.log(`ok    ${name}`);
	}
}

assert.match(render('**bold**'), /<strong>bold<\/strong>/, 'bold should render');
assert.match(render('`code`'), /<code>code<\/code>/, 'inline code should render');
assert.match(render('```\nx = 1\n```'), /<pre><code>x = 1<\/code><\/pre>/, 'fence should render');
assert.strictEqual(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;');
assert.strictEqual(render(undefined), '', 'undefined must not throw');
console.log('ok    intended markup still renders');

console.log(`\n${attacks.length - bad}/${attacks.length} payloads neutralised`);
process.exit(bad ? 1 : 0);
