/**
 * Waveform views (display only, nothing here is interactive):
 *  - a full-track strip floating in front of the user: one lane per stem in
 *    its color, section labels, a loop highlight, and a playhead per lane
 *    (a pitched stem plays faster or slower, so its playhead does too);
 *  - a mini waveform over each orb with its own playhead.
 * Muted (or not soloed) stems dim, so the views always match the mix state.
 *
 * Waveform shapes are drawn once per track into canvas textures; each frame
 * only moves playheads and changes opacity.
 */

import {
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';
import { isStemAudible, type MixState, STEM_IDS, type StemId, type TrackStemId } from './mix-state.js';
import type { LoadedTrack } from './tracks.js';
import { STEM_COLORS, STEM_LABELS } from './visuals.js';

const STRIP_WIDTH = 0.9;
const LANE_HEIGHT = 0.045;
const LANE_GAP = 0.006;
const HEADER_HEIGHT = 0.034;
const ORB_WAVE_WIDTH = 0.12;
const ORB_WAVE_HEIGHT = 0.03;
/** Mini waveform sits this far above its orb's center. */
export const ORB_WAVE_RISE = 0.085;

interface Lane {
  plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  playhead: Mesh<PlaneGeometry, MeshBasicMaterial>;
}

export interface OrbWave {
  root: Group;
  plane: Mesh<PlaneGeometry, MeshBasicMaterial>;
  playhead: Mesh<PlaneGeometry, MeshBasicMaterial>;
}

function noRaycast<T extends Mesh>(mesh: T): T {
  mesh.raycast = () => {};
  return mesh;
}

function canvasTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Peak amplitude per column (0..1), normalized to the loudest stem later. */
function peaks(buffer: AudioBuffer, columns: number): Float32Array {
  const out = new Float32Array(columns);
  const channels = buffer.numberOfChannels;
  const perColumn = buffer.length / columns;
  // Sample at most ~200 points per column; plenty for a picture.
  const stride = Math.max(1, Math.floor(perColumn / 200));
  for (let ch = 0; ch < channels; ch += 1) {
    const data = buffer.getChannelData(ch);
    for (let col = 0; col < columns; col += 1) {
      const start = Math.floor(col * perColumn);
      const end = Math.min(data.length, Math.floor((col + 1) * perColumn));
      let peak = out[col];
      for (let i = start; i < end; i += stride) {
        const v = Math.abs(data[i]);
        if (v > peak) peak = v;
      }
      out[col] = peak;
    }
  }
  return out;
}

function drawWave(
  values: Float32Array,
  scale: number,
  width: number,
  height: number,
  color: string,
  label: string | null,
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(12, 12, 22, 0.6)';
  g.fillRect(0, 0, width, height);
  g.fillStyle = color;
  const mid = height / 2;
  const colWidth = width / values.length;
  for (let i = 0; i < values.length; i += 1) {
    const h = Math.max(1, values[i] * scale * (height * 0.46));
    g.fillRect(i * colWidth, mid - h, Math.max(1, colWidth - 0.5), h * 2);
  }
  if (label) {
    g.font = `700 ${Math.round(height * 0.32)}px system-ui, -apple-system, sans-serif`;
    g.textBaseline = 'top';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    g.strokeText(label, 8, 6);
    g.fillStyle = '#ffffff';
    g.fillText(label, 8, 6);
  }
  return canvas;
}

export class WaveformViews {
  /** Full-track strip; position and face it toward the user from outside. */
  readonly strip = new Group();
  private lanes = new Map<TrackStemId, Lane>();
  private header: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private loopBox: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private orbWaveTextures = new Map<StemId, CanvasTexture>();
  private duration = 1;
  private sections: { id: string; start: number; end: number }[] = [];

  constructor() {
    this.strip.name = 'waveform-strip';
    const total = STEM_IDS.length * (LANE_HEIGHT + LANE_GAP);
    STEM_IDS.forEach((id, i) => {
      const plane = noRaycast(
        new Mesh(
          new PlaneGeometry(STRIP_WIDTH, LANE_HEIGHT),
          new MeshBasicMaterial({ transparent: true, depthWrite: false }),
        ),
      );
      plane.position.y = total / 2 - (i + 0.5) * (LANE_HEIGHT + LANE_GAP);
      const playhead = noRaycast(
        new Mesh(
          new PlaneGeometry(0.003, LANE_HEIGHT * 1.15),
          new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false }),
        ),
      );
      playhead.position.set(-STRIP_WIDTH / 2, plane.position.y, 0.001);
      this.strip.add(plane, playhead);
      this.lanes.set(id, { plane, playhead });
    });
    this.header = noRaycast(
      new Mesh(
        new PlaneGeometry(STRIP_WIDTH, HEADER_HEIGHT),
        new MeshBasicMaterial({ transparent: true, depthWrite: false }),
      ),
    );
    this.header.position.y = total / 2 + HEADER_HEIGHT / 2 + 0.004;
    this.strip.add(this.header);
    this.loopBox = noRaycast(
      new Mesh(
        new PlaneGeometry(1, total),
        new MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.25, depthWrite: false }),
      ),
    );
    this.loopBox.position.z = 0.0005;
    this.loopBox.visible = false;
    this.strip.add(this.loopBox);
    this.strip.visible = false;
  }

  /** Draw the waveforms for a newly loaded track. */
  setTrack(track: LoadedTrack): void {
    this.duration = track.buffers.vocals.duration || 1;
    this.sections = track.info.sections;
    const lanePeaks = new Map<StemId, Float32Array>();
    const orbPeaks = new Map<StemId, Float32Array>();
    let loudest = 0.0001;
    for (const id of STEM_IDS) {
      const p = peaks(track.buffers[id], 512);
      lanePeaks.set(id, p);
      orbPeaks.set(id, peaks(track.buffers[id], 96));
      for (const v of p) if (v > loudest) loudest = v;
    }
    // One shared scale so quiet stems look quiet next to loud ones.
    const scale = 1 / loudest;
    for (const id of STEM_IDS) {
      const lane = this.lanes.get(id)!;
      lane.plane.material.map?.dispose();
      lane.plane.material.map = canvasTexture(
        drawWave(lanePeaks.get(id)!, scale, 1024, 64, STEM_COLORS[id], STEM_LABELS[id]),
      );
      lane.plane.material.needsUpdate = true;

      this.orbWaveTextures.get(id)?.dispose();
      this.orbWaveTextures.set(
        id,
        canvasTexture(drawWave(orbPeaks.get(id)!, scale, 256, 64, STEM_COLORS[id], null)),
      );
    }
    this.drawHeader(track.info.title);
  }

  private drawHeader(title: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 42;
    const g = canvas.getContext('2d')!;
    g.font = '700 26px system-ui, -apple-system, sans-serif';
    g.textBaseline = 'middle';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(0,0,0,0.7)';
    const text = (s: string, x: number) => {
      g.strokeText(s, x, 21);
      g.fillStyle = '#ffffff';
      g.fillText(s, x, 21);
    };
    if (this.sections.length > 1) {
      for (const section of this.sections) {
        const x = (section.start / this.duration) * canvas.width;
        g.fillStyle = 'rgba(255,255,255,0.6)';
        g.fillRect(x, 0, 2, canvas.height);
        text((section as { label?: string }).label ?? section.id, x + 6);
      }
    } else {
      text(title, 6);
    }
    this.header.material.map?.dispose();
    this.header.material.map = canvasTexture(canvas);
    this.header.material.needsUpdate = true;
  }

  /** Draw the mini waveform for the user's recorded loop. */
  setRecordingWave(buffer: AudioBuffer): void {
    const p = peaks(buffer, 96);
    let loudest = 0.0001;
    for (const v of p) if (v > loudest) loudest = v;
    this.orbWaveTextures.get('you')?.dispose();
    const texture = canvasTexture(drawWave(p, 1 / loudest, 256, 64, STEM_COLORS.you, null));
    this.orbWaveTextures.set('you', texture);
  }

  /** A mini waveform to put over an orb. */
  makeOrbWave(stem: StemId): OrbWave {
    const root = new Group();
    root.name = `wave-${stem}`;
    const plane = noRaycast(
      new Mesh(
        new PlaneGeometry(ORB_WAVE_WIDTH, ORB_WAVE_HEIGHT),
        new MeshBasicMaterial({
          map: this.orbWaveTextures.get(stem) ?? null,
          transparent: true,
          depthWrite: false,
        }),
      ),
    );
    const playhead = noRaycast(
      new Mesh(
        new PlaneGeometry(0.002, ORB_WAVE_HEIGHT * 1.2),
        new MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false }),
      ),
    );
    playhead.position.z = 0.001;
    root.add(plane, playhead);
    return { root, plane, playhead };
  }

  /** Move playheads and dim muted stems. Call every frame. */
  update(
    state: MixState,
    /** 0..1 position of each stem within its own length. */
    fraction: (id: StemId) => number,
    orbWaves: Iterable<[StemId, OrbWave]>,
  ): void {
    const d = this.duration;
    for (const id of STEM_IDS) {
      const lane = this.lanes.get(id)!;
      const t = fraction(id);
      lane.playhead.position.x = -STRIP_WIDTH / 2 + t * STRIP_WIDTH;
      const opacity = isStemAudible(state, id) ? 1 : 0.25;
      lane.plane.material.opacity = opacity;
      lane.playhead.material.opacity = opacity;
    }
    for (const [id, wave] of orbWaves) {
      const t = fraction(id);
      wave.playhead.position.x = -ORB_WAVE_WIDTH / 2 + t * ORB_WAVE_WIDTH;
      const opacity = isStemAudible(state, id) ? 1 : 0.25;
      wave.plane.material.opacity = opacity;
      wave.playhead.material.opacity = opacity;
    }
    const loop = this.sections.find((s) => s.id === state.loopSectionId);
    this.loopBox.visible = !!loop;
    if (loop) {
      const a = loop.start / d;
      const b = Math.min(1, loop.end / d);
      this.loopBox.scale.x = Math.max(0.001, (b - a) * STRIP_WIDTH);
      this.loopBox.position.x = -STRIP_WIDTH / 2 + ((a + b) / 2) * STRIP_WIDTH;
    }
  }
}
