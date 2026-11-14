/**
 * Placeholder stems: a 4-bar loop (Am - F - C - G) synthesized into
 * AudioBuffers, so the app plays before real Demucs stems are added. Every
 * stem is the same length, so they stay sample-locked when looped.
 */

import type { StemId } from './mix-state.js';

const BARS = 4;
const BEATS_PER_BAR = 4;

/** MIDI note numbers of the chord roots and triads, one chord per bar. */
const CHORDS = [
  { root: 45, triad: [57, 60, 64] }, // A minor
  { root: 41, triad: [53, 57, 60] }, // F major
  { root: 48, triad: [55, 60, 64] }, // C major
  { root: 43, triad: [55, 59, 62] }, // G major
];

/** Lead line: [beat offset from loop start, MIDI note, length in beats]. */
const MELODY: [number, number, number][] = [
  [0, 69, 1.5], [1.5, 72, 0.5], [2, 71, 1], [3, 69, 1],
  [4, 65, 1.5], [5.5, 67, 0.5], [6, 69, 2],
  [8, 67, 1], [9, 64, 1], [10, 67, 1], [11, 72, 1],
  [12, 71, 1.5], [13.5, 69, 0.5], [14, 67, 2],
];

const midiToHz = (note: number): number => 440 * 2 ** ((note - 69) / 12);

/** Small seeded noise source so the drums sound the same every load. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2147483648 - 1;
  };
}

function render(
  ctx: BaseAudioContext,
  bpm: number,
  fill: (data: Float32Array, sampleRate: number, beatSeconds: number) => void,
): AudioBuffer {
  const beatSeconds = 60 / bpm;
  const length = Math.round(BARS * BEATS_PER_BAR * beatSeconds * ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  fill(data, ctx.sampleRate, beatSeconds);
  return buffer;
}

function drums(data: Float32Array, sr: number, beat: number): void {
  const rand = noise(7);
  const totalBeats = BARS * BEATS_PER_BAR;
  for (let b = 0; b < totalBeats * 2; b += 1) {
    const start = Math.round((b * beat * sr) / 2);
    const onBeat = b % 2 === 0;
    const beatInBar = (b / 2) % BEATS_PER_BAR;
    // Kick on beats 1 and 3: a falling sine.
    if (onBeat && (beatInBar === 0 || beatInBar === 2)) {
      let phase = 0;
      for (let i = 0; i < sr * 0.35 && start + i < data.length; i += 1) {
        const t = i / sr;
        phase += (2 * Math.PI * (45 + 90 * Math.exp(-t * 30))) / sr;
        data[start + i] += Math.sin(phase) * Math.exp(-t * 9) * 0.9;
      }
    }
    // Snare on beats 2 and 4: a short burst of noise with a body tone.
    if (onBeat && (beatInBar === 1 || beatInBar === 3)) {
      for (let i = 0; i < sr * 0.2 && start + i < data.length; i += 1) {
        const t = i / sr;
        const body = Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t * 25);
        data[start + i] += (rand() * 0.5 + body * 0.4) * Math.exp(-t * 18);
      }
    }
    // Closed hi-hat on every eighth: very short, bright noise.
    let previous = 0;
    for (let i = 0; i < sr * 0.04 && start + i < data.length; i += 1) {
      const n = rand();
      const highPassed = n - previous; // crude high-pass
      previous = n;
      data[start + i] += highPassed * 0.12 * Math.exp((-i / sr) * 90);
    }
  }
}

function bass(data: Float32Array, sr: number, beat: number): void {
  for (let bar = 0; bar < BARS; bar += 1) {
    const freq = midiToHz(CHORDS[bar].root);
    for (let eighth = 0; eighth < BEATS_PER_BAR * 2; eighth += 1) {
      const start = Math.round(((bar * BEATS_PER_BAR + eighth / 2) * beat) * sr);
      const len = Math.round((beat / 2) * sr * 0.9);
      for (let i = 0; i < len && start + i < data.length; i += 1) {
        const t = i / sr;
        const env = Math.min(1, t * 200) * Math.exp(-t * 4);
        const tone =
          Math.sin(2 * Math.PI * freq * t) +
          0.3 * Math.sin(2 * Math.PI * freq * 2 * t);
        data[start + i] += tone * env * 0.55;
      }
    }
  }
}

function pads(data: Float32Array, sr: number, beat: number): void {
  const barLen = Math.round(BEATS_PER_BAR * beat * sr);
  for (let bar = 0; bar < BARS; bar += 1) {
    const start = bar * barLen;
    for (const note of CHORDS[bar].triad) {
      const freq = midiToHz(note);
      for (let i = 0; i < barLen && start + i < data.length; i += 1) {
        const t = i / sr;
        const env = Math.min(1, t * 3) * Math.min(1, (barLen - i) / (sr * 0.15));
        // Two slightly detuned triangles for a soft chorus.
        const tri = (f: number) => (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * f * t));
        data[start + i] += (tri(freq) + tri(freq * 1.004)) * env * 0.08;
      }
    }
  }
}

function lead(data: Float32Array, sr: number, beat: number): void {
  for (const [at, note, lengthBeats] of MELODY) {
    const start = Math.round(at * beat * sr);
    const len = Math.round(lengthBeats * beat * sr);
    const freq = midiToHz(note);
    let phase = 0;
    for (let i = 0; i < len && start + i < data.length; i += 1) {
      const t = i / sr;
      const vibrato = 1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 2);
      phase += (2 * Math.PI * freq * vibrato) / sr;
      const env = Math.min(1, t * 25) * Math.min(1, (len - i) / (sr * 0.06));
      // A few odd and even harmonics give a vowel-like tone.
      const tone =
        Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) +
        0.12 * Math.sin(5 * phase);
      data[start + i] += tone * env * 0.22;
    }
  }
}

const RENDERERS: Record<
  StemId,
  (data: Float32Array, sr: number, beat: number) => void
> = { drums, bass, other: pads, vocals: lead };

export function synthesizePlaceholderStem(
  ctx: BaseAudioContext,
  id: StemId,
  bpm: number,
): AudioBuffer {
  return render(ctx, bpm, RENDERERS[id]);
}
