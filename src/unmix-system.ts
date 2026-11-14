/**
 * The Unmix core loop for the Saturday milestone:
 *  - a song sphere that plays all four stems in sync,
 *  - two-hand grab + pull apart (or the Split button) splits it into 4 orbs,
 *  - each orb is grabbable and is its own spatial sound source.
 *
 * Hands write to the mix state; audio and visuals read from it.
 */

import {
  createSystem,
  type Entity,
  GrabSystem,
  Grabbed,
  Hovered,
  OneHandGrabbable,
  PokeInteractable,
  Pressed,
  RayInteractable,
  TwoHandsGrabbable,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { AudioEngine } from './audio-engine.js';
import { Layout, ORB_RADIUS, SPHERE_RADIUS } from './layout.js';
import { createMixState, type MixState, STEM_IDS, type StemId } from './mix-state.js';
import { loadTrack } from './tracks.js';
import { PokeButton, SongSphere, StemOrb } from './unmix-components.js';
import { type ButtonParts, type GlowParts, makeButton, makeOrb, makeSongSphere } from './visuals.js';

const DEFAULT_TRACK = 'placeholder';
/** Hands must spread this much farther apart than where the grab began. */
const SPLIT_PULL_METERS = 0.25;
/** Backup trigger: the two-hand grab has stretched the sphere this much. */
const SPLIT_SCALE = 1.6;
/** A hand this close to an orb's surface counts as hovering it. */
const HOVER_RANGE = 0.08;
/** Released orbs within this distance of a slot snap into it. */
const SNAP_RANGE = 0.1;

interface OrbVisual {
  parts: GlowParts;
  hovered: boolean;
  pulse: number;
}

interface SphereVisual {
  parts: GlowParts & { satellites: { position: Vector3 }[] };
}

export class UnmixSystem extends createSystem({
  sphere: { required: [SongSphere] },
  sphereHeld: { required: [SongSphere, Grabbed] },
  orbs: { required: [StemOrb] },
  orbsHeld: { required: [StemOrb, Grabbed] },
  buttons: { required: [PokeButton] },
  buttonsHovered: { required: [PokeButton, Hovered] },
  buttonsPressed: { required: [PokeButton, Pressed] },
}) {
  /** The mix state. Exposed on window.unmix for debugging in the console. */
  state!: MixState;
  private engine!: AudioEngine;
  private layout!: Layout;
  private grab!: GrabSystem;
  private trackReady = false;
  private needsAnchor = 2; // frames to wait before reading the head pose
  private sphereEntity!: Entity;
  private mainButton!: Entity;
  private mainButtonParts!: ButtonParts;
  private pullBaseline: number | null = null;

  // Scratch objects, allocated once.
  private v1 = new Vector3();
  private v2 = new Vector3();
  private v3 = new Vector3();
  private headPos = new Vector3();
  private headFwd = new Vector3();
  private headUp = new Vector3();
  private leftHand = new Vector3();
  private rightHand = new Vector3();

  init(): void {
    this.state = createMixState();
    this.engine = new AudioEngine();
    this.layout = new Layout();
    this.grab = this.world.getSystem(GrabSystem)!;

    (window as unknown as { unmix: unknown }).unmix = {
      state: this.state,
      engine: this.engine,
      split: () => this.split(),
    };

    this.createSphere();
    this.createMainButton();
    this.loadDefaultTrack();
    this.installAudioUnlock();

    this.cleanupFuncs.push(
      this.queries.buttonsPressed.subscribe('qualify', (e) => this.onButton(e)),
      this.queries.sphereHeld.subscribe('qualify', () => {
        this.pullBaseline = null;
        this.engine.unlock();
        this.engine.click(0.8);
      }),
      this.queries.sphereHeld.subscribe('disqualify', () => {
        this.pullBaseline = null;
      }),
      this.queries.orbsHeld.subscribe('qualify', (e) => this.onOrbGrab(e)),
      this.queries.orbsHeld.subscribe('disqualify', (e) => this.onOrbRelease(e)),
      this.world.visibilityState.subscribe((v) => {
        // Re-center the layout on the user when they enter XR, before the split.
        if (v === VisibilityState.Visible) this.needsAnchor = 3;
      }),
    );
  }

  // ---------------------------------------------------------------- setup

  private createSphere(): void {
    const parts = makeSongSphere();
    const entity = this.world.createTransformEntity(parts.root);
    entity.addComponent(SongSphere);
    entity.addComponent(TwoHandsGrabbable, {
      translate: false,
      rotate: false,
      scale: true,
      scaleMin: [1, 1, 1],
      scaleMax: [1.8, 1.8, 1.8],
    });
    parts.root.userData.visual = { parts } satisfies SphereVisual;
    this.sphereEntity = entity;
  }

  private createMainButton(): void {
    const parts = makeButton('Loading…');
    const entity = this.world.createTransformEntity(parts.root);
    entity.addComponent(PokeButton, { action: 'play' });
    entity.addComponent(PokeInteractable);
    entity.addComponent(RayInteractable); // pinch from a distance works too
    parts.root.name = 'main-button';
    this.mainButton = entity;
    this.mainButtonParts = parts;
  }

  private loadDefaultTrack(): void {
    loadTrack(this.engine.ctx, DEFAULT_TRACK)
      .then((track) => {
        this.engine.setTrack(track);
        this.state.trackId = track.info.id;
        this.trackReady = true;
        this.mainButtonParts.setLabel('Play');
        console.info(`[unmix] loaded "${track.info.title}" (${track.info.bpm} bpm)`);
      })
      .catch((error) => {
        console.error('[unmix] track failed to load', error);
        this.mainButtonParts.setLabel('No track');
      });
  }

  /** Browsers only start audio after a user gesture. Any input counts. */
  private installAudioUnlock(): void {
    const unlock = () => this.engine.unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    this.cleanupFuncs.push(() => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    });
  }

  // ---------------------------------------------------------------- actions

  private onButton(entity: Entity): void {
    this.engine.unlock();
    this.engine.click();
    const action = entity.getValue(PokeButton, 'action');
    if (action === 'play') this.startPlayback();
    else if (action === 'split') this.split();
  }

  private startPlayback(): void {
    if (!this.trackReady || this.engine.isPlaying) return;
    this.engine.play();
    this.engine.applyMix(this.state);
    this.state.phase = 'whole';
    this.mainButton.setValue(PokeButton, 'action', 'split');
    this.mainButtonParts.setLabel('Split');
  }

  /** The hero moment: the sphere bursts into four stem orbs. Music keeps playing. */
  split(): void {
    if (this.state.phase === 'split') return;
    if (!this.engine.isPlaying) this.startPlayback();
    if (!this.engine.isPlaying) return; // track not loaded yet

    this.grab.forceRelease(this.sphereEntity);
    const sphereRoot = this.sphereEntity.object3D!;
    sphereRoot.getWorldPosition(this.v1);
    this.hide(this.sphereEntity, TwoHandsGrabbable);
    this.hide(this.mainButton, PokeInteractable, RayInteractable);

    for (const stem of STEM_IDS) {
      const s = this.state.stems[stem];
      if (s.slot !== null) s.position = this.layout.slotTuple(s.slot);
      const parts = makeOrb(stem);
      parts.root.position.copy(this.v1); // start inside the sphere, then fly out
      parts.root.scale.setScalar(0.3);
      const entity = this.world.createTransformEntity(parts.root);
      entity.addComponent(StemOrb, { stem });
      entity.addComponent(OneHandGrabbable, { rotate: false, translate: true });
      parts.root.userData.visual = { parts, hovered: false, pulse: 1 } satisfies OrbVisual;
    }

    this.state.phase = 'split';
    this.engine.burst();
  }

  private hide(entity: Entity, ...components: Parameters<Entity['removeComponent']>[0][]): void {
    for (const c of components) if (entity.hasComponent(c)) entity.removeComponent(c);
    const root = entity.object3D!;
    root.visible = false;
    root.position.set(0, -50, 0); // far out of reach so nothing can touch it
  }

  private onOrbGrab(entity: Entity): void {
    this.engine.unlock();
    this.engine.click(1.2);
    const stem = entity.getValue(StemOrb, 'stem') as StemId;
    this.state.stems[stem].slot = null;
  }

  private onOrbRelease(entity: Entity): void {
    const stem = entity.getValue(StemOrb, 'stem') as StemId;
    const s = this.state.stems[stem];
    const root = entity.object3D!;
    root.getWorldPosition(this.v1);
    const slot = this.layout.nearestSlot(this.v1, SNAP_RANGE, this.v2);
    if (slot !== null) {
      s.slot = slot;
      this.layout.slotPosition(slot, this.v1);
    }
    s.position = [this.v1.x, this.v1.y, this.v1.z];
    (root.userData.visual as OrbVisual).pulse = 1;
    this.engine.click(0.9);
  }

  // ---------------------------------------------------------------- frame

  update(delta: number, time: number): void {
    this.readHead();
    if (this.needsAnchor > 0 && --this.needsAnchor === 0 && this.state.phase !== 'split') {
      this.layout.anchor(this.headPos, this.headFwd);
      this.placeFixedObjects();
    }
    this.engine.setListener(
      this.headPos.x, this.headPos.y, this.headPos.z,
      this.headFwd.x, this.headFwd.y, this.headFwd.z,
      this.headUp.x, this.headUp.y, this.headUp.z,
    );
    this.readHands();

    if (this.state.phase === 'split') this.updateOrbs(delta);
    else this.updateSphere(delta, time);
    this.updateButtons(delta);
  }

  private readHead(): void {
    const head = this.player.head;
    head.updateWorldMatrix(true, false);
    const e = head.matrixWorld.elements;
    this.headPos.set(e[12], e[13], e[14]);
    this.headFwd.set(-e[8], -e[9], -e[10]).normalize();
    this.headUp.set(e[4], e[5], e[6]).normalize();
  }

  private readHands(): void {
    this.player.gripSpaces.left.getWorldPosition(this.leftHand);
    this.player.gripSpaces.right.getWorldPosition(this.rightHand);
  }

  private placeFixedObjects(): void {
    this.layout.spherePosition(this.v1);
    this.state.spherePosition = [this.v1.x, this.v1.y, this.v1.z];
    if (this.sphereEntity.object3D!.visible) {
      this.sphereEntity.object3D!.position.copy(this.v1);
    }
    if (this.mainButton.object3D!.visible) {
      const root = this.mainButton.object3D!;
      this.layout.buttonPosition(0, 1, root.position);
      // Face the user, tilted back so it is easy to poke.
      root.rotation.set(-0.5, this.layout.yaw, 0, 'YXZ');
    }
  }

  private updateSphere(delta: number, time: number): void {
    const root = this.sphereEntity.object3D!;
    const visual = root.userData.visual as SphereVisual;
    const { parts } = visual;
    root.getWorldPosition(this.v1);

    // All four stems come from the sphere until it splits.
    let level = 0;
    for (const id of STEM_IDS) {
      this.engine.setStemPosition(id, this.v1.x, this.v1.y, this.v1.z);
      level += this.engine.getLevel(id);
    }
    level /= STEM_IDS.length;

    // Swirl the four stem lights inside; faster when playing.
    const speed = this.engine.isPlaying ? 1.6 : 0.4;
    parts.satellites.forEach((m, i) => {
      const a = time * speed + (i * Math.PI) / 2;
      const r = SPHERE_RADIUS * 0.5;
      m.position.set(Math.cos(a) * r, Math.sin(a * 1.3 + i) * r * 0.5, Math.sin(a) * r);
    });

    const held = this.queries.sphereHeld.entities.size > 0;
    const leftNear = this.leftHand.distanceTo(this.v1) < SPHERE_RADIUS + 0.15;
    const rightNear = this.rightHand.distanceTo(this.v1) < SPHERE_RADIUS + 0.15;
    const hovered = leftNear || rightNear;

    parts.core.material.emissiveIntensity = 0.35 + level * 1.4 + (hovered ? 0.3 : 0) + (held ? 0.4 : 0);
    parts.glow.material.opacity = 0.12 + level * 0.3 + (hovered ? 0.1 : 0);

    if (!held) {
      root.scale.setScalar(1 + level * 0.06);
      return;
    }

    // Pull apart: compare hand spread now to where the two-hand grab began.
    const spread = this.leftHand.distanceTo(this.rightHand);
    if (this.pullBaseline === null) {
      if (leftNear && rightNear) this.pullBaseline = spread;
    } else if (spread - this.pullBaseline > SPLIT_PULL_METERS) {
      this.split();
      return;
    }
    if (root.scale.x >= SPLIT_SCALE) this.split();
    void delta;
  }

  private updateOrbs(delta: number): void {
    const follow = 1 - Math.exp(-delta * 8);
    for (const entity of this.queries.orbs.entities) {
      const stem = entity.getValue(StemOrb, 'stem') as StemId;
      const s = this.state.stems[stem];
      const root = entity.object3D!;
      const visual = root.userData.visual as OrbVisual;
      const held = entity.hasComponent(Grabbed);

      if (held) {
        // Hands write the mix state.
        root.getWorldPosition(this.v1);
        s.position[0] = this.v1.x;
        s.position[1] = this.v1.y;
        s.position[2] = this.v1.z;
      } else {
        // Visuals read the mix state (this also animates the split fly-out).
        this.v2.set(s.position[0], s.position[1], s.position[2]);
        root.position.lerp(this.v2, follow);
      }

      root.getWorldPosition(this.v1);
      this.engine.setStemPosition(stem, this.v1.x, this.v1.y, this.v1.z);

      const near =
        Math.min(this.leftHand.distanceTo(this.v1), this.rightHand.distanceTo(this.v1)) <
        ORB_RADIUS + HOVER_RANGE;
      visual.hovered = near;
      visual.pulse = Math.max(0, visual.pulse - delta * 2.5);

      const level = this.engine.getLevel(stem);
      const { core, glow } = visual.parts;
      core.material.emissiveIntensity = 0.4 + level * 2 + (near ? 0.4 : 0) + (held ? 0.6 : 0);
      glow.material.opacity = 0.12 + level * 0.35 + (near ? 0.12 : 0) + (held ? 0.15 : 0);

      const target = (held ? 1.15 : near ? 1.06 : 1) + visual.pulse * 0.25 + level * 0.08;
      const s0 = root.scale.x;
      root.scale.setScalar(s0 + (target - s0) * Math.min(1, delta * 12));
    }
  }

  private updateButtons(delta: number): void {
    for (const entity of this.queries.buttons.entities) {
      const root = entity.object3D!;
      if (!root.visible) continue;
      const hovered = entity.hasComponent(Hovered);
      const pressed = entity.hasComponent(Pressed);
      const target = pressed ? 0.92 : hovered ? 1.08 : 1;
      const s0 = root.scale.x;
      root.scale.setScalar(s0 + (target - s0) * Math.min(1, delta * 15));
      const body = this.mainButtonParts.body;
      if (entity === this.mainButton) {
        body.material.emissiveIntensity = pressed ? 0.9 : hovered ? 0.55 : 0.25;
      }
    }
  }
}
