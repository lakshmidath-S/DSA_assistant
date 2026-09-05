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
 * @returns {Promise<{python: object, platform: string, ollamaPath: string|undefined,
 *                    provider: string|undefined, models: string[]}>}
 */
export async function probe() {
	const base = await window.studio.probe();

	for (const provider of ['lmstudio', 'ollama']) {
		try {
			const models = await listModels(provider);
			if (models.length) {
				return { ...base, provider, models };
			}
			// Reachable but empty: still the provider to talk to, once it has a model.
			return { ...base, provider, models: [] };
		} catch {
			/* not up; try the next */
		}
	}

	return { ...base, provider: undefined, models: [] };
}

/** True when the machine is ready to explain an error. */
export function isReady(state) {
	return Boolean(state.python?.ok && state.provider && state.models.length);
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

/** Waits for a provider to answer, so "Start" can report success honestly. */
export async function waitForProvider(provider, timeoutMs = 20000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await listModels(provider);
			return true;
		} catch {
			await new Promise(r => setTimeout(r, 700));
		}
	}
	return false;
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
