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

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

/** Where the last session is kept, so a restart does not lose work. */
const STATE_DIR = path.join(app.getPath('userData'), 'session');
const STATE_FILE = path.join(STATE_DIR, 'last.json');

/** The file Python actually runs. Kept on disk so tracebacks have a real path. */
const SCRATCH_FILE = path.join(STATE_DIR, 'main.py');

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
 * Resolves the interpreter. `python` on PATH is a 0-byte Windows Store alias on
 * many machines; it forwards correctly when Python came from the Store, so it
 * stays the first choice, with `py -3` behind it for a normal install.
 */
function pythonCommand() {
	if (process.platform === 'win32') {
		return { cmd: 'python', args: [] };
	}
	return { cmd: 'python3', args: [] };
}

ipcMain.handle('run:start', async (_event, code) => {
	killCurrent();

	await fs.mkdir(STATE_DIR, { recursive: true });
	await fs.writeFile(SCRATCH_FILE, typeof code === 'string' ? code : '', 'utf8');

	const { cmd, args } = pythonCommand();
	const started = Date.now();

	return new Promise(resolve => {
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		let child;
		try {
			child = spawn(cmd, [...args, '-X', 'utf8', '-u', SCRATCH_FILE], {
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

		const push = (bucket, chunk) => {
			const text = chunk.toString('utf8');
			if (bucket === 'out') {
				stdout = (stdout + text).slice(0, MAX_OUTPUT_CHARS);
			} else {
				stderr = (stderr + text).slice(0, MAX_OUTPUT_CHARS);
			}
			// Stream it so long-running programs show progress rather than
			// appearing frozen until they exit.
			win?.webContents.send('run:data', { bucket, text });
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
			resolve({
				ok: exitCode === 0 && !timedOut,
				stdout,
				stderr: timedOut
					? `${stderr}\n[stopped after ${RUN_TIMEOUT_MS / 1000}s - is there an infinite loop?]`
					: stderr,
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

ipcMain.handle('app:info', () => ({
	scratch: SCRATCH_FILE,
	platform: process.platform,
	home: os.homedir(),
}));

ipcMain.handle('app:error', async (_event, message) => {
	await dialog.showMessageBox(win, { type: 'error', message: String(message) });
});
