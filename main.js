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
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');

/** Where the last session is kept, so a restart does not lose work. */
const STATE_DIR = path.join(app.getPath('userData'), 'session');
const STATE_FILE = path.join(STATE_DIR, 'last.json');

/** The file Python actually runs. Kept on disk so tracebacks have a real path. */
const SCRATCH_FILE = path.join(STATE_DIR, 'main.py');

/**
 * Runs the file, records the variables at a failure, and traces the path it
 * took. See python/harness.py.
 *
 * Packaged, this cannot live beside the code: __dirname is then inside
 * app.asar, and the archive is readable through Electron's patched fs but not
 * by a Python process spawned from outside it. So it ships as an extra resource
 * and is found next to the asar rather than in it.
 */
const HARNESS = app.isPackaged
	? path.join(process.resourcesPath, 'python', 'harness.py')
	: path.join(__dirname, 'python', 'harness.py');

/** The optional speech server. Spawned by Python, so it cannot live in the asar either. */
const SPEECH_SCRIPT = app.isPackaged
	? path.join(process.resourcesPath, 'servers', 'voice_server.py')
	: path.join(__dirname, 'servers', 'voice_server.py');

/** Where the speech server listens. Mirrors VOICE_ENDPOINT in renderer/voice.js. */
const SPEECH_PORT = 8756;

/**
 * Prefixes of the stderr lines the harness reports through. These are for the
 * editor, not the reader: every one of them is stripped before the output panel
 * sees the text, and before it is parsed as a traceback.
 */
const VALUES_MARKER = '__MYIDE_VALUES__';
const TRACE_MARKER = '__MYIDE_TRACE__';
const MARKERS = [VALUES_MARKER, TRACE_MARKER];

const isMarker = line => MARKERS.some(m => line.startsWith(m));

/** Named so no template in this file has to carry an escape inline. */
const NEWLINE = String.fromCharCode(10);

/** A blank file is the starting point every time, unless a session is restored. */
const BLANK = '';

/** Kill a run that will clearly never finish on its own. */
const RUN_TIMEOUT_MS = 15_000;

/** How long to spend stopping model servers before quitting regardless. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

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
				// Every step here is guarded. An expression that throws in the
				// page used to reject into nothing, which skipped the capture
				// AND the quit - so the window sat there forever and the only
				// symptom was a run that never ended.
				if (process.env.STUDIO_EVAL) {
					try {
						const out = await win.webContents.executeJavaScript(process.env.STUDIO_EVAL);
						console.log(`[eval] ${JSON.stringify(out)}`);
					} catch (err) {
						console.log(`[eval-error] ${err.message}`);
					}
				}
				if (process.env.STUDIO_SHOT_RUN) {
					await win.webContents.executeJavaScript("document.getElementById('run').click()");
					await new Promise(r => setTimeout(r, Number(process.env.STUDIO_SHOT_RUN)));
				}
				if (process.env.STUDIO_SHOT_ASK) {
					await win.webContents.executeJavaScript("document.getElementById('ask').click()");
					await new Promise(r => setTimeout(r, Number(process.env.STUDIO_SHOT_ASK)));
				}
				try {
					// An occluded window stops producing compositor frames, and
					// capturePage then comes back empty - so raise it first.
					win.show();
					win.moveTop();
					await new Promise(r => setTimeout(r, 700));
					const image = await win.webContents.capturePage();
					await fs.writeFile(process.env.STUDIO_SHOT, image.toPNG());
					console.log(`[shot] ${process.env.STUDIO_SHOT}`);
				} catch (err) {
					console.log(`[shot-error] ${err.message}`);
				}
				// Outside the try: quitting is the one step that must happen
				// however the rest went, or the run never ends.
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

/*
 * One copy at a time.
 *
 * There is one scratch file, one session and one idea of whether a model
 * server is already being started, and all three are per process - so a second
 * copy is not a second window, it is a second set of state fighting the first
 * over the same files and the same port. Starting one is easy to do by
 * accident: the shortcut is still there while the first copy is busy, and a
 * busy copy is exactly when someone launches it again.
 *
 * The lock has to be taken before anything else. A copy that does not get it
 * quits without creating a window, and hands its launch to the copy that did.
 */
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		// Raising the existing window is the useful answer to "open it again".
		if (win) {
			if (win.isMinimized()) {
				win.restore();
			}
			win.show();
			win.focus();
		}
	});

	app.whenReady().then(async () => {
		await fs.mkdir(STATE_DIR, { recursive: true });
		createWindow();

		app.on('activate', () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createWindow();
			}
		});
	});
}

app.on('window-all-closed', () => {
	killCurrent();
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

/*
 * Take the model servers down with us - the ones we brought up.
 *
 * A server left running holds several gigabytes of weights and, on a laptop,
 * the GPU with them, which is not a reasonable thing for a closed editor to be
 * doing. Anything that was already running when myIDE opened is left alone:
 * see ourServers.
 *
 * Quitting has to be held open for it. `before-quit` fires and the process
 * leaves immediately unless the default is prevented, which would leave the
 * taskkill half issued - so the first pass stops the servers and quits again
 * once they are gone, with a timeout so a stuck server cannot trap the app.
 */
let shuttingDown = false;

app.on('before-quit', event => {
	killCurrent();

	const ours = Object.values(ourServers).some(Boolean) || Boolean(speechChild);
	if (shuttingDown || !ours) {
		return;
	}

	shuttingDown = true;
	event.preventDefault();
	stopOurServers().finally(() => app.quit());
});

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
 * Pulls the harness's marker lines out of stderr, and returns what should
 * actually be shown.
 *
 * They have to be removed rather than left in place: the editor parses this
 * text as a traceback, and the output panel shows it verbatim.
 */
function extractMarkers(stderr) {
	if (!MARKERS.some(m => stderr.includes(m))) {
		return { values: undefined, trace: undefined, text: stderr };
	}

	let values;
	let trace;
	const kept = [];
	for (const line of stderr.split(NEWLINE)) {
		if (!isMarker(line)) {
			kept.push(line);
			continue;
		}
		const [marker, target] = line.startsWith(VALUES_MARKER)
			? [VALUES_MARKER, 'values']
			: [TRACE_MARKER, 'trace'];
		try {
			const parsed = JSON.parse(line.slice(marker.length));
			if (target === 'values') {
				values = parsed;
			} else {
				trace = parsed;
			}
		} catch {
			// A line truncated by the output cap is not worth failing the run over.
		}
	}

	return { values, trace, text: kept.join(NEWLINE) };
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

		// stderr is streamed a line at a time so the harness's marker lines can
		// be held back: they are for the model, not the reader, and a partial
		// chunk must not leak half of one into the panel.
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
			const shown = parts.filter(l => !isMarker(l));
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

			// What the variables actually held when it failed, and the path the
			// run took. Values are absent for a clean run and for a SyntaxError;
			// a trace is absent only for a SyntaxError, where nothing executed.
			const { values, trace, text: cleanStderr } = extractMarkers(stderr);

			resolve({
				values,
				trace,
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

/**
 * Where LM Studio puts its command line tool, per platform.
 *
 * `lms` is what can start the server without opening the desktop app, and it
 * lives beside the models rather than with the application: `lms bootstrap`
 * creates ~/.lmstudio/bin and puts it on PATH. The app's own executable is not
 * useful here - launching it shows a window and does not necessarily start the
 * server.
 */
function lmStudioCandidates() {
	const home = os.homedir();
	const bin = process.platform === 'win32' ? 'lms.exe' : 'lms';
	return [
		path.join(home, '.lmstudio', 'bin', bin),
		path.join(home, '.cache', 'lm-studio', 'bin', bin),
	];
}

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

/**
 * The first of `candidates` that exists, else whatever is on PATH under `name`.
 *
 * Both halves are needed. The install locations cover the normal case without
 * spawning anything; PATH covers a package manager, or an install moved
 * somewhere of its own, which happens with both of these tools.
 */
async function findBinary(candidates, name) {
	for (const p of candidates) {
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

	return new Promise(resolve => {
		const which = process.platform === 'win32' ? 'where' : 'which';
		let out = '';
		let child;
		try {
			child = spawn(which, [name], { windowsHide: true });
		} catch {
			resolve(undefined);
			return;
		}
		child.stdout.on('data', c => { out += c; });
		child.on('error', () => resolve(undefined));
		child.on('close', code => resolve(code === 0 && out.trim() ? out.trim().split(/\r?\n/)[0] : undefined));
	});
}

const findOllama = () => findBinary(ollamaCandidates(), 'ollama');
const findLmStudio = () => findBinary(lmStudioCandidates(), 'lms');

ipcMain.handle('setup:probe', async () => {
	const python = await resolvePython();
	const [ollamaPath, lmsPath, speechRunning] = await Promise.all([
		findOllama(),
		findLmStudio(),
		portAnswers(SPEECH_PORT),
	]);

	// Voice needs Python and the server script; whether its Python packages are
	// installed is not worth spawning an interpreter to find out on every
	// probe, so that failure surfaces when the server is actually started.
	let speechScript = false;
	try {
		await fs.access(SPEECH_SCRIPT);
		speechScript = true;
	} catch {
		/* not shipped, or moved */
	}

	return {
		platform: process.platform,
		python: python ? { ok: true, ...python } : { ok: false },
		ollamaPath,
		lmsPath,
		speech: {
			possible: Boolean(python) && speechScript,
			running: speechRunning,
		},
	};
});

/** Where Ollama listens. Mirrors PROVIDERS.ollama in renderer/ai.js. */
/** Where each provider listens. Mirrors PROVIDERS in renderer/ai.js. */
const SERVER_PORTS = { ollama: 11434, lmstudio: 1234 };

/**
 * How to start each provider without opening its desktop window.
 *
 * Ollama's CLI *is* the server: `serve` runs until killed. LM Studio's `lms`
 * is a control program - `server start` brings the server up and returns
 * immediately, so the process this spawns is expected to exit at once and its
 * exit code is the thing worth reporting.
 */
const SERVERS = {
	ollama: { label: 'Ollama', find: () => findOllama(), args: ['serve'], stays: true },
	lmstudio: { label: 'LM Studio', find: () => findLmStudio(), args: ['server', 'start'], stays: false },
};

/**
 * What this copy of myIDE started, so it can stop exactly that on the way out.
 *
 * Only what we started. A server that was already running when myIDE opened
 * belongs to whoever started it - someone may be part way through a chat in
 * LM Studio's own window - and closing an editor is not a reason to take it
 * from them. Absent means we did not start it.
 */
const ourServers = { ollama: undefined, lmstudio: undefined };

/** The speech server, if we started it, and what it has told us on stderr. */
let speechChild = null;
let speechLog = '';
let startingServers = false;

/** True when something is already listening there. */
function portAnswers(port, timeoutMs = 1200) {
	return new Promise(resolve => {
		const socket = net.connect({ host: '127.0.0.1', port });
		const done = answered => {
			socket.destroy();
			resolve(answered);
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(false));
		socket.once('error', () => done(false));
	});
}

/**
 * How long after a start attempt to treat that provider as already starting.
 *
 * A cold Ollama takes a few seconds to open its port, which is longer than
 * anyone waits before pressing the button again. Without this the second press
 * sees a closed port and starts a second server.
 */
const START_GRACE_MS = 12_000;
const lastStart = { ollama: 0, lmstudio: 0 };

/** PowerShell's literal string: single quotes, and a quote inside one doubled. */
const psQuote = text => "'" + String(text).split("'").join("''") + "'";

/**
 * Launches a server so that it outlives us, shows nothing, and can be found
 * again to be stopped. Resolves with the server's own pid, where we can learn
 * it - that pid is what lets shutdown stop the one we started rather than
 * every copy on the machine.
 *
 * On Windows neither spawn flag gives all of that, and this was measured
 * rather than assumed: `detached: true` survives the app closing but opens a
 * console window - with Windows Terminal as the default terminal application,
 * that is a Terminal window per press, and repeated presses left twenty-one of
 * them. `detached: false` opens nothing but dies with the app. PowerShell's
 * Start-Process does both, and -PassThru hands back the pid besides.
 *
 * Everywhere else, detaching is the whole story, and the child is its own
 * process group leader so the group can be signalled later.
 */
function launchDetached(name, bin, args) {
	if (process.platform !== 'win32') {
		const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
		child.on('error', err => console.log(`[${name}] could not start: ${err.message}`));
		child.unref();
		return Promise.resolve(child.pid);
	}

	return new Promise(resolve => {
		const list = args.length ? `-ArgumentList ${args.map(psQuote).join(', ')} ` : '';
		const child = spawn('powershell.exe', [
			'-NoProfile', '-NonInteractive', '-Command',
			`(Start-Process -FilePath ${psQuote(bin)} ${list}-WindowStyle Hidden -PassThru).Id`,
		], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

		let out = '';
		child.stdout.on('data', c => { out += c; });
		// An 'error' event with no listener is thrown by EventEmitter, and in the
		// main process that is an uncaught exception that takes the window with it.
		child.on('error', err => {
			console.log(`[${name}] could not start: ${err.message}`);
			resolve(undefined);
		});
		child.on('close', () => {
			const pid = Number(out.trim().split(/\r?\n/).pop());
			resolve(Number.isInteger(pid) && pid > 0 ? pid : undefined);
		});
	});
}

/** Ends a process and everything it started. */
function killTree(pid) {
	return new Promise(resolve => {
		if (!pid) {
			resolve();
		return;
		}
		try {
			if (process.platform === 'win32') {
				// A plain kill leaves the model runners behind; /T takes the tree.
				const t = spawn('taskkill', ['/pid', String(pid), '/f', '/t'], { windowsHide: true });
				t.on('error', () => resolve());
				t.on('close', () => resolve());
				return;
			}
			// Negative pid: the whole group, which detached made this process lead.
			process.kill(-pid, 'SIGTERM');
		} catch {
			/* already gone, which is the outcome we wanted */
		}
		resolve();
	});
}

/**
 * Stops the servers this copy started, and only those.
 *
 * Ollama is a process we know the pid of. LM Studio is stopped through its own
 * CLI, because `lms server start` did not give us a server process to hold -
 * it asked LM Studio to start one, and `lms server stop` is the matching ask.
 */
async function stopOurServers() {
	const jobs = [];

	if (speechChild && !speechChild.killed) {
		const child = speechChild;
		speechChild = null;
		jobs.push(killTree(child.pid));
	}

	if (ourServers.ollama) {
		jobs.push(killTree(ourServers.ollama.pid));
		ourServers.ollama = undefined;
	}

	if (ourServers.lmstudio) {
		const bin = ourServers.lmstudio.bin;
		ourServers.lmstudio = undefined;
		jobs.push(new Promise(resolve => {
			try {
				const stop = spawn(bin, ['server', 'stop'], { stdio: 'ignore', windowsHide: true });
				stop.on('error', () => resolve());
				stop.on('close', () => resolve());
			} catch {
				resolve();
			}
		}));
	}

	// Quitting must not hang on a server that will not go quietly.
	await Promise.race([
		Promise.allSettled(jobs),
		new Promise(resolve => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
	]);
}
/** Starts one provider, or explains why it did not. */
async function startServer(name) {
	const spec = SERVERS[name];

	// Already up, or started so recently that its port has not opened yet.
	// Starting it anyway is what turns a slow start into a pile of processes.
	if (Date.now() - lastStart[name] < START_GRACE_MS) {
		return { name, ok: true, already: true };
	}
	// Someone else's server. We use it, we do not adopt it - and on the way out
	// we leave it exactly as we found it.
	if (await portAnswers(SERVER_PORTS[name])) {
		return { name, ok: true, already: true };
	}

	const bin = await spec.find();
	if (!bin) {
		return { name, ok: false, error: `${spec.label} is not installed.` };
	}

	lastStart[name] = Date.now();

	try {
		if (spec.stays) {
			// `ollama serve` IS the server, so its pid is the thing to remember.
			const pid = await launchDetached(name, bin, spec.args);
			if (!pid) {
				lastStart[name] = 0;
				return { name, ok: false, error: `${spec.label} did not start.` };
			}
			ourServers[name] = { pid, bin };
			return { name, ok: true };
		}

		// `lms server start` is a control command: it asks LM Studio to bring a
		// server up and returns at once, so there is no server process of ours
		// to hold on to - only the matching `lms server stop` to ask later.
		const child = spawn(bin, spec.args, { stdio: 'ignore', windowsHide: true });
		// An 'error' event with no listener is thrown by EventEmitter, and in the
		// main process that is an uncaught exception that takes the window with
		// it. The try/catch around spawn() cannot see it: spawn has returned.
		child.on('error', err => console.log(`[${name}] could not start: ${err.message}`));
		child.on('exit', code => {
			if (code) {
				console.log(`[${name}] launcher exited with ${code}`);
			}
		});
		child.unref();

		ourServers[name] = { bin };
		return { name, ok: true };
	} catch (err) {
		// Let the next press try again immediately: the grace period is there
		// to protect a start that is working, not to sit out one that failed.
		lastStart[name] = 0;
		return { name, ok: false, error: err.message };
	}
}
/**
 * Starts every model server this machine has that is not already running.
 *
 * One button rather than one per provider. Someone with both installed wants
 * both sets of models in the picker, and has no reason to care which of them
 * happens to be running - so the app brings up whatever it finds.
 */
ipcMain.handle('setup:startServers', async (_event, only) => {
	if (startingServers) {
		return { ok: true, already: true, results: [] };
	}

	startingServers = true;
	try {
		// Named providers, or all of them. Starting one is the normal case at
		// launch: the model you were last using needs its own server and not
		// the other one, and loading both would cost gigabytes to no purpose.
		const wanted = Array.isArray(only) ? only.filter(n => SERVERS[n]) : [];
		const names = wanted.length ? wanted : Object.keys(SERVERS);
		const results = [];
		for (const name of names) {
			results.push(await startServer(name));
		}

		// Installed-but-absent is not a failure worth reporting as one: having
		// only Ollama, or only LM Studio, is the normal case. A server that IS
		// installed and still would not start is a real failure, and reporting
		// it as success because the other one came up hid a broken launch
		// completely - the button looked like it had worked.
		const usable = results.filter(r => r.ok);
		const broken = results.filter(r => !r.ok && !/is not installed/.test(r.error ?? ''));

		return {
			ok: usable.length > 0,
			results,
			starting: usable.map(r => r.name),
			failed: broken.map(r => r.name),
			error: broken.length
				? broken.map(r => `${SERVERS[r.name].label}: ${r.error}`).join('; ')
				: (usable.length ? undefined : results.map(r => r.error).filter(Boolean).join(' ')),
		};
	} finally {
		startingServers = false;
	}
});

/**
 * Starts the optional speech server.
 *
 * Separate from the model servers because it is optional, because it is ours
 * rather than someone else's product, and because its first run downloads a
 * few hundred megabytes of Whisper weights - which is the whole reason the
 * renderer needs to be able to tell 'starting' from 'hung'.
 */
ipcMain.handle('setup:startSpeech', async () => {
	if (await portAnswers(SPEECH_PORT)) {
		return { ok: true, already: true };
	}

	const python = await resolvePython();
	if (!python) {
		return { ok: false, error: 'Python 3 is needed for voice, and was not found.' };
	}

	try {
		await fs.access(SPEECH_SCRIPT);
	} catch {
		return { ok: false, error: 'The speech server is not installed.' };
	}

	try {
		// stderr is kept, not ignored: the server logs 'loading model (first
		// use)' and its import failures there, and both are the difference
		// between a useful message and a spinner that never stops.
		const child = spawn(python.cmd, [...python.args, '-X', 'utf8', '-u', SPEECH_SCRIPT], {
			stdio: ['ignore', 'ignore', 'pipe'],
			windowsHide: true,
		});

		child.on('error', err => console.log(`[speech] could not start: ${err.message}`));
		child.stderr.on('data', chunk => {
			const text = String(chunk).trim();
			if (text) {
				console.log(`[speech] ${text}`);
				speechLog = `${speechLog}${text}\n`.slice(-4000);
			}
		});
		child.on('exit', code => {
			console.log(`[speech] exited with ${code}`);
			if (speechChild === child) {
				speechChild = null;
			}
		});

		speechChild = child;
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err.message };
	}
});

/** Whatever the speech server has said on stderr, for reporting a failed start. */
ipcMain.handle('setup:speechLog', () => speechLog);

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
