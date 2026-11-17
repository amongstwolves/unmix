/**
 * Meshes for the song sphere, stem orbs and poke buttons. Built in code at
 * runtime (they use canvas textures for labels, so they are not manifest
 * assets).
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
} from '@iwsdk/core';
import type { StemId } from './mix-state.js';
import { ORB_RADIUS, SPHERE_RADIUS } from './layout.js';

export const STEM_COLORS: Record<StemId, string> = {
  vocals: '#ff5c8a',
  drums: '#ffb020',
  bass: '#3d7bff',
  other: '#2fd27a',
};

export const STEM_LABELS: Record<StemId, string> = {
  vocals: 'VOCALS',
  drums: 'DRUMS',
  bass: 'BASS',
  other: 'OTHER',
};

function labelTexture(text: string, width = 512, height = 128, bg?: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  if (bg) {
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
  }
  // Shrink long text until it fits the label.
  let size = Math.round(height * 0.5);
  const fontFor = (px: number) => `700 ${px}px system-ui, -apple-system, sans-serif`;
  g.font = fontFor(size);
  while (size > 12 && g.measureText(text).width > width * 0.92) {
    size -= 2;
    g.font = fontFor(size);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = height * 0.08;
  g.strokeStyle = 'rgba(0,0,0,0.65)';
  g.strokeText(text, width / 2, height / 2);
  g.fillStyle = '#ffffff';
  g.fillText(text, width / 2, height / 2);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
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
  for (const stem of Object.keys(STEM_COLORS) as StemId[]) {
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
  body: Mesh<BoxGeometry, MeshStandardMaterial>;
  face: Mesh<PlaneGeometry, MeshBasicMaterial>;
  setLabel: (text: string) => void;
  /** Lit-up look for toggles that are on (mute, solo, echo). */
  setActive: (active: boolean) => void;
  setColor: (color: string) => void;
  active: boolean;
}

export interface ButtonOptions {
  width?: number;
  height?: number;
  color?: string;
  /** 0..1; below 1 lets what is behind the button show through. */
  opacity?: number;
}

/** A poke button with a text label. Default 12 x 8 cm. */
export function makeButton(text: string, options: ButtonOptions = {}): ButtonParts {
  const width = options.width ?? 0.12;
  const height = options.height ?? 0.08;
  const baseColor = new Color(options.color ?? '#7c5cff');
  const root = new Group();
  root.name = 'button';
  const body = new Mesh(
    new BoxGeometry(width, height, 0.02),
    new MeshStandardMaterial({
      color: baseColor.clone(),
      emissive: baseColor.clone(),
      emissiveIntensity: 0.25,
      roughness: 0.5,
      transparent: (options.opacity ?? 1) < 1,
      opacity: options.opacity ?? 1,
    }),
  );
  root.add(body);
  const aspect = width / height;
  const texHeight = 128;
  const texWidth = Math.round(Math.min(1024, texHeight * aspect * 2.2));
  const face = new Mesh(
    new PlaneGeometry(width * 0.94, (width * 0.94 * texHeight) / texWidth),
    new MeshBasicMaterial({
      map: labelTexture(text, texWidth, texHeight),
      transparent: true,
      depthWrite: false,
    }),
  );
  face.position.z = 0.0105;
  face.raycast = () => {};
  root.add(face);

  let currentText = text;
  const parts: ButtonParts = {
    root,
    body,
    face,
    active: false,
    setLabel: (next: string) => {
      if (next === currentText) return;
      currentText = next;
      face.material.map?.dispose();
      face.material.map = labelTexture(next, texWidth, texHeight);
      face.material.needsUpdate = true;
    },
    setActive: (active: boolean) => {
      parts.active = active;
      body.material.color.copy(baseColor);
      if (active) body.material.color.lerp(WHITE, 0.45);
    },
    setColor: (color: string) => {
      baseColor.set(color);
      body.material.emissive.copy(baseColor);
      parts.setActive(parts.active);
    },
  };
  return parts;
}

const WHITE = new Color('#ffffff');

export interface TextPlane {
  mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  setText: (text: string) => void;
}

/** A flat, non-interactive line of text. */
export function makeTextPlane(text: string, width: number, height: number): TextPlane {
  const texHeight = 96;
  const texWidth = Math.round(Math.min(2048, (texHeight * width) / height));
  const mesh = new Mesh(
    new PlaneGeometry(width, height),
    new MeshBasicMaterial({
      map: labelTexture(text, texWidth, texHeight),
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
      mesh.material.map = labelTexture(next, texWidth, texHeight);
      mesh.material.needsUpdate = true;
    },
  };
}
