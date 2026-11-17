/**
 * Records one loop from the microphone, sample-accurately, between two
 * AudioContext times. An AudioWorklet sees every input sample with its exact
 * frame number, so the take lines up with the bar grid without guessing
 * MediaRecorder timing.
 *
 * Latency: what you play in response to a sound you heard at time T reaches
 * the worklet at roughly T + output latency + input latency, so the capture
 * window is shifted later by that amount.
 *
 * `?fakemic` in the URL (or localStorage `unmix.fakemic` = "1") replaces the microphone with a generated test signal
 * (a short blip on every beat), so the whole path can be tested in the
 * emulator without a microphone.
 */

const WORKLET_SOURCE = `
class UnmixRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.from = 0;
    this.to = 0;
    this.active = false;
    this.port.onmessage = (event) => {
      this.from = event.data.from;
      this.to = event.data.to;
      this.active = true;
    };
  }
  process(inputs) {
    if (!this.active) return true;
    const channel = inputs[0] && inputs[0][0];
    const start = currentFrame;
    const end = start + 128;
    if (end > this.from && channel) {
      this.port.postMessage({ frame: start, data: channel.slice(0) });
    }
    if (end >= this.to) {
      this.active = false;
      this.port.postMessage({ done: true });
    }
    return true;
  }
}
registerProcessor('unmix-recorder', UnmixRecorder);
`;

export type MicError = 'denied' | 'unavailable';

export class LoopRecorder {
  private readonly ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private input: AudioNode | null = null;
  private inputLatency = 0;
  private readonly fake: boolean;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    let flag = false;
    try {
      flag = localStorage.getItem('unmix.fakemic') === '1';
    } catch {
      // storage unavailable
    }
    this.fake = flag || new URLSearchParams(window.location.search).has('fakemic');
  }

  get usingFakeMic(): boolean {
    return this.fake;
  }

  get ready(): boolean {
    return this.node !== null && this.input !== null;
  }

  /**
   * Ask for the microphone (once) and set up the capture node. Throws a
   * MicError string when the mic is blocked or missing.
   */
  async prepare(beatSeconds: number): Promise<void> {
    if (this.ready) return;
    if (!this.node) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      this.node = new AudioWorkletNode(this.ctx, 'unmix-recorder', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      // The worklet must be pulled by the graph to run; keep it silent.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
    }
    this.input = this.fake ? this.fakeInput(beatSeconds) : await this.micInput();
    this.input.connect(this.node);
  }

  private async micInput(): Promise<AudioNode> {
    if (!navigator.mediaDevices?.getUserMedia) throw 'unavailable' satisfies MicError;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Cancel the app's own playback so the take is mostly you.
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
    } catch (error) {
      const name = (error as DOMException)?.name;
      throw (name === 'NotAllowedError' || name === 'SecurityError'
        ? 'denied'
        : 'unavailable') satisfies MicError;
    }
    const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & {
      latency?: number;
    };
    this.inputLatency = typeof settings?.latency === 'number' ? settings.latency : 0.01;
    return this.ctx.createMediaStreamSource(stream);
  }

  /** Test signal: a short 660 Hz blip on every beat, from AudioContext time 0. */
  private fakeInput(beatSeconds: number): AudioNode {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = 660;
    const gate = this.ctx.createGain();
    gate.gain.value = 0;
    const now = this.ctx.currentTime;
    const firstBeat = Math.ceil(now / beatSeconds) * beatSeconds;
    for (let i = 0; i < 400; i += 1) {
      const t = firstBeat + i * beatSeconds;
      gate.gain.setValueAtTime(0.6, t);
      gate.gain.setValueAtTime(0, t + 0.05);
    }
    osc.connect(gate);
    osc.start();
    this.inputLatency = 0;
    return gate;
  }

  /** Total round-trip delay to compensate, in seconds. */
  get latency(): number {
    if (this.fake) return 0;
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.min(0.5, out + this.inputLatency);
  }

  /**
   * Capture `duration` seconds starting at AudioContext time `start`
   * (shifted later by the measured latency). Resolves with a mono buffer.
   */
  record(start: number, duration: number): Promise<AudioBuffer> {
    const node = this.node;
    if (!node) return Promise.reject(new Error('Recorder not prepared'));
    const rate = this.ctx.sampleRate;
    const from = Math.round((start + this.latency) * rate);
    const length = Math.round(duration * rate);
    const to = from + length;
    const data = new Float32Array(length);

    return new Promise((resolve) => {
      node.port.onmessage = (event: MessageEvent) => {
        const msg = event.data as { frame?: number; data?: Float32Array; done?: boolean };
        if (msg.data && msg.frame !== undefined) {
          const chunkStart = msg.frame;
          const a = Math.max(from, chunkStart);
          const b = Math.min(to, chunkStart + msg.data.length);
          if (b > a) data.set(msg.data.subarray(a - chunkStart, b - chunkStart), a - from);
        }
        if (msg.done) {
          node.port.onmessage = null;
          // Short fades at both ends so the loop never clicks.
          const fade = Math.min(length >> 1, Math.round(rate * 0.005));
          for (let i = 0; i < fade; i += 1) {
            const g = i / fade;
            data[i] *= g;
            data[length - 1 - i] *= g;
          }
          const buffer = this.ctx.createBuffer(1, length, rate);
          buffer.copyToChannel(data, 0);
          resolve(buffer);
        }
      };
      node.port.postMessage({ from, to });
    });
  }
}
