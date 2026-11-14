/**
 * The audio graph. One chain per stem:
 *
 *   AudioBufferSource -> BiquadFilter (low-pass) -> [dry + delay send] -> Gain
 *     -> PannerNode (HRTF) -> master
 *
 * All four sources start at the same AudioContext time and loop the same
 * length, so they stay sample-locked. The engine only reads the mix state;
 * it never writes to it.
 */

import {
  isStemAudible,
  type MixState,
  STEM_IDS,
  type StemId,
} from './mix-state.js';
import type { LoadedTrack } from './tracks.js';

const FILTER_MIN_HZ = 250;
const FILTER_MAX_HZ = 20000;
const SMOOTHING = 0.03; // seconds, for parameter changes without clicks

interface StemChain {
  source: AudioBufferSourceNode | null;
  filter: BiquadFilterNode;
  echoSend: GainNode;
  delay: DelayNode;
  feedback: GainNode;
  gain: GainNode;
  analyser: AnalyserNode;
  panner: PannerNode;
  levelData: Float32Array<ArrayBuffer>;
  level: number;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly chains: Record<StemId, StemChain>;
  private track: LoadedTrack | null = null;
  private playing = false;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.8;
    const compressor = this.ctx.createDynamicsCompressor();
    compressor.threshold.value = -10;
    this.master.connect(compressor).connect(this.ctx.destination);

    const chains = {} as Record<StemId, StemChain>;
    for (const id of STEM_IDS) chains[id] = this.createChain();
    this.chains = chains;
  }

  private createChain(): StemChain {
    const ctx = this.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = FILTER_MAX_HZ;
    filter.Q.value = 0.8;

    const gain = ctx.createGain();
    // Dry path.
    filter.connect(gain);
    // Echo send: filter -> send -> delay (with feedback) -> gain.
    const echoSend = ctx.createGain();
    echoSend.gain.value = 0;
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.375;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    filter.connect(echoSend).connect(delay).connect(gain);
    delay.connect(feedback).connect(delay);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    gain.connect(analyser);

    const panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: 0.35,
      rolloffFactor: 1.2,
      maxDistance: 10,
    });
    gain.connect(panner).connect(this.master);

    return {
      source: null,
      filter,
      echoSend,
      delay,
      feedback,
      gain,
      analyser,
      panner,
      levelData: new Float32Array(analyser.fftSize),
      level: 0,
    };
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get isRunning(): boolean {
    return this.ctx.state === 'running';
  }

  /** Must be called from a user gesture at least once (browser autoplay rule). */
  unlock(): void {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  setTrack(track: LoadedTrack): void {
    this.stop();
    this.track = track;
    // Echo time follows the tempo: a dotted eighth.
    const beat = 60 / (track.info.bpm || 100);
    for (const id of STEM_IDS) {
      this.chains[id].delay.delayTime.value = Math.min(1.9, beat * 0.75);
    }
  }

  /** Start all four stems on the same AudioContext time. */
  play(): void {
    if (!this.track || this.playing) return;
    const startAt = this.ctx.currentTime + 0.1;
    for (const id of STEM_IDS) {
      const chain = this.chains[id];
      const source = this.ctx.createBufferSource();
      source.buffer = this.track.buffers[id];
      source.loop = true;
      source.connect(chain.filter);
      source.start(startAt);
      chain.source = source;
    }
    this.playing = true;
  }

  stop(): void {
    for (const id of STEM_IDS) {
      const chain = this.chains[id];
      if (chain.source) {
        chain.source.stop();
        chain.source.disconnect();
        chain.source = null;
      }
    }
    this.playing = false;
  }

  /** Apply volume, mute/solo, filter, pitch and echo from the mix state. */
  applyMix(state: MixState): void {
    const now = this.ctx.currentTime;
    for (const id of STEM_IDS) {
      const stem = state.stems[id];
      const chain = this.chains[id];
      const target = isStemAudible(state, id) ? stem.volume : 0;
      chain.gain.gain.setTargetAtTime(target, now, SMOOTHING);
      // Exponential map so the ring feels even across the range.
      const hz = FILTER_MIN_HZ * (FILTER_MAX_HZ / FILTER_MIN_HZ) ** stem.filter;
      chain.filter.frequency.setTargetAtTime(hz, now, SMOOTHING);
      chain.echoSend.gain.setTargetAtTime(stem.echo, now, SMOOTHING);
      if (chain.source) {
        const rate = 2 ** (Math.round(stem.pitch) / 12);
        chain.source.playbackRate.setTargetAtTime(rate, now, SMOOTHING);
      }
    }
  }

  /** Move one stem's sound source. Called every frame with the orb's position. */
  setStemPosition(id: StemId, x: number, y: number, z: number): void {
    const p = this.chains[id].panner;
    const now = this.ctx.currentTime;
    p.positionX.setTargetAtTime(x, now, 0.01);
    p.positionY.setTargetAtTime(y, now, 0.01);
    p.positionZ.setTargetAtTime(z, now, 0.01);
  }

  /** Move the listener to the user's head. Forward/up are unit vectors. */
  setListener(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number,
    ux: number, uy: number, uz: number,
  ): void {
    const l = this.ctx.listener;
    const now = this.ctx.currentTime;
    if (l.positionX) {
      l.positionX.setTargetAtTime(px, now, 0.01);
      l.positionY.setTargetAtTime(py, now, 0.01);
      l.positionZ.setTargetAtTime(pz, now, 0.01);
      l.forwardX.setTargetAtTime(fx, now, 0.01);
      l.forwardY.setTargetAtTime(fy, now, 0.01);
      l.forwardZ.setTargetAtTime(fz, now, 0.01);
      l.upX.setTargetAtTime(ux, now, 0.01);
      l.upY.setTargetAtTime(uy, now, 0.01);
      l.upZ.setTargetAtTime(uz, now, 0.01);
    } else {
      // Older browsers without AudioParam listener properties.
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Smoothed 0..1 loudness of a stem, for making the orbs pulse. */
  getLevel(id: StemId): number {
    const chain = this.chains[id];
    if (!this.playing) {
      chain.level *= 0.9;
      return chain.level;
    }
    chain.analyser.getFloatTimeDomainData(chain.levelData);
    let sum = 0;
    const data = chain.levelData;
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    const rms = Math.min(1, Math.sqrt(sum / data.length) * 3);
    chain.level = rms > chain.level ? rms : chain.level * 0.92 + rms * 0.08;
    return chain.level;
  }

  /** A short UI click (not spatial), for grab and press feedback. */
  click(pitch = 1): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400 * pitch, now);
    osc.frequency.exponentialRampToValueAtTime(500 * pitch, now + 0.05);
    env.gain.setValueAtTime(0.18, now);
    env.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
    osc.connect(env).connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }

  /** A soft "whoosh" for the split moment. */
  burst(): void {
    if (this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    const length = Math.round(this.ctx.sampleRate * 0.6);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 2147483648 - 1) * (1 - i / length) ** 2;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.2;
    bp.frequency.setValueAtTime(400, now);
    bp.frequency.exponentialRampToValueAtTime(4000, now + 0.5);
    const env = this.ctx.createGain();
    env.gain.value = 0.35;
    src.connect(bp).connect(env).connect(this.ctx.destination);
    src.start(now);
  }
}
