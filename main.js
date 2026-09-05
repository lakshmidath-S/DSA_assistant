/*---------------------------------------------------------------------------------------------
 *  myIDE - Electron shell.
 *
 *  One window, one Python file, one Run button. Everything the workbench gave
 *  us for free and then charged us for in complexity - extensions, SCM, a
 *  command palette, a chat panel - is deliberately absent.
 *
 *  The main process owns exactly three things the renderer must not: spawning
 *  Python, reading and writing the scratch file, and remembering the last
 *  session. Everything else lives in renderer/.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/** Where the last session is kept, so a restart does not lose work. */
const STATE_DIR = path.join(app.getPath('userData'), 'session');
const STATE_FILE = path.join(STATE_DIR, 'last.json');

/** The file Python actually runs. Kept on disk so tracebacks have a real path. */
const SCRATCH_FILE = path.join(STATE_DIR, 'main.py');

/** Runs the file and records the variables at a failure. See python/harness.py. */
const HARNESS = path.join(__dirname, 'python', 'harness.py');

/** Prefix of the stderr line the harness uses to report captured values. */
const VALUES_MARKER = '__MYIDE_VALUES__';

/** Named so no template in this file has to carry an escape inline. */
const NEWLINE = String.fromCharCode(10);

/** A blank file is the starting point every time, unless a session is restored. */
const BLANK = '';

/** Kill a run that will clearly never finish on its own. */
const RUN_TIMEOUT_MS = 15_000;

/** Cap captured output so a runaway loop cannot exhaust memory. */
const MAX_OUTPUT_CHARS = 200_000;

let win = null;
/** The in-flight Python process, so Stop and re-Run can end it. */
let current = null;

function createWindow() {
	win = new BrowserWindow({
		width: 1180,
		height: 780,
		minWidth: 720,
		minHeight: 480,
		backgroundColor: '#101014',
		title: 'myIDE',
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// The preload uses only ipcRenderer and contextBridge, both of which
			// work sandboxed - so there is no reason to leave Node reachable
			// from a renderer that displays model output.
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			experimentalFeatures: false,
		},
	});

	// Renderer problems are otherwise invisible: a failed stylesheet or a thrown
	// module leaves a blank window and nothing on the terminal.
	win.webContents.on('console-message', (...args) => {
		// Electron 35 replaced the positional (event, level, message, line,
		// source) signature with a single details object; accept either.
		const d = args.length === 1 || (args[1] && typeof args[1] === 'object')
			? (args.length === 1 ? args[0] : args[1])
			: { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] };
		console.log(`[renderer:${d.level}] ${d.message} (${d.sourceId}:${d.lineNumber})`);
	});
	win.webContents.on('did-fail-load', (_e, code, desc, url) => {
		console.log(`[did-fail-load] ${code} ${desc} ${url}`);
	});
	win.webContents.on('render-process-gone', (_e, details) => {
		console.log(`[render-process-gone] ${JSON.stringify(details)}`);
	});

	// STUDIO_SHOT=<path> captures the rendered page once and exits. Used to
	// verify the UI without a human at the keyboard; capturePage goes through
	// the compositor, unlike PrintWindow which comes back blank on GPU windows.
	if (process.env.STUDIO_SHOT && !app.isPackaged) {
		win.webContents.once('did-finish-load', () => {
			setTimeout(async () => {
				if (process.env.STUDIO_EVAL) {
					const out = await win.webContents.executeJavaScript(process.env.STUDIO_EVAL);
					console.log(`[eval] ${JSON.stringify(out)}`);
				}
				if (process.env.STUDIO_SHOT_RUN) {
					await win.webContents.executeJavaScript("document.getElementById('run').click()");
					await new Promise(r => setTimeout(r, Number(process.env.STUDIO_SHOT_RUN)));
				}
				if (process.env.STUDIO_SHOT_ASK) {
					await win.webContents.executeJavaScript("document.getElementById('ask').click()");
					await new Promise(r => setTimeout(r, Number(process.env.STUDIO_SHOT_ASK)));
				}
				// An occluded window stops producing compositor frames, and
				// capturePage then comes back empty - so raise it first.
				win.show();
				win.moveTop();
				await new Promise(r => setTimeout(r, 700));
				const image = await win.webContents.capturePage();
				await fs.writeFile(process.env.STUDIO_SHOT, image.toPNG());
				console.log(`[shot] ${process.env.STUDIO_SHOT}`);
				if (process.env.STUDIO_SHOT_EXIT) { app.quit(); }
			}, Number(process.env.STUDIO_SHOT_DELAY ?? 2500));
		});
	}

	// This window only ever shows its own local page. Anything that tries to
	// navigate it or spawn a second window is refused: a renderer that has been
	// talked into loading a remote origin would carry the preload bridge with it.
	win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	win.webContents.on('will-navigate', (event, url) => {
		if (url !== win.webContents.getURL()) {
			event.preventDefault();
			console.log(`[blocked navigation] ${url}`);
		}
	});
	win.webContents.on('will-attach-webview', event => event.preventDefault());

	win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
	win.on('closed', () => { win = null; });
}

app.whenReady().then(async () => {
	await fs.mkdir(STATE_DIR, { recursive: true });
	createWindow();

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', () => {
	killCurrent();
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

app.on('before-quit', killCurrent);

function killCurrent() {
	if (current && !current.killed) {
		try {
			// On Windows a plain kill leaves the child's own children behind;
			// taskkill /T takes the tree with it.
			if (process.platform === 'win32') {
				spawn('taskkill', ['/pid', String(current.pid), '/f', '/t']);
			} else {
				current.kill('SIGKILL');
			}
		} catch {
			/* the process is already gone, which is what we wanted */
		}
	}
	current = null;
}

// --- session ------------------------------------------------------------------
// Kept deliberately small: the code, and where the caret was. No workspace, no
// window layout, no list of open editors - there is only ever one file.

ipcMain.handle('session:load', async () => {
	try {
		const raw = await fs.readFile(STATE_FILE, 'utf8');
		const state = JSON.parse(raw);
		return {
			code: typeof state.code === 'string' ? state.code : BLANK,
			line: Number.isFinite(state.line) ? state.line : 1,
			column: Number.isFinite(state.column) ? state.column : 1,
		};
	} catch {
		// No session yet, or it was corrupt. Either way: start blank.
		return { code: BLANK, line: 1, column: 1 };
	}
});

ipcMain.handle('session:save', async (_event, state) => {
	try {
		await fs.mkdir(STATE_DIR, { recursive: true });
		await fs.writeFile(STATE_FILE, JSON.stringify(state ?? {}), 'utf8');
		return true;
	} catch {
		return false;
	}
});

// --- running python -----------------------------------------------------------

/**
 * Candidate interpreters, best first.
 *
 * No single name works everywhere. On Windows `python` is often a 0-byte Store
 * alias that forwards correctly when Python came from the Store and opens the
 * Store when it did not, so the `py` launcher is tried first. On macOS `python`
 * may still be a 2.7 stub. On Linux either name can be missing.
 */
const PYTHON_CANDIDATES = process.platform === 'win32'
	? [['py', ['-3']], ['python', []], ['python3', []]]
	: [['python3', []], ['python', []]];

/** Resolved once and reused; probing spawns processes and is not free. */
let pythonResolved;

/**
 * Finds a working Python 3. Returns undefined when there is none, so the UI can
 * say so instead of every run failing with a spawn error.
 */
async function resolvePython() {
	if (pythonResolved !== undefined) {
		return pythonResolved || undefined;
	}

	for (const [cmd, args] of PYTHON_CANDIDATES) {
		const version = await new Promise(resolve => {
			let out = '';
			let child;
			try {
				child = spawn(cmd, [...args, '--version'], { windowsHide: true });
			} catch {
				resolve(undefined);
				return;
			}
			// A Store alias can hang instead of answering; do not wait forever.
			const timer = setTimeout(() => { child.kill(); resolve(undefined); }, 4000);
			child.stdout.on('data', c => { out += c; });
			child.stderr.on('data', c => { out += c; });   // 2.x prints to stderr
			child.on('error', () => { clearTimeout(timer); resolve(undefined); });
			child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
		});

		const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(version ?? '');
		if (m && Number(m[1]) >= 3) {
			pythonResolved = { cmd, args, version: `${m[1]}.${m[2]}.${m[3]}` };
			return pythonResolved;
		}
	}

	pythonResolved = null;
	return undefined;
}


/**
 * Pulls the harness's values line out of stderr, and returns what should
 * actually be shown.
 *
 * The line has to be removed rather than left in place: the editor parses this
 * text as a traceback, and the output panel shows it verbatim.
 */
function extractValues(stderr) {
	if (!stderr.includes(VALUES_MARKER)) {
		return { values: undefined, text: stderr };
	}

	let values;
	const kept = [];
	for (const line of stderr.split(NEWLINE)) {
		if (!line.startsWith(VALUES_MARKER)) {
			kept.push(line);
			continue;
		}
		try {
			values = JSON.parse(line.slice(VALUES_MARKER.length));
		} catch {
			// A truncated line is not worth failing the run over.
		}
	}

	return { values, text: kept.join(NEWLINE) };
}

ipcMain.handle('run:start', async (_event, code) => {
	killCurrent();

	await fs.mkdir(STATE_DIR, { recursive: true });
	await fs.writeFile(SCRATCH_FILE, typeof code === 'string' ? code : '', 'utf8');

	const python = await resolvePython();
	if (!python) {
		return {
			ok: false,
			stdout: '',
			stderr: 'no-python',
			code: -3,
			ms: 0,
			file: SCRATCH_FILE,
		};
	}

	const { cmd, args } = python;
	const started = Date.now();

	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		let child;
		try {
			child = spawn(cmd, [...args, '-X', 'utf8', '-u', HARNESS, SCRATCH_FILE], {
				cwd: STATE_DIR,
				windowsHide: true,
				env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
			});
		} catch (err) {
			resolve({ ok: false, stdout: '', stderr: String(err), code: -1, ms: 0, file: SCRATCH_FILE });
			return;
		}

		current = child;

		const timer = setTimeout(() => {
			timedOut = true;
			killCurrent();
		}, RUN_TIMEOUT_MS);

		// stderr is streamed a line at a time so the harness's values marker can
		// be held back: it is for the model, not the reader, and a partial chunk
		// must not leak half of it into the panel.
		let errTail = '';
		const push = (bucket, chunk) => {
			const text = chunk.toString('utf8');
			if (bucket === 'out') {
				stdout = (stdout + text).slice(0, MAX_OUTPUT_CHARS);
			} else {
				stderr = (stderr + text).slice(0, MAX_OUTPUT_CHARS);
			}
			// Stream it so long-running programs show progress rather than
			// appearing frozen until they exit.
			if (bucket !== 'err') {
				win?.webContents.send('run:data', { bucket, text });
				return;
			}
			errTail += text;
			const parts = errTail.split(NEWLINE);
			errTail = parts.pop() ?? '';
			const shown = parts.filter(l => !l.startsWith(VALUES_MARKER));
			if (shown.length) {
				win?.webContents.send('run:data', { bucket, text: shown.join(NEWLINE) + NEWLINE });
			}
		};

		child.stdout.on('data', c => push('out', c));
		child.stderr.on('data', c => push('err', c));

		child.on('error', err => {
			clearTimeout(timer);
			current = null;
			resolve({
				ok: false,
				stdout,
				stderr: `${stderr}\nCould not start Python: ${err.message}`,
				code: -1,
				ms: Date.now() - started,
				file: SCRATCH_FILE,
			});
		});

		child.on('close', exitCode => {
			clearTimeout(timer);
			current = null;

			// What the variables actually held when it failed. Absent for a clean
			// run, and for a SyntaxError, where nothing ever executed.
			const { values, text: cleanStderr } = extractValues(stderr);

			resolve({
				values,
				ok: exitCode === 0 && !timedOut,
				stdout,
				stderr: timedOut
					? `${cleanStderr}\n[stopped after ${RUN_TIMEOUT_MS / 1000}s - is there an infinite loop?]`
					: cleanStderr,
				code: timedOut ? -2 : exitCode,
				ms: Date.now() - started,
				file: SCRATCH_FILE,
				timedOut,
			});
		});
	});
});

ipcMain.handle('run:stop', () => {
	killCurrent();
	return true;
});

// --- setup --------------------------------------------------------------------
// A first run on a machine that has neither Python nor a model server should
// explain itself rather than just failing. Everything here is detection plus one
// action: starting a server that is installed but not running.

/** Where Ollama installs itself, per platform. */
function ollamaCandidates() {
	const home = os.homedir();
	if (process.platform === 'win32') {
		return [
			path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
			'C:\\Program Files\\Ollama\\ollama.exe',
		];
	}
	if (process.platform === 'darwin') {
		return ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama', '/Applications/Ollama.app/Contents/Resources/ollama'];
	}
	return ['/usr/local/bin/ollama', '/usr/bin/ollama', path.join(home, '.local', 'bin', 'ollama')];
}

async function findOllama() {
	for (const p of ollamaCandidates()) {
		if (!p) {
			continue;
		}
		try {
			await fs.access(p);
			return p;
		} catch {
			/* try the next location */
		}
	}
	// Fall back to PATH: a package manager may have put it somewhere else.
	return new Promise(resolve => {
		const which = process.platform === 'win32' ? 'where' : 'which';
		let out = '';
		let child;
		try {
			child = spawn(which, ['ollama'], { windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		child.stdout.on('data', c => { out += c; });
		child.on('error', () => resolve(undefined));
		child.on('close', code => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : undefined));
	});
}

ipcMain.handle('setup:probe', async () => {
	const python = await resolvePython();
	return {
		platform: process.platform,
		python: python ? { ok: true, ...python } : { ok: false },
		ollamaPath: await findOllama(),
	};
});

/**
 * Starts a model server that is installed but not running - the single most
 * common reason the AI panel is dead on a fresh machine. Detached, so closing
 * myIDE does not take the server with it.
 */
ipcMain.handle('setup:startOllama', async () => {
	const bin = await findOllama();
	if (!bin) {
		return { ok: false, error: 'Ollama is not installed.' };
	}
	try {
		const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
		child.unref();
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

/** Opens a URL in the real browser - never inside this window. */
ipcMain.handle('setup:openUrl', async (_event, url) => {
	if (typeof url !== 'string' || !/^https:\/\//.test(url)) {
		return false;
	}
	await shell.openExternal(url);
	return true;
});

ipcMain.handle('app:info', () => ({
	scratch: SCRATCH_FILE,
	platform: process.platform,
	home: os.homedir(),
}));

ipcMain.handle('app:error', async (_event, message) => {
	await dialog.showMessageBox(win, { type: 'error', message: String(message) });
});
