/**
 * The mix state: the single source of truth for Unmix.
 *
 * Hands and (later) the AI producer write to it. The audio graph and the
 * visuals read from it. It must stay plain, serializable JSON so a saved mix
 * is just a snapshot of this object.
 */

/** The four stems every track has (from Demucs). */
export const STEM_IDS = ['vocals', 'drums', 'bass', 'other'] as const;
export type TrackStemId = (typeof STEM_IDS)[number];
/** Track stems plus the user's own recorded layer. */
export const ALL_STEMS = [...STEM_IDS, 'you'] as const;
export type StemId = (typeof ALL_STEMS)[number];

export type Vec3Tuple = [number, number, number];

export interface StemState {
  id: StemId;
  /** World-space position of the orb (where you hear the stem). */
  position: Vec3Tuple;
  /** Arc slot the orb sits in, or null when placed freely. */
  slot: number | null;
  /** 0..1 user volume on top of distance attenuation. */
  volume: number;
  muted: boolean;
  soloed: boolean;
  /** 0..1, 1 = fully open low-pass (bright), 0 = dark. */
  filter: number;
  /** Semitones, -12..12. Changes speed too ("pitch + speed"). */
  pitch: number;
  /** 0..1 echo (delay) wet amount. */
  echo: number;
}

export type MixPhase = 'idle' | 'whole' | 'split';

export interface MixState {
  version: 1;
  trackId: string | null;
  /** idle = nothing playing, whole = one sphere, split = four orbs. */
  phase: MixPhase;
  /** Where the song sphere sits (world space). */
  spherePosition: Vec3Tuple;
  stems: Record<StemId, StemState>;
  /** Section being looped (from track.json), or null for the whole track. */
  loopSectionId: string | null;
  /** True once the user has recorded their own layer (the "you" stem). */
  hasRecording: boolean;
}

/** Default arc slot per stem, left to right as the user sees them. */
export const DEFAULT_SLOTS: Record<StemId, number> = {
  bass: 1,
  drums: 3,
  vocals: 4,
  other: 6,
  you: 5,
};

export function createMixState(): MixState {
  const stems = {} as Record<StemId, StemState>;
  for (const id of ALL_STEMS) {
    stems[id] = {
      id,
      position: [0, 1.2, -0.45],
      slot: DEFAULT_SLOTS[id],
      volume: 1,
      muted: false,
      soloed: false,
      filter: 1,
      pitch: 0,
      echo: 0,
    };
  }
  return {
    version: 1,
    trackId: null,
    phase: 'idle',
    spherePosition: [0, 1.2, -0.45],
    stems,
    loopSectionId: null,
    hasRecording: false,
  };
}

/** Deep copy, for saved mixes and undo. */
export function snapshotMix(state: MixState): MixState {
  return JSON.parse(JSON.stringify(state)) as MixState;
}

/** True when the stem should be heard, taking mute and solo into account. */
export function isStemAudible(state: MixState, id: StemId): boolean {
  const stem = state.stems[id];
  if (stem.muted) return false;
  if (id === 'you' && !state.hasRecording) return false;
  const anySolo = ALL_STEMS.some((s) => state.stems[s]?.soloed);
  return anySolo ? stem.soloed : true;
}
