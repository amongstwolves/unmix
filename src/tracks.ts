/**
 * Track loading. A track lives in public/tracks/<track-id>/ with a track.json
 * and one audio file per stem. A track marked "placeholder" (or any stem file
 * that fails to load) is synthesized in the browser so the app always plays.
 */

import { STEM_IDS, type StemId } from './mix-state.js';
import { synthesizePlaceholderStem } from './placeholder-stems.js';

export interface TrackSection {
  id: string;
  label: string;
  /** Seconds from the start of the stems. */
  start: number;
  end: number;
}

export interface TrackInfo {
  id: string;
  title: string;
  artist: string;
  license: string;
  licenseUrl: string;
  bpm: number;
  key: string;
  sections: TrackSection[];
  /** Stem file names relative to the track folder. */
  stems?: Partial<Record<StemId, string>>;
  /** When true, all stems are generated tones instead of files. */
  placeholder?: boolean;
}

export interface LoadedTrack {
  info: TrackInfo;
  buffers: Record<StemId, AudioBuffer>;
}

const trackUrl = (trackId: string, file: string): string =>
  `${import.meta.env.BASE_URL}tracks/${trackId}/${file}`;

async function loadStemFile(
  ctx: BaseAudioContext,
  url: string,
): Promise<AudioBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return ctx.decodeAudioData(await response.arrayBuffer());
}

/**
 * Stems from Demucs should already be the same length, but trim or pad to the
 * longest one anyway so the four loops can never drift apart.
 */
function equalizeLengths(
  ctx: BaseAudioContext,
  buffers: Record<StemId, AudioBuffer>,
): Record<StemId, AudioBuffer> {
  const length = Math.max(...STEM_IDS.map((id) => buffers[id].length));
  const out = {} as Record<StemId, AudioBuffer>;
  for (const id of STEM_IDS) {
    const src = buffers[id];
    if (src.length === length && src.sampleRate === ctx.sampleRate) {
      out[id] = src;
      continue;
    }
    const copy = ctx.createBuffer(src.numberOfChannels, length, src.sampleRate);
    for (let ch = 0; ch < src.numberOfChannels; ch += 1) {
      copy.copyToChannel(src.getChannelData(ch).subarray(0, length), ch);
    }
    out[id] = copy;
  }
  return out;
}

export async function loadTrack(
  ctx: BaseAudioContext,
  trackId: string,
): Promise<LoadedTrack> {
  const response = await fetch(trackUrl(trackId, 'track.json'));
  if (!response.ok) {
    throw new Error(`Could not load track.json for "${trackId}"`);
  }
  const info = (await response.json()) as TrackInfo;

  const entries = await Promise.all(
    STEM_IDS.map(async (id): Promise<[StemId, AudioBuffer]> => {
      const file = info.stems?.[id];
      if (!info.placeholder && file) {
        try {
          return [id, await loadStemFile(ctx, trackUrl(trackId, file))];
        } catch (error) {
          console.warn(
            `[unmix] stem "${id}" of "${trackId}" failed to load; using a placeholder tone`,
            error,
          );
        }
      }
      return [id, synthesizePlaceholderStem(ctx, id, info.bpm || 100)];
    }),
  );

  const buffers = Object.fromEntries(entries) as Record<StemId, AudioBuffer>;
  return { info, buffers: equalizeLengths(ctx, buffers) };
}
