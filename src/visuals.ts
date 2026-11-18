/**
 * Meshes for the song sphere, stem orbs and poke buttons. Built in code at
 * runtime (they use canvas textures for labels, so they are not manifest
 * assets).
 */

import {
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';
import { STEM_IDS, type StemId } from './mix-state.js';
import { ORB_RADIUS, SPHERE_RADIUS } from './layout.js';

export const STEM_COLORS: Record<StemId, string> = {
  vocals: '#ff5c8a',
  drums: '#ffb020',
  bass: '#3d7bff',
  other: '#2fd27a',
  you: '#a59fb8',
};

export const STEM_LABELS: Record<StemId, string> = {
  vocals: 'VOCALS',
  drums: 'DRUMS',
  bass: 'BASS',
  other: 'OTHER',
  you: 'YOU',
};

export type Ink = 'light' | 'dark';

function labelTexture(
  text: string,
  width = 512,
  height = 128,
  ink: Ink = 'light',
  pill?: string,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  if (pill) {
    // A soft rounded backing so text stays readable over a bright room.
    g.font = `600 ${Math.round(height * 0.46)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const textWidth = Math.min(width, g.measureText(text).width + height * 1.1);
    const x = (width - textWidth) / 2;
    const r = height / 2;
    g.fillStyle = pill;
    g.beginPath();
    g.moveTo(x + r, 0);
    g.lineTo(x + textWidth - r, 0);
    g.arc(x + textWidth - r, r, r, -Math.PI / 2, Math.PI / 2);
    g.lineTo(x + r, height);
    g.arc(x + r, r, r, Math.PI / 2, (3 * Math.PI) / 2);
    g.fill();
  }
  // Shrink long text until it fits the label.
  let size = Math.round(height * 0.46);
  const fontFor = (px: number) => `600 ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.font = fontFor(size);
  while (size > 12 && g.measureText(text).width > width * 0.9) {
    size -= 2;
    g.font = fontFor(size);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (ink === 'dark') {
    g.fillStyle = '#25252a';
  } else {
    // Light text floats over passthrough, so give it a soft shadow.
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = height * 0.08;
    g.fillStyle = '#ffffff';
  }
  g.fillText(text, width / 2, height / 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Dark text on light colors, light text on dark ones. */
function inkFor(color: Color): Ink {
  const l = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b; // linear
  return l > 0.18 ? 'dark' : 'light';
}

/** Parts the system animates for hover, grab, release and audio level. */
export interface GlowParts {
  root: Group;
  core: Mesh<SphereGeometry, MeshStandardMaterial>;
  glow: Mesh<SphereGeometry, MeshBasicMaterial>;
  baseColor: Color;
}

export function makeOrb(stem: StemId): GlowParts {
  const color = new Color(STEM_COLORS[stem]);
  const root = new Group();
  root.name = `orb-${stem}`;

  const core = new Mesh(
    new SphereGeometry(ORB_RADIUS, 32, 24),
    new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.6,
      roughness: 0.35,
      metalness: 0.1,
    }),
  );
  core.name = `orb-${stem}-core`;
  root.add(core);

  const glow = new Mesh(
    new SphereGeometry(ORB_RADIUS * 1.45, 24, 16),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.18,
      blending: AdditiveBlending,
      depthWrite: false,
      side: BackSide,
    }),
  );
  glow.raycast = () => {}; // visual only
  root.add(glow);

  // The stem name lives on the orb's tab (a poke button), not on the orb.
  return { root, core, glow, baseColor: color };
}

export function makeSongSphere(): GlowParts & { satellites: Mesh[] } {
  const root = new Group();
  root.name = 'song-sphere';
  const baseColor = new Color('#c9b6ff');

  const core = new Mesh(
    new SphereGeometry(SPHERE_RADIUS, 48, 32),
    new MeshStandardMaterial({
      color: '#ffffff',
      emissive: baseColor,
      emissiveIntensity: 0.5,
      roughness: 0.2,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    }),
  );
  core.name = 'song-sphere-core';
  root.add(core);

  const glow = new Mesh(
    new SphereGeometry(SPHERE_RADIUS * 1.35, 32, 20),
    new MeshBasicMaterial({
      color: baseColor,
      transparent: true,
      opacity: 0.15,
      blending: AdditiveBlending,
      depthWrite: false,
      side: BackSide,
    }),
  );
  glow.raycast = () => {};
  root.add(glow);

  // Four small stem-colored lights swirl inside: a hint of what is in there.
  const satellites: Mesh[] = [];
  for (const stem of STEM_IDS) {
    const m = new Mesh(
      new SphereGeometry(SPHERE_RADIUS * 0.22, 16, 12),
      new MeshBasicMaterial({ color: STEM_COLORS[stem] }),
    );
    m.raycast = () => {};
    satellites.push(m);
    root.add(m);
  }

  return { root, core, glow, baseColor, satellites };
}

export interface ButtonParts {
  root: Group;
  body: Mesh<ExtrudeGeometry, MeshStandardMaterial>;
  face: Mesh<PlaneGeometry, MeshBasicMaterial>;
  setLabel: (text: string) => void;
  /** "On" look for toggles (mute, solo, echo): sits pressed in, in color. */
  setActive: (active: boolean) => void;
  /** Accent color: the body for accent buttons, the "on" color for neutral ones. */
  setColor: (color: string) => void;
  /** Push the key in by `depth` meters (press travel). */
  setTravel: (depth: number) => void;
  active: boolean;
}

/**
 * neutral: warm light gray key, dark text (most controls)
 * accent:  colored key (stem tabs, track tiles, Mix down)
 * record:  red key, light text
 * glass:   frosted translucent key (producer ideas)
 */
export type ButtonStyle = 'neutral' | 'accent' | 'record' | 'glass';

export interface ButtonOptions {
  width?: number;
  height?: number;
  color?: string;
  style?: ButtonStyle;
  /** Record-style song tile: a colored disc, the title, and the artist under it. */
  track?: { artist: string; disc: string };
}

/** Face for a song tile: disc on the left, title over artist on the right. */
function trackTexture(
  title: string,
  artist: string,
  disc: string,
  width: number,
  height: number,
  ink: Ink,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const r = height * 0.36;
  const cx = height * 0.5;
  const cy = height / 2;
  // A little record: colored label, darker grooves, spindle hole.
  g.fillStyle = '#1d1c22';
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.12)';
  g.lineWidth = Math.max(1, height * 0.012);
  for (const k of [0.82, 0.68]) {
    g.beginPath();
    g.arc(cx, cy, r * k, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = disc;
  g.beginPath();
  g.arc(cx, cy, r * 0.46, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1d1c22';
  g.beginPath();
  g.arc(cx, cy, r * 0.08, 0, Math.PI * 2);
  g.fill();

  const x = height * 1.0;
  const maxW = width - x - height * 0.12;
  const fit = (text: string, px: number, weight: number) => {
    let size = px;
    g.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    while (size > 12 && g.measureText(text).width > maxW) {
      size -= 2;
      g.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    }
  };
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  g.fillStyle = ink === 'dark' ? '#25252a' : '#ffffff';
  fit(title, Math.round(height * 0.27), 650);
  g.fillText(title, x, height * 0.5);
  g.fillStyle = ink === 'dark' ? '#5f5b68' : 'rgba(255,255,255,0.75)';
  fit(artist, Math.round(height * 0.19), 500);
  g.fillText(artist, x, height * 0.76);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const NEUTRAL = new Color('#ebe7df');
const GLASS = new Color('#f4f2ee');
const RECORD = new Color('#d6453d');
const KEY_DEPTH = 0.012;
const BEVEL = 0.003;

/** A rounded key: front face at z = 0, extruded backwards. */
function keyGeometry(width: number, height: number): ExtrudeGeometry {
  const r = Math.min(width, height) * 0.22;
  const w = width / 2 - BEVEL;
  const h = height / 2 - BEVEL;
  const shape = new Shape();
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const geometry = new ExtrudeGeometry(shape, {
    depth: KEY_DEPTH,
    bevelEnabled: true,
    bevelThickness: BEVEL,
    bevelSize: BEVEL,
    bevelSegments: 2,
    curveSegments: 5,
  });
  geometry.translate(0, 0, -KEY_DEPTH);
  return geometry;
}

/** A poke button with a text label. Default 12 x 8 cm. */
export function makeButton(text: string, options: ButtonOptions = {}): ButtonParts {
  const width = options.width ?? 0.12;
  const height = options.height ?? 0.08;
  const style = options.style ?? 'neutral';
  const accent = new Color(options.color ?? '#7c5cff');
  const base =
    style === 'neutral' ? NEUTRAL.clone()
    : style === 'glass' ? GLASS.clone()
    : style === 'record' ? RECORD.clone()
    : accent.clone();

  const root = new Group();
  root.name = 'button';
  const body = new Mesh(
    keyGeometry(width, height),
    new MeshStandardMaterial({
      color: base.clone(),
      emissive: base.clone(),
      emissiveIntensity: 0.05,
      roughness: style === 'glass' ? 0.15 : 0.6,
      metalness: 0,
      transparent: style === 'glass',
      opacity: style === 'glass' ? 0.72 : 1,
    }),
  );
  root.add(body);

  const track = options.track;
  const texHeight = track ? 256 : 128;
  const texWidth = Math.round(Math.min(1024, texHeight * (width / height) * (track ? 1.6 : 2.2)));
  const paint = (t: string, k: Ink) =>
    track
      ? trackTexture(t, track.artist, track.disc, texWidth, texHeight, k)
      : labelTexture(t, texWidth, texHeight, k);
  let ink: Ink = inkFor(body.material.color);
  let currentText = text;
  const face = new Mesh(
    new PlaneGeometry(width * 0.92, (width * 0.92 * texHeight) / texWidth),
    new MeshBasicMaterial({
      map: paint(text, ink),
      transparent: true,
      depthWrite: false,
    }),
  );
  const faceZ = BEVEL + 0.0008;
  face.position.z = faceZ;
  face.raycast = () => {};
  root.add(face);

  const redraw = () => {
    face.material.map?.dispose();
    face.material.map = paint(currentText, ink);
    face.material.needsUpdate = true;
  };
  const restyle = () => {
    const c = body.material.color;
    c.copy(base);
    if (parts.active) {
      if (style === 'neutral' || style === 'glass') c.lerp(accent, 0.8);
      else c.lerp(WHITE, 0.35);
    }
    body.material.emissive.copy(c);
    const next = inkFor(c);
    if (next !== ink) {
      ink = next;
      redraw();
    }
  };

  const parts: ButtonParts = {
    root,
    body,
    face,
    active: false,
    setLabel: (next: string) => {
      if (next === currentText) return;
      currentText = next;
      redraw();
    },
    setActive: (active: boolean) => {
      if (active === parts.active) return;
      parts.active = active;
      restyle();
    },
    setColor: (color: string) => {
      accent.set(color);
      if (style === 'accent') base.copy(accent);
      restyle();
    },
    setTravel: (depth: number) => {
      body.position.z = -depth;
      face.position.z = faceZ - depth;
    },
  };
  return parts;
}

const WHITE = new Color('#ffffff');

export interface TextPlane {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  setText: (text: string) => void;
}

/** A flat, non-interactive line of text, optionally on a dark pill. */
export function makeTextPlane(
  text: string,
  width: number,
  height: number,
  pill?: string,
): TextPlane {
  const texHeight = 96;
  const texWidth = Math.round(Math.min(2048, (texHeight * width) / height));
  const mesh = new Mesh(
    new PlaneGeometry(width, height),
    new MeshBasicMaterial({
      map: labelTexture(text, texWidth, texHeight, 'light', pill),
      transparent: true,
      depthWrite: false,
    }),
  );
  mesh.raycast = () => {};
  let current = text;
  return {
    mesh,
    setText: (next: string) => {
      if (next === current) return;
      current = next;
      mesh.material.map?.dispose();
      mesh.material.map = labelTexture(next, texWidth, texHeight, 'light', pill);
      mesh.material.needsUpdate = true;
    },
  };
}
