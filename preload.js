/*---------------------------------------------------------------------------------------------
 *  myIDE - the bridge between the renderer and the main process.
 *
 *  contextIsolation is on and nodeIntegration is off, so the renderer cannot
 *  reach Node directly. This is the whole of its privileged surface: run a
 *  file, stop it, remember the session. Model and speech servers are plain HTTP
 *  on loopback, so the renderer talks to those itself with fetch.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studio', {
	/** Writes the code to disk and runs it. Resolves once the process exits. */
	run: code => ipcRenderer.invoke('run:start', code),

	/** Kills the running process and its children. */
	stop: () => ipcRenderer.invoke('run:stop'),

	/** Output as it arrives, so a slow program is visibly alive. */
	onRunData: handler => {
		const listener = (_event, payload) => handler(payload);
		ipcRenderer.on('run:data', listener);
		return () => ipcRenderer.removeListener('run:data', listener);
	},

	loadSession: () => ipcRenderer.invoke('session:load'),
	saveSession: state => ipcRenderer.invoke('session:save', state),

	info: () => ipcRenderer.invoke('app:info'),

	/** What this machine has: Python, and which model servers are installed. */
	probe: () => ipcRenderer.invoke('setup:probe'),

	/** Brings up every installed model server that is not already running. */
	startServers: only => ipcRenderer.invoke('setup:startServers', only),

	/** Brings up the optional speech server, and what it has said if it failed. */
	startSpeech: () => ipcRenderer.invoke('setup:startSpeech'),
	speechLog: () => ipcRenderer.invoke('setup:speechLog'),
	openUrl: url => ipcRenderer.invoke('setup:openUrl', url),
	reportError: message => ipcRenderer.invoke('app:error', message),
});
