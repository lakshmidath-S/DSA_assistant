/*---------------------------------------------------------------------------------------------
 *  myIDE Studio - Monaco bootstrap.
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

require(['vs/editor/editor.main'], () => {
	window.dispatchEvent(new Event('monaco-ready'));
});
