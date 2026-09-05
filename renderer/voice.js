/*---------------------------------------------------------------------------------------------
 *  myIDE Studio - push to talk, with visible state.
 *
 *  The old build's voice mode looked broken because nothing on screen changed
 *  while the microphone was open: you held the key, saw nothing, released, and
 *  some seconds later an answer appeared. There was no way to tell recording
 *  from a hang.
 *
 *  Two fixes, both purely presentational and both essential:
 *    1. A live waveform driven by an AnalyserNode, so you can see your own
 *       voice landing. Silence looks like silence; speech looks like speech.
 *    2. Explicit states - listening, transcribing, thinking, speaking - so the
 *       gap between releasing the key and hearing an answer is accounted for.
 *
 *  Talks to the same voice_server.py as the fork: /health, /stt, /tts on :8756.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

'use strict';

export const VOICE_ENDPOINT = 'http://127.0.0.1:8756';

/** Bars in the waveform. Enough to read as a voice, few enough to stay cheap. */
const BAR_COUNT = 48;

export class Voice {
	/**
	 * @param {HTMLCanvasElement} canvas Where the waveform is drawn.
	 * @param {(state: string, detail?: string) => void} onState Told every transition.
	 */
	constructor(canvas, onState) {
		this.canvas = canvas;
		this.onState = onState;
		this.state = 'idle';

		this.stream = undefined;
		this.recorder = undefined;
		this.chunks = [];
		this.audioContext = undefined;
		this.analyser = undefined;
		this.raf = 0;
		/** Smoothed bar heights, so the waveform glides instead of flickering. */
		this.levels = new Array(BAR_COUNT).fill(0);
	}

	setState(state, detail) {
		this.state = state;
		this.onState(state, detail);
	}

	async available() {
		try {
			const res = await fetch(`${VOICE_ENDPOINT}/health`, { signal: AbortSignal.timeout(2000) });
			const json = await res.json();
			return Boolean(json.ready);
		} catch {
			return false;
		}
	}

	/** Opens the microphone and starts drawing. Held open until stop(). */
	async start() {
		if (this.state !== 'idle') {
			return;
		}
		this.setState('listening');
		this.chunks = [];

		try {
			this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
		} catch (err) {
			this.setState('idle');
			throw new Error('Could not open the microphone. Check Windows microphone permissions.');
		}

		this.audioContext = new AudioContext();
		const source = this.audioContext.createMediaStreamSource(this.stream);
		this.analyser = this.audioContext.createAnalyser();
		this.analyser.fftSize = 1024;
		this.analyser.smoothingTimeConstant = 0.7;
		source.connect(this.analyser);

		this.recorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm' });
		this.recorder.ondataavailable = e => {
			if (e.data.size > 0) {
				this.chunks.push(e.data);
			}
		};
		this.recorder.start();

		this.draw();
	}

	/**
	 * Closes the microphone and transcribes.
	 * @returns {Promise<string>} the recognised text, or '' if nothing was said.
	 */
	async stop() {
		if (this.state !== 'listening') {
			return '';
		}

		const recorded = new Promise(resolve => {
			this.recorder.onstop = () => resolve(new Blob(this.chunks, { type: 'audio/webm' }));
		});
		this.recorder.stop();
		const blob = await recorded;

		this.teardown();
		this.setState('transcribing');

		// Too short to be speech - almost always a mis-tap of the key.
		if (blob.size < 2000) {
			this.setState('idle');
			return '';
		}

		const base64 = await blobToBase64(blob);
		try {
			const res = await fetch(`${VOICE_ENDPOINT}/stt`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ audio: base64, format: 'webm' }),
			});
			if (!res.ok) {
				throw new Error(`speech server returned ${res.status}`);
			}
			const json = await res.json();
			this.setState('idle');
			return (json.text ?? '').trim();
		} catch (err) {
			this.setState('idle');
			throw err;
		}
	}

	/** Speaks a line back. Failure here is never fatal - the text is on screen. */
	async speak(text) {
		if (!text || !text.trim()) {
			return;
		}
		try {
			this.setState('speaking');
			const res = await fetch(`${VOICE_ENDPOINT}/tts`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ text: text.slice(0, 600) }),
			});
			const json = await res.json();
			const audio = new Audio(`data:audio/wav;base64,${json.audio}`);
			await audio.play();
			await new Promise(resolve => { audio.onended = resolve; });
		} catch {
			/* speech is a convenience; the answer is already rendered */
		} finally {
			this.setState('idle');
		}
	}

	teardown() {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.stream?.getTracks().forEach(t => t.stop());
		this.audioContext?.close();
		this.stream = undefined;
		this.audioContext = undefined;
		this.analyser = undefined;
		this.clear();
	}

	/** One animation frame of the waveform. */
	draw() {
		if (!this.analyser) {
			return;
		}
		const ctx = this.canvas.getContext('2d');
		const dpr = window.devicePixelRatio || 1;
		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;

		if (this.canvas.width !== width * dpr) {
			this.canvas.width = width * dpr;
			this.canvas.height = height * dpr;
		}
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, width, height);

		const bins = new Uint8Array(this.analyser.frequencyBinCount);
		this.analyser.getByteFrequencyData(bins);

		// Voice energy sits low in the spectrum; using the whole range would
		// leave most bars permanently flat.
		const usable = Math.floor(bins.length * 0.4);
		const per = Math.max(1, Math.floor(usable / BAR_COUNT));

		const barWidth = width / BAR_COUNT;
		for (let i = 0; i < BAR_COUNT; i++) {
			let sum = 0;
			for (let j = 0; j < per; j++) {
				sum += bins[i * per + j] ?? 0;
			}
			const target = (sum / per) / 255;
			// Ease toward the target so bars glide rather than strobe.
			this.levels[i] += (target - this.levels[i]) * 0.35;

			const h = Math.max(2, this.levels[i] * height * 0.9);
			const x = i * barWidth;
			const y = (height - h) / 2;

			ctx.fillStyle = `hsl(${190 + this.levels[i] * 60}, 85%, ${45 + this.levels[i] * 25}%)`;
			ctx.beginPath();
			ctx.roundRect(x + barWidth * 0.2, y, barWidth * 0.6, h, barWidth * 0.3);
			ctx.fill();
		}

		this.raf = requestAnimationFrame(() => this.draw());
	}

	clear() {
		const ctx = this.canvas.getContext('2d');
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.levels.fill(0);
	}
}

function blobToBase64(blob) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onloadend = () => resolve(String(reader.result).split(',')[1]);
		reader.onerror = reject;
		reader.readAsDataURL(blob);
	});
}
