/**
 * Mix actions: the only ways the mix state changes besides moving orbs by
 * hand. Poke buttons and the AI producer both go through these, so the
 * producer can never do anything a person could not.
 *
 * Also validates producer suggestions against the contract in CLAUDE.md.
 */

import { ALL_STEMS, type MixState, STEM_IDS, type StemId } from './mix-state.js';
import { SLOT_COUNT } from './layout.js';

export type MixAction =
  | { type: 'move'; stem: StemId; slot: number }
  | { type: 'setVolume'; stem: StemId; value: number }
  | { type: 'mute'; stem: StemId }
  | { type: 'solo'; stem: StemId }
  | { type: 'setFilter'; stem: StemId; value: number }
  | { type: 'setPitch'; stem: StemId; value: number }
  | { type: 'setEcho'; stem: StemId; value: number }
  | { type: 'halfTime'; stem: StemId }
  | { type: 'loopSection'; sectionId: string };

export interface Suggestion {
  label: string;
  why: string;
  actions: MixAction[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Only one stem may be pitched at a time (pitch also changes its speed). */
export function setPitch(state: MixState, stem: StemId, semitones: number): void {
  const value = Math.round(clamp(semitones, -12, 12));
  for (const id of ALL_STEMS) if (id !== stem) state.stems[id].pitch = 0;
  state.stems[stem].pitch = value;
}

export function toggleMute(state: MixState, stem: StemId): void {
  state.stems[stem].muted = !state.stems[stem].muted;
}

/** Solo is exclusive: soloing one stem un-solos the others. */
export function toggleSolo(state: MixState, stem: StemId): void {
  const next = !state.stems[stem].soloed;
  for (const id of ALL_STEMS) state.stems[id].soloed = false;
  state.stems[stem].soloed = next;
}

/**
 * Apply one action. `slotPosition` turns a slot index into a world position.
 * Returns a section id when the action asks to loop a section (the caller
 * owns playback), otherwise null.
 */
export function applyAction(
  state: MixState,
  action: MixAction,
  slotPosition: (slot: number) => [number, number, number],
): string | null {
  switch (action.type) {
    case 'move': {
      const s = state.stems[action.stem];
      s.slot = action.slot;
      s.position = slotPosition(action.slot);
      return null;
    }
    case 'setVolume':
      state.stems[action.stem].volume = clamp(action.value, 0, 1);
      return null;
    case 'mute':
      state.stems[action.stem].muted = true;
      return null;
    case 'solo':
      for (const id of ALL_STEMS) state.stems[id].soloed = id === action.stem;
      return null;
    case 'setFilter':
      state.stems[action.stem].filter = clamp(action.value, 0, 1);
      return null;
    case 'setPitch':
      setPitch(state, action.stem, action.value);
      return null;
    case 'setEcho':
      state.stems[action.stem].echo = clamp(action.value, 0, 1);
      return null;
    case 'halfTime':
      // Half speed is one octave down with playbackRate.
      setPitch(state, action.stem, -12);
      return null;
    case 'loopSection':
      return action.sectionId;
  }
}

// ------------------------------------------------------------- validation

// Precomputed suggestions only know the four track stems.
const isStem = (v: unknown): v is StemId =>
  typeof v === 'string' && (STEM_IDS as readonly string[]).includes(v);
const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function validateAction(raw: unknown, sectionIds: string[]): MixAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.type) {
    case 'move':
      return isStem(a.stem) && Number.isInteger(a.slot) && isNum(a.slot, 0, SLOT_COUNT - 1)
        ? { type: 'move', stem: a.stem, slot: a.slot } : null;
    case 'setVolume':
    case 'setFilter':
    case 'setEcho':
      return isStem(a.stem) && isNum(a.value, 0, 1)
        ? { type: a.type, stem: a.stem, value: a.value } : null;
    case 'setPitch':
      return isStem(a.stem) && isNum(a.value, -12, 12)
        ? { type: 'setPitch', stem: a.stem, value: a.value } : null;
    case 'mute':
    case 'solo':
    case 'halfTime':
      return isStem(a.stem) ? { type: a.type, stem: a.stem } : null;
    case 'loopSection':
      return typeof a.sectionId === 'string' && sectionIds.includes(a.sectionId)
        ? { type: 'loopSection', sectionId: a.sectionId } : null;
    default:
      return null;
  }
}

/** Returns the suggestion if it fully matches the contract, else null. */
export function validateSuggestion(raw: unknown, sectionIds: string[]): Suggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.label !== 'string' || !s.label.trim()) return null;
  if (s.label.trim().split(/\s+/).length > 6) return null;
  if (typeof s.why !== 'string' || !s.why.trim()) return null;
  if (!Array.isArray(s.actions) || s.actions.length === 0) return null;
  const actions: MixAction[] = [];
  for (const rawAction of s.actions) {
    const action = validateAction(rawAction, sectionIds);
    if (!action) return null;
    actions.push(action);
  }
  return { label: s.label.trim(), why: s.why.trim(), actions };
}
