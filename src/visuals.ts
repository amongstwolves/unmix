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
  Sprite,
  SpriteMaterial,
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
  g.font = `700 ${Math.round(height * 0.5)}px system-ui, -apple-system, sans-serif`;
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

  const label = new Sprite(
    new SpriteMaterial({ map: labelTexture(STEM_LABELS[stem]), depthWrite: false }),
  );
  label.scale.set(0.1, 0.025, 1);
  label.position.set(0, ORB_RADIUS + 0.03, 0);
  label.raycast = () => {};
  root.add(label);

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
}

/** A 12 x 8 cm poke button with a text label. */
export function makeButton(text: string, color = '#7c5cff'): ButtonParts {
  const root = new Group();
  root.name = 'button';
  const body = new Mesh(
    new BoxGeometry(0.12, 0.08, 0.025),
    new MeshStandardMaterial({
      color,
      emissive: new Color(color),
      emissiveIntensity: 0.25,
      roughness: 0.5,
    }),
  );
  root.add(body);
  const face = new Mesh(
    new PlaneGeometry(0.11, 0.0275),
    new MeshBasicMaterial({ map: labelTexture(text), transparent: true, depthWrite: false }),
  );
  face.position.z = 0.0131;
  face.raycast = () => {};
  root.add(face);

  const setLabel = (next: string): void => {
    face.material.map?.dispose();
    face.material.map = labelTexture(next);
    face.material.needsUpdate = true;
  };
  return { root, body, face, setLabel };
}
