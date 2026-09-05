/*---------------------------------------------------------------------------------------------
 *  myIDE - Monaco bootstrap.
 *
 *  A separate file rather than an inline <script> because the page's CSP is
 *  script-src 'self': an inline block is refused outright, which leaves Monaco
 *  unloaded and the window blank with no other symptom. Keeping it external
 *  means the policy stays tight - no 'unsafe-inline'.
 *
 *  'unsafe-eval' is still required: Monaco's AMD loader compiles modules with
 *  the Function constructor.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

require.config({ paths: { vs: '../node_modules/monaco-editor/min/vs' } });

/*
 * A promise rather than an event. This file is a classic script so it runs
 * during parsing, while app.js is a module and therefore deferred - if Monaco
 * resolves from a warm cache before app.js executes, a one-shot 'monaco-ready'
 * event fires with nobody listening and the editor never initialises. The
 * promise cannot be missed, however the race turns out.
 */
window.monacoLoaded = new Promise(resolve => {
	require(['vs/editor/editor.main'], () => resolve());
});
