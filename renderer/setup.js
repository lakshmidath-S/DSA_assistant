/*---------------------------------------------------------------------------------------------
 *  myIDE - getting a new machine ready.
 *
 *  The point of this app is to keep the DSA debugging loop on your own compute
 *  instead of pasting a whole solution into a cloud chat every time something
 *  breaks. That only works if getting a local model running is easy, so this
 *  does the boring parts: works out what is missing, starts a server that is
 *  installed but not running, and downloads a model with a progress bar.
 *
 *  Nothing here installs software behind your back. The one thing it will do
 *  unprompted is nothing; every action is a button.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import { PROVIDERS, listModels } from './ai.js';

/**
 * Models worth suggesting for this job, smallest first.
 *
 * Debugging a DSA solution from a traceback is a small, bounded task - which is
 * the whole reason a 1.5B model is enough and a cloud model is overkill. The
 * bigger one is offered for people who have the disk and the patience.
 */
export const SUGGESTED = [
	{
		id: 'qwen2.5-coder:1.5b',
		label: 'Qwen2.5 Coder 1.5B',
		size: '~1 GB',
		note: 'Fast on any machine, including CPU only. Plenty for explaining a traceback.',
	},
	{
		id: 'qwen2.5-coder:7b',
		label: 'Qwen2.5 Coder 7B',
		size: '~4.7 GB',
		note: 'Noticeably better reasoning. Wants ~6 GB of RAM or a GPU.',
	},
];

/** Per-platform instructions for the things we cannot install for you. */
export function pythonHelp(platform) {
	switch (platform) {
		case 'win32':
			return {
				text: 'Install Python 3 from python.org, and tick "Add python.exe to PATH" in the installer.',
				url: 'https://www.python.org/downloads/windows/',
			};
		case 'darwin':
			return {
				text: 'Install Python 3 with Homebrew (brew install python) or from python.org.',
				url: 'https://www.python.org/downloads/macos/',
			};
		default:
			return {
				text: 'Install Python 3 with your package manager, e.g. sudo apt install python3.',
				url: 'https://www.python.org/downloads/source/',
			};
	}
}

/**
 * What this machine currently has.
 *
 * `models` stays a list of names, because that is what the picker and the
 * checklist show. `sizes` carries the parameter counts the server was willing
 * to state, for choosing the default - see pickDefaultModel.
 *
 * @returns {Promise<{python: object, platform: string, ollamaPath: string|undefined,
 *                    provider: string|undefined, models: string[],
 *                    sizes: Record<string, number>}>}
 */
export async function probe() {
	const base = await window.studio.probe();

	// Every provider, not just the first one that answers.
	//
	// This used to stop at the first reachable server, so someone running both
	// LM Studio and Ollama only ever saw one set of models - and which set
	// depended on the order of this list. That was invisible while the header
	// merely named the model in use; it became wrong the moment the header
	// turned into a picker, which implies it is showing you everything you have.
	//
	// Asked in parallel: when neither is running, both fail fast, and doing it
	// in sequence would make the checklist wait for two timeouts instead of one.
	const answered = await Promise.all(['lmstudio', 'ollama'].map(async provider => {
		try {
			const found = await listModels(provider);
			return {
				provider,
				models: found.map(m => m.name),
				sizes: Object.fromEntries(
					found.filter(m => m.params !== undefined).map(m => [m.name, m.params]),
				),
			};
		} catch {
			return undefined; // not up
		}
	}));

	const servers = answered.filter(Boolean);

	// The primary is the first server that can actually answer a question. One
	// that is running but has nothing loaded is still worth reporting, because
	// the checklist offers to download into it.
	const primary = servers.find(s => s.models.length) ?? servers[0];

	return {
		...base,
		servers,
		provider: primary?.provider,
		models: primary?.models ?? [],
		sizes: primary?.sizes ?? {},
	};
}

/**
 * True when the machine is ready to explain an error.
 *
 * One server with one model is enough, because that is genuinely enough to
 * answer. Requiring every installed server to be running left the banner
 * nagging for ever at anyone who deliberately uses only one of them - and the
 * app now starts only the server your model needs, so that would be everyone.
 * The other server stays one click away in Settings.
 */
export function isReady(state) {
	return Boolean(state.python?.ok && (state.servers ?? []).some(s => s.models.length));
}

/**
 * Downloads a model through Ollama, reporting progress.
 *
 * /api/pull streams NDJSON: a status line per phase, with completed/total bytes
 * while a layer is transferring.
 */
export async function pullModel(id, onProgress, signal) {
	const res = await fetch(`${PROVIDERS.ollama.endpoint}/api/pull`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		signal,
		body: JSON.stringify({ model: id, stream: true }),
	});

	if (!res.ok) {
		throw new Error(`Ollama refused the download (${res.status}). Is it still running?`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';

	for (;;) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split('\n');
		buffer = lines.pop() ?? '';

		for (const line of lines) {
			if (!line.trim()) {
				continue;
			}
			let frame;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.error) {
				throw new Error(frame.error);
			}
			onProgress({
				status: frame.status ?? '',
				completed: frame.completed ?? 0,
				total: frame.total ?? 0,
			});
		}
	}
}

/**
 * Waits for the given providers to answer, so "Start" can report honestly.
 *
 * Returns the ones that came up, which is not always all of them: LM Studio's
 * server is listening within a second, while a cold Ollama can take several,
 * and one of the two failing should not hide the other succeeding.
 */
export async function waitForProviders(providers, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	const up = new Set();

	while (Date.now() < deadline && up.size < providers.length) {
		await Promise.all(providers
			.filter(p => !up.has(p))
			.map(async p => {
				try {
					await listModels(p);
					up.add(p);
				} catch {
					/* not up yet */
				}
			}));

		if (up.size < providers.length) {
			await new Promise(r => setTimeout(r, 700));
		}
	}

	return [...up];
}

export function formatBytes(n) {
	if (!n) {
		return '';
	}
	const units = ['B', 'KB', 'MB', 'GB'];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
