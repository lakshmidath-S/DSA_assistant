/*
 * Lint rules, kept to the ones that catch bugs rather than opinions.
 *
 * This exists because of a specific failure. `psQuote` referred to a `Q` that
 * was never declared, so every attempt to start Ollama threw a ReferenceError
 * inside a promise, was caught by its caller, reported as an ordinary failure,
 * and then hidden because the other server had started. The button appeared to
 * do nothing, and no log said otherwise. `node --check` cannot see that - it
 * only parses - and a bug on a path that runs when you press one particular
 * button is invisible until somebody presses it.
 *
 * So: no-undef is the point of this file. Everything else here is either the
 * same class of mistake (a name assigned but never read, a case that falls
 * through) or noise removal so the real findings are visible.
 */

const BROWSER = {
	window: 'readonly', document: 'readonly', navigator: 'readonly', console: 'readonly',
	fetch: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
	setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
	clearInterval: 'readonly', requestAnimationFrame: 'readonly',
	cancelAnimationFrame: 'readonly', getComputedStyle: 'readonly',
	AbortController: 'readonly', AbortSignal: 'readonly', Blob: 'readonly',
	FileReader: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
	MediaRecorder: 'readonly', AudioContext: 'readonly', Audio: 'readonly',
	Event: 'readonly', CustomEvent: 'readonly', URL: 'readonly',
	// Monaco is loaded by boot.js through its own AMD bundle, and the AMD
	// loader's require/define are globals for the length of that file.
	monaco: 'readonly', require: 'readonly', define: 'readonly',
};

const NODE = {
	require: 'readonly', module: 'writable', exports: 'writable',
	process: 'readonly', Buffer: 'readonly', console: 'readonly',
	__dirname: 'readonly', __filename: 'readonly',
	setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
	clearInterval: 'readonly', URL: 'readonly', fetch: 'readonly',
};

/** The findings worth failing a build over. */
const rules = {
	'no-undef': 'error',
	'no-unused-vars': ['error', {
		args: 'after-used',
		argsIgnorePattern: '^_',
		caughtErrors: 'none',
		varsIgnorePattern: '^_',
	}],
	'no-const-assign': 'error',
	'no-dupe-keys': 'error',
	'no-dupe-args': 'error',
	'no-duplicate-case': 'error',
	'no-func-assign': 'error',
	'no-self-assign': 'error',
	'no-unreachable': 'error',
	'no-fallthrough': 'error',
	'no-sparse-arrays': 'error',
	'use-isnan': 'error',
	'valid-typeof': 'error',
	'require-atomic-updates': 'off',
	// An await inside a loop is how the servers are started in order, and how
	// the trace is replayed; it is deliberate here, not an oversight.
	'no-await-in-loop': 'off',
};

export default [
	{
		ignores: ['node_modules/**', 'dist/**'],
	},
	{
		// The renderer: ES modules in a browser, plus Monaco.
		files: ['renderer/**/*.js'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: BROWSER,
		},
		rules,
	},
	{
		// The Electron main process and the preload bridge: CommonJS in Node.
		files: ['main.js', 'preload.js'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'commonjs',
			globals: NODE,
		},
		rules,
	},
	{
		files: ['test/**/*.mjs', 'eslint.config.mjs'],
		languageOptions: {
			ecmaVersion: 2023,
			sourceType: 'module',
			globals: NODE,
		},
		rules,
	},
];
