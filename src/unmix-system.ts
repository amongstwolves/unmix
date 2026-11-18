/**
 * The Unmix core loop.
 *
 *   idle   track shelf; poke a tile to load a song into the sphere
 *   whole  the song sphere plays; pull it apart (or poke Split)
 *   split  four stem orbs to place and shape; producer chips; push two orbs
 *          together (or poke Mix down) to fuse them back into the sphere
 *
 * Hands, buttons and producer chips write the mix state; the audio graph and
 * visuals read it.
 */

import {
  Color,
  createSystem,
  type Entity,
  GrabSystem,
  Grabbed,
  Hovered,
  type Mesh,
  OneHandGrabbable,
  type Object3D,
  PokeInteractable,
  Pressed,
  RayInteractable,
  TwoHandsGrabbable,
  Vector3,
  VisibilityState,
} from '@iwsdk/core';
import { AudioEngine } from './audio-engine.js';
import { Layout, ORB_RADIUS, SPHERE_RADIUS } from './layout.js';
import {
  applyAction,
  setPitch,
  type Suggestion,
  toggleMute,
  toggleSolo,
  validateSuggestion,
} from './mix-actions.js';
import {
  ALL_STEMS,
  createMixState,
  isStemAudible,
  type MixState,
  snapshotMix,
  STEM_IDS,
  type StemId,
} from './mix-state.js';
import {
  type LoadedTrack,
  loadSuggestionsFile,
  loadTrack,
  loadTrackInfo,
  loadTrackList,
  type TrackInfo,
} from './tracks.js';
import { MixStateMirror, PokeButton, SongSphere, StemOrb } from './unmix-components.js';
import {
  type ButtonOptions,
  type ButtonParts,
  type GlowParts,
  makeButton,
  makeOrb,
  makeSongSphere,
  makeTextPlane,
  STEM_COLORS,
  STEM_LABELS,
  type TextPlane,
} from './visuals.js';
import { ORB_WAVE_RISE, type OrbWave, WaveformViews } from './waveform.js';
import { LoopRecorder, type MicError } from './recorder.js';

/** Hands must spread this much farther apart than where the grab began. */
const SPLIT_PULL_METERS = 0.25;
/** Backup trigger: the two-hand grab has stretched the sphere this much. */
const SPLIT_SCALE = 1.6;
/** A hand this close to an orb's surface counts as hovering it. */
const HOVER_RANGE = 0.08;
/** Released orbs within this distance of a slot snap into it. */
const SNAP_RANGE = 0.1;
/** A held orb this close (center to center) to another one recombines. */
const FUSE_DISTANCE = ORB_RADIUS * 2 + 0.02;
/** Tabs float this far below their orb. */
const TAB_DROP = 0.15;
const MERGE_SECONDS = 0.6;
/** Orbs must stay pushed together this long to fuse (not just pass by). */
const FUSE_HOLD_SECONDS = 0.4;
const FILTER_STEP = 0.15;
const ECHO_ON = 0.45;
const SAVED_KEY = (trackId: string) => `unmix.savedMix.${trackId}`;
/** Arc slots the Record button (and then the YOU orb) prefers, in order. */
const RECORD_SLOT_ORDER = [5, 2, 7, 0, 6, 1, 3, 4];
const MUTED_GRAY = new Color('#7a7a80');
/** The song sphere's violet, also used for whole-song actions. */
const SPHERE_COLOR = '#c9b6ff';

interface OrbVisual {
  parts: GlowParts;
  pulse: number;
}

interface SphereVisual {
  parts: GlowParts & { satellites: Mesh[] };
}

/** A button we created, and how to place it. */
interface Button {
  entity: Entity;
  parts: ButtonParts;
  place: ((out: Vector3) => Vector3) | null;
  shown: boolean;
}

interface Label {
  entity: Entity;
  text: TextPlane;
  place: (out: Vector3) => Vector3;
}

interface OrbRecord {
  orb: Entity;
  tab: Button;
  wave: OrbWave;
  waveEntity: Entity;
}

export class UnmixSystem extends createSystem({
  sphereHeld: { required: [SongSphere, Grabbed] },
  orbs: { required: [StemOrb] },
  orbsHeld: { required: [StemOrb, Grabbed] },
  buttons: { required: [PokeButton] },
  buttonsPressed: { required: [PokeButton, Pressed] },
}) {
  /** The mix state. Exposed on window.unmix for debugging in the console. */
  state!: MixState;
  private engine!: AudioEngine;
  private layout!: Layout;
  private grab!: GrabSystem;

  private track: LoadedTrack | null = null;
  private loadingTrack = false;
  private trackCache = new Map<string, LoadedTrack>();
  private trackIds: string[] = [];
  private suggestions: Suggestion[] = [];
  private chipOffset = 0;
  private pending: { suggestion: Suggestion; before: MixState } | null = null;
  private savedMix: MixState | null = null;
  /** Stem the panel controls; null = no panel (browse mode). */
  private selected: StemId | null = null;
  private producerOpen = false;
  private savedToastTimer = 0;
  private toast!: Label;
  private browse!: { ask: Button; mixdown: Button };

  private needsAnchor = 2; // frames to wait before reading the head pose
  private sphereEntity!: Entity;
  private pullBaseline: number | null = null;
  private mergeTimer = 0;
  private fuseTimer = 0;
  /** Where the held orb was when grabbed, so a fuse can put it back. */
  private grabStart: { stem: StemId; position: [number, number, number]; slot: number | null } | null = null;

  private trackTiles: Button[] = [];
  private wholeRow!: { split: Button; restore: Button; tracks: Button };
  private panel!: Record<
    'mute' | 'solo' | 'echo' | 'done' | 'darker' | 'brighter' | 'pitchDown' | 'pitchUp',
    Button
  >;
  private chips: Button[] = [];
  private note!: Label;
  private orbRecords = new Map<StemId, OrbRecord>();
  private waves!: WaveformViews;
  /** Reused every frame for the waveform update (no per-frame allocation). */
  private orbWaveList: [StemId, OrbWave][] = [];
  private playheadOf = (id: StemId): number => this.engine.getPlayheadFraction(id);

  private recorder!: LoopRecorder;
  private recordButton!: Button;
  private recState: 'none' | 'preparing' | 'countin' | 'recording' = 'none';
  private recStart = 0;
  private recEnd = 0;
  /** Bumped when the track changes, so a stale take is thrown away. */
  private recToken = 0;
  private recMessage: string | null = null;

  // Scratch objects, allocated once.
  private v1 = new Vector3();
  private v2 = new Vector3();
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
      mixDown: () => this.mixDown(),
    };

    this.createSphere();
    this.createButtons();
    this.waves = new WaveformViews();
    this.recorder = new LoopRecorder(this.engine.ctx);
    this.world.createTransformEntity(this.waves.strip);
    this.installAudioUnlock();
    void this.loadShelf();

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
        // Re-center on the user when they enter XR, unless orbs are out.
        if (v === VisibilityState.Visible) this.needsAnchor = 3;
      }),
    );
    this.refreshUi();
  }

  // ================================================================ setup

  private createSphere(): void {
    const parts = makeSongSphere();
    const entity = this.world.createTransformEntity(parts.root);
    entity.addComponent(SongSphere);
    entity.addComponent(MixStateMirror);
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

  private makeBtn(
    name: string,
    text: string,
    action: string,
    place: ((out: Vector3) => Vector3) | null,
    options?: ButtonOptions,
  ): Button {
    const parts = makeButton(text, options);
    parts.root.name = name;
    const entity = this.world.createTransformEntity(parts.root);
    entity.addComponent(PokeButton, { action });
    const button: Button = { entity, parts, place, shown: false };
    parts.root.userData.button = button;
    parts.root.visible = false;
    return button;
  }

  private makeLabel(text: string, width: number, height: number, place: Label['place']): Label {
    const plane = makeTextPlane(text, width, height);
    const entity = this.world.createTransformEntity(plane.mesh);
    plane.mesh.visible = false;
    return { entity, text: plane, place };
  }

  private createButtons(): void {
    const L = this.layout;
    this.wholeRow = {
      split: this.makeBtn('split-button', 'Split', 'split', (o) => L.buttonPosition(0, 3, o), { style: 'accent', color: SPHERE_COLOR }),
      restore: this.makeBtn('saved-mix-button', 'Saved mix', 'restore', (o) => L.buttonPosition(1, 3, o)),
      tracks: this.makeBtn('tracks-button', 'Tracks', 'tracks', (o) => L.buttonPosition(2, 3, o)),
    };
    const small = { width: 0.1, height: 0.08 };
    const at = (col: number, row: number) => (o: Vector3) => L.panelPosition(col, row, o);
    // Shown only while a stem is selected: toggles on top, shaping below.
    this.panel = {
      mute: this.makeBtn('mute-button', 'Mute', 'mute', at(0, 0), small),
      solo: this.makeBtn('solo-button', 'Solo', 'solo', at(1, 0), small),
      echo: this.makeBtn('echo-button', 'Echo', 'echo', at(2, 0), small),
      done: this.makeBtn('done-button', 'Done', 'done', at(3, 0), small),
      darker: this.makeBtn('darker-button', 'Darker', 'darker', at(0, 1), small),
      brighter: this.makeBtn('brighter-button', 'Brighter', 'brighter', at(1, 1), small),
      // Pitch uses playback rate, so speed changes too: say so on the keys.
      pitchDown: this.makeBtn('pitch-down-button', 'Pitch/speed −', 'pitchDown', at(2, 1), small),
      pitchUp: this.makeBtn('pitch-up-button', 'Pitch/speed +', 'pitchUp', at(3, 1), small),
    };
    // Shown while nothing is selected.
    this.browse = {
      ask: this.makeBtn('ask-button', 'Ask producer', 'ask', at(1, 0), {
        width: 0.12,
        height: 0.08,
        color: '#b4aea4', // "on" = a darker warm gray; color is kept for stems
      }),
      mixdown: this.makeBtn('mixdown-button', 'Mix down', 'mixdown', at(2, 0), {
        width: 0.12,
        height: 0.08,
        style: 'accent',
        color: SPHERE_COLOR,
      }),
    };
    for (let i = 0; i < 3; i += 1) {
      this.chips.push(
        this.makeBtn(`chip-${i}`, '…', `chip:${i}`, (o) => L.chipPosition(i, o), {
          width: 0.19,
          height: 0.08,
          style: 'glass',
          color: '#c9b6ff',
        }),
      );
    }
    this.toast = this.makeLabel('Mix saved', 0.2, 0.035, (o) => L.toastPosition(o));
    this.note = this.makeLabel('', 0.62, 0.035, (o) => L.notePosition(o));
    // Placed at a free arc slot in refreshUi(); the YOU orb appears there.
    this.recordButton = this.makeBtn('record-button', 'Record', 'record', null, {
      width: 0.1,
      height: 0.08,
      style: 'record',
    });
  }

  private async loadShelf(): Promise<void> {
    this.trackIds = await loadTrackList();
    const infos = await Promise.all(
      this.trackIds.map((id) => loadTrackInfo(id).catch(() => null)),
    );
    const count = this.trackIds.length;
    this.trackIds.forEach((id, i) => {
      const info = infos[i] as TrackInfo | null;
      const title = info?.title ?? id;
      const tile = this.makeBtn(
        `track-tile-${id}`,
        title.length > 14 ? `${title.slice(0, 13)}…` : title,
        `track:${id}`,
        (o) => this.layout.buttonPosition(i, count, o),
        { style: 'accent', color: SPHERE_COLOR },
      );
      this.trackTiles.push(tile);
    });
    this.placeAll();
    this.refreshUi();
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

  // ================================================================ buttons

  private lastPress = { entity: null as Entity | null, time: 0 };

  private onButton(entity: Entity): void {
    const root = entity.object3D;
    const button = root?.userData.button as Button | undefined;
    if (button && !button.shown) return;
    // A finger pushing through a button can register more than once, and a
    // sweeping hand can brush a neighbor: debounce both.
    const now = performance.now();
    const since = now - this.lastPress.time;
    if (since < (entity === this.lastPress.entity ? 400 : 150)) return;
    this.lastPress.entity = entity;
    this.lastPress.time = now;
    this.engine.unlock();
    this.engine.click();
    const action = entity.getValue(PokeButton, 'action') ?? '';
    const [verb, arg] = action.split(':');
    switch (verb) {
      case 'track': void this.selectTrack(arg); break;
      case 'split': this.split(); break;
      case 'restore': this.restoreSaved(); break;
      case 'tracks': this.goIdle(); break;
      case 'select': this.selected = this.selected === arg ? null : (arg as StemId); break;
      case 'done': this.selected = null; break;
      case 'ask': this.producerOpen = !this.producerOpen; break;
      case 'mixdown': this.mixDown(); break;
      case 'chip': this.onChip(Number(arg)); break;
      case 'record': void this.startRecording(); break;
      case 'keep': this.keepSuggestion(); break;
      case 'undo': this.undoSuggestion(); break;
      default: this.onStemControl(verb); break;
    }
    this.refreshUi();
  }

  private onStemControl(verb: string): void {
    if (!this.selected) return;
    const stem = this.state.stems[this.selected];
    switch (verb) {
      case 'mute': toggleMute(this.state, this.selected); break;
      case 'solo': toggleSolo(this.state, this.selected); break;
      case 'darker': stem.filter = Math.max(0, stem.filter - FILTER_STEP); break;
      case 'brighter': stem.filter = Math.min(1, stem.filter + FILTER_STEP); break;
      case 'echo': stem.echo = stem.echo > 0 ? 0 : ECHO_ON; break;
      case 'pitchDown': setPitch(this.state, this.selected, stem.pitch - 1); break;
      case 'pitchUp': setPitch(this.state, this.selected, stem.pitch + 1); break;
      default: return;
    }
    this.engine.applyMix(this.state);
  }

  // ================================================================ tracks

  private async selectTrack(trackId: string): Promise<void> {
    if (this.loadingTrack) return;
    this.loadingTrack = true;
    const tile = this.trackTiles.find((t) => t.entity.getValue(PokeButton, 'action') === `track:${trackId}`);
    tile?.parts.setLabel('Loading…');
    try {
      let track = this.trackCache.get(trackId);
      if (!track) {
        track = await loadTrack(this.engine.ctx, trackId);
        this.trackCache.set(trackId, track);
      }
      this.engine.stop();
      this.engine.setTrack(track);
      this.track = track;
      this.waves.setTrack(track);

      // Fresh mix for the new track, keeping the layout anchor.
      const fresh = createMixState();
      for (const id of ALL_STEMS) this.state.stems[id] = fresh.stems[id];
      this.state.hasRecording = false; // the engine dropped it with the old track
      this.recToken += 1;
      this.recState = 'none';
      this.state.trackId = track.info.id;
      this.state.loopSectionId = null;
      this.selected = null;
      this.producerOpen = false;

      const sectionIds = track.info.sections.map((s) => s.id);
      this.suggestions = (await loadSuggestionsFile(trackId))
        .map((raw) => validateSuggestion(raw, sectionIds))
        .filter((s): s is Suggestion => s !== null);
      this.chipOffset = 0;
      this.pending = null;
      this.savedMix = this.readSaved(trackId);

      this.engine.play();
      this.engine.applyMix(this.state);
      this.state.phase = 'whole';
      this.showSphere();
      console.info(`[unmix] playing "${track.info.title}" (${this.suggestions.length} producer ideas)`);
    } catch (error) {
      console.error('[unmix] track failed to load', error);
    } finally {
      tile?.parts.setLabel(this.track?.info.id === trackId ? (this.track.info.title.slice(0, 14)) : trackId);
      this.loadingTrack = false;
      this.refreshUi();
    }
  }

  /** Back to the track shelf. Stops the music. */
  private goIdle(): void {
    if (this.state.phase === 'split') this.removeOrbs();
    this.recToken += 1;
    this.recState = 'none';
    this.grab.forceRelease(this.sphereEntity);
    this.engine.stop();
    this.pending = null;
    this.state.phase = 'idle';
    this.showSphere();
  }

  // ================================================================ split / fuse

  /** The hero moment: the sphere bursts into four stem orbs. Music keeps playing. */
  split(): void {
    if (this.state.phase !== 'whole' || !this.engine.isPlaying) return;

    this.grab.forceRelease(this.sphereEntity);
    this.sphereEntity.object3D!.getWorldPosition(this.v1);
    this.hideSphere();

    const stems: StemId[] = this.state.hasRecording ? [...ALL_STEMS] : [...STEM_IDS];
    for (const stem of stems) {
      const s = this.state.stems[stem];
      if (s.slot !== null) s.position = this.layout.slotTuple(s.slot);
      this.createOrb(stem, this.v1); // start inside the sphere, then fly out
    }

    this.state.phase = 'split';
    this.engine.burst();
    this.refreshUi();
  }

  /** One stem orb with its name tab and mini waveform, starting at `from`. */
  private createOrb(stem: StemId, from: Vector3): void {
    const parts = makeOrb(stem);
    parts.root.position.copy(from);
    parts.root.scale.setScalar(0.3);
    const orb = this.world.createTransformEntity(parts.root);
    orb.addComponent(StemOrb, { stem });
    orb.addComponent(OneHandGrabbable, { rotate: false, translate: true });
    parts.root.userData.visual = { parts, pulse: 1 } satisfies OrbVisual;

    const tab = this.makeBtn(`tab-${stem}`, STEM_LABELS[stem], `select:${stem}`, null, {
      width: 0.1,
      height: 0.08,
      style: 'accent',
      color: STEM_COLORS[stem],
    });
    this.setShown(tab, true);
    const wave = this.waves.makeOrbWave(stem);
    wave.root.position.copy(from);
    const waveEntity = this.world.createTransformEntity(wave.root);
    this.orbRecords.set(stem, { orb, tab, wave, waveEntity });
    this.orbWaveList = [...this.orbRecords].map(([id, r]) => [id, r.wave]);
  }

  // ================================================================ recording

  /**
   * Record one loop of your own sound: a count-in to the next bar line, then
   * exactly REC bars. The take loops in time with the song as the YOU orb.
   */
  private async startRecording(): Promise<void> {
    if (this.recState !== 'none' || this.state.phase !== 'split' || !this.engine.isPlaying) return;
    const token = this.recToken;
    this.recState = 'preparing';
    this.recMessage = null;
    this.refreshUi();
    try {
      // A permission prompt can hide behind the immersive view; don't wait forever.
      await Promise.race([
        this.recorder.prepare(this.engine.beat),
        new Promise((_, reject) => setTimeout(() => reject('timeout'), 15000)),
      ]);
    } catch (error) {
      this.recState = 'none';
      this.recMessage =
        (error as MicError | 'timeout') === 'denied' ? 'Mic blocked'
        : error === 'timeout' ? 'Allow mic' : 'No mic';
      console.warn('[unmix] microphone not available:', error);
      this.refreshUi();
      return;
    }
    if (token !== this.recToken) return;

    const ctx = this.engine.ctx;
    const bar = this.engine.bar;
    const bars = bar * 2 <= 10 ? 2 : 1; // keep takes short
    // At least most of a bar of count-in, starting on a bar line.
    const start = this.engine.nextBarTime(ctx.currentTime + bar * 0.9);
    const beat = this.engine.beat;
    for (let t = start - beat; t > ctx.currentTime + 0.05; t -= beat) {
      const beatsBefore = Math.round((start - t) / beat);
      this.engine.scheduleClick(t, beatsBefore % 4 === 0);
    }
    this.recStart = start;
    this.recEnd = start + bars * bar;
    this.recState = 'countin';
    this.refreshUi();

    const buffer = await this.recorder.record(start, bars * bar);
    if (token !== this.recToken) return;
    this.engine.setRecording(buffer, start);
    this.waves.setRecordingWave(buffer);
    const first = !this.state.hasRecording;
    this.state.hasRecording = true;
    this.recState = 'none';
    this.engine.applyMix(this.state);

    const record = this.orbRecords.get('you');
    if (record) {
      // Re-record: keep the orb, swap its waveform.
      record.waveEntity.dispose();
      const wave = this.waves.makeOrbWave('you');
      record.wave = wave;
      record.waveEntity = this.world.createTransformEntity(wave.root);
      this.orbWaveList = [...this.orbRecords].map(([id, r]) => [id, r.wave]);
    } else if (this.state.phase === 'split' && this.mergeTimer <= 0) {
      const you = this.state.stems.you;
      if (first || you.slot === null) {
        const slot = this.freeSlot() ?? RECORD_SLOT_ORDER[0];
        you.slot = slot;
        you.position = this.layout.slotTuple(slot);
      }
      this.recordButton.parts.root.getWorldPosition(this.v1);
      this.createOrb('you', this.v1);
      this.selected = 'you';
    }
    this.engine.click(1.4);
    this.refreshUi();
  }

  /** First free arc slot for the Record button / YOU orb, or null. */
  private freeSlot(): number | null {
    for (const slot of RECORD_SLOT_ORDER) {
      this.layout.slotPosition(slot, this.v2);
      let taken = false;
      for (const id of this.orbRecords.keys()) {
        const p = this.state.stems[id].position;
        if (this.state.stems[id].slot === slot ||
            Math.hypot(p[0] - this.v2.x, p[1] - this.v2.y, p[2] - this.v2.z) < 0.12) {
          taken = true;
          break;
        }
      }
      if (!taken) return slot;
    }
    return null;
  }

  private recordLabel(): string {
    const now = this.engine.ctx.currentTime;
    switch (this.recState) {
      case 'preparing': return 'Mic…';
      case 'countin': return now < this.recStart
        ? String(Math.max(1, Math.ceil((this.recStart - now) / this.engine.beat - 0.01)))
        : 'Recording';
      case 'recording': return 'Recording';
      default: return this.recMessage ?? (this.state.hasRecording ? 'Re-record' : 'Record');
    }
  }

  /** Push the orbs back into one sphere and save the mix. */
  mixDown(): void {
    if (this.state.phase !== 'split' || this.mergeTimer > 0) return;
    if (this.pending) this.keepSuggestion();
    // Set first: releasing the orbs below must not re-place them.
    this.mergeTimer = MERGE_SECONDS;
    for (const { orb, tab } of this.orbRecords.values()) {
      this.grab.forceRelease(orb);
      if (orb.hasComponent(OneHandGrabbable)) orb.removeComponent(OneHandGrabbable);
      this.setShown(tab, false);
    }
    this.saveMix();
    this.engine.click(0.6);
    this.refreshUi();
  }

  private finishMerge(): void {
    this.removeOrbs();
    this.state.phase = 'whole';
    this.showSphere();
    this.engine.burst();
    this.refreshUi();
  }

  private removeOrbs(): void {
    for (const { orb, tab, waveEntity } of this.orbRecords.values()) {
      orb.dispose();
      tab.entity.dispose();
      waveEntity.dispose();
    }
    this.orbRecords.clear();
    this.orbWaveList = [];
    this.mergeTimer = 0;
  }

  private showSphere(): void {
    const root = this.sphereEntity.object3D!;
    this.layout.spherePosition(root.position);
    this.state.spherePosition = [root.position.x, root.position.y, root.position.z];
    root.scale.setScalar(1);
    root.visible = true;
  }

  /** Hidden, and far out of reach so nothing can grab it. */
  private hideSphere(): void {
    const root = this.sphereEntity.object3D!;
    root.visible = false;
    root.position.set(0, -50, 0);
  }

  private onOrbGrab(entity: Entity): void {
    this.engine.unlock();
    this.engine.click(1.2);
    const stem = entity.getValue(StemOrb, 'stem') as StemId;
    const s = this.state.stems[stem];
    this.grabStart = { stem, position: [...s.position], slot: s.slot };
    s.slot = null;
    this.fuseTimer = 0;
    this.selected = stem; // grabbing an orb selects it for the panel
    this.refreshUi();
  }

  private onOrbRelease(entity: Entity): void {
    if (this.mergeTimer > 0 || this.state.phase !== 'split') return;
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
    this.refreshUi();
  }

  // ================================================================ saved mix

  private saveMix(): void {
    if (!this.state.trackId) return;
    const snap = snapshotMix(this.state);
    snap.phase = 'whole';
    this.savedMix = snap;
    this.savedToastTimer = 4;
    try {
      localStorage.setItem(SAVED_KEY(this.state.trackId), JSON.stringify(snap));
    } catch {
      // Storage can be unavailable (private mode); the in-memory copy still works.
    }
  }

  private readSaved(trackId: string): MixState | null {
    try {
      const raw = localStorage.getItem(SAVED_KEY(trackId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as MixState;
      return parsed?.version === 1 && parsed.stems ? parsed : null;
    } catch {
      return null;
    }
  }

  private restoreSaved(): void {
    if (!this.savedMix || this.state.phase !== 'whole') return;
    this.copyMix(this.savedMix);
    this.split();
  }

  /** Copy stem settings and loop from a snapshot into the live state. */
  private copyMix(from: MixState): void {
    for (const id of ALL_STEMS) {
      // Older saved mixes have no "you" stem; keep the live one then.
      if (from.stems[id]) this.state.stems[id] = JSON.parse(JSON.stringify(from.stems[id]));
    }
    this.setLoopSection(from.loopSectionId);
    this.engine.applyMix(this.state);
  }

  private setLoopSection(sectionId: string | null): void {
    const section = this.track?.info.sections.find((s) => s.id === sectionId) ?? null;
    this.state.loopSectionId = section ? section.id : null;
    this.engine.setLoop(section);
  }

  // ================================================================ producer chips

  private onChip(index: number): void {
    if (this.pending || this.suggestions.length === 0) return;
    const suggestion = this.suggestions[(this.chipOffset + index) % this.suggestions.length];
    const before = snapshotMix(this.state);
    for (const action of suggestion.actions) {
      const loop = applyAction(this.state, action, (slot) => this.layout.slotTuple(slot));
      if (loop) this.setLoopSection(loop);
    }
    this.engine.applyMix(this.state);
    this.pending = { suggestion, before };
  }

  private keepSuggestion(): void {
    if (!this.pending) return;
    this.pending = null;
    this.chipOffset += 3;
    this.producerOpen = false; // calm again; Ask for three fresh ideas
  }

  private undoSuggestion(): void {
    if (!this.pending) return;
    this.copyMix(this.pending.before);
    this.pending = null;
    this.producerOpen = false;
  }

  // ================================================================ UI state

  private setShown(button: Button, shown: boolean): void {
    if (button.shown === shown) return;
    button.shown = shown;
    button.parts.root.visible = shown;
    const e = button.entity;
    if (shown) {
      if (!e.hasComponent(PokeInteractable)) e.addComponent(PokeInteractable);
      if (!e.hasComponent(RayInteractable)) e.addComponent(RayInteractable); // pinch from a distance
    } else {
      if (e.hasComponent(PokeInteractable)) e.removeComponent(PokeInteractable);
      if (e.hasComponent(RayInteractable)) e.removeComponent(RayInteractable);
    }
  }

  private setAction(button: Button, action: string): void {
    button.entity.setValue(PokeButton, 'action', action);
  }

  /** Make every button, label and tab match the current state. */
  private refreshUi(): void {
    this.sphereEntity.setValue(
      MixStateMirror,
      'json',
      JSON.stringify({ ...this.state, selected: this.selected, pending: this.pending?.suggestion.label ?? null, saved: this.savedMix !== null }),
    );
    const phase = this.state.phase;
    this.waves.strip.visible = phase !== 'idle';
    const merging = this.mergeTimer > 0;
    const split = phase === 'split' && !merging;

    for (const tile of this.trackTiles) this.setShown(tile, phase === 'idle');
    this.setShown(this.wholeRow.split, phase === 'whole');
    this.setShown(this.wholeRow.restore, phase === 'whole' && this.savedMix !== null);
    this.setShown(this.wholeRow.tracks, phase === 'whole' && this.trackIds.length > 1);

    // Panel only for a selected stem; otherwise the calm browse row.
    if (this.selected && !this.orbRecords.has(this.selected)) this.selected = null;
    const sel = split ? this.selected : null;
    for (const button of Object.values(this.panel)) this.setShown(button, sel !== null);
    this.setShown(this.browse.ask, split && sel === null && this.suggestions.length > 0);
    this.setShown(this.browse.mixdown, split && sel === null);
    this.browse.ask.parts.setLabel(this.producerOpen || this.pending ? 'Hide ideas' : 'Ask producer');
    this.browse.ask.parts.setActive(this.producerOpen || this.pending !== null);
    if (sel) {
      const stem = this.state.stems[sel];
      for (const [key, button] of Object.entries(this.panel)) {
        if (key !== 'done') button.parts.setColor(STEM_COLORS[sel]);
      }
      this.panel.mute.parts.setActive(stem.muted);
      this.panel.solo.parts.setActive(stem.soloed);
      this.panel.echo.parts.setActive(stem.echo > 0);
    }

    for (const [id, { tab }] of this.orbRecords) {
      const s = this.state.stems[id];
      const flag = s.soloed ? ' SOLO' : s.muted ? ' MUTE' : s.pitch !== 0 ? ` ${s.pitch > 0 ? '+' : ''}${s.pitch}` : '';
      tab.parts.setLabel(`${STEM_LABELS[id]}${flag}`);
      tab.parts.setActive(id === this.selected);
    }

    // Record button: at a free arc slot, while the orbs are out.
    const recSlot = split ? this.freeSlot() : null;
    const recBusy = this.recState !== 'none';
    this.setShown(this.recordButton, split && (recSlot !== null || recBusy));
    if (recSlot !== null && !recBusy) {
      const root = this.recordButton.parts.root;
      this.layout.slotPosition(recSlot, root.position);
      this.faceHead(root);
    }
    this.recordButton.parts.setLabel(this.recordLabel());
    this.recordButton.parts.setActive(recBusy);

    if (this.pending) this.producerOpen = true;
    const hasChips = split && this.suggestions.length > 0 && this.producerOpen;
    this.chips.forEach((chip, i) => this.setShown(chip, hasChips));
    this.note.entity.object3D!.visible = hasChips;
    if (hasChips) {
      if (this.pending) {
        this.setAction(this.chips[0], 'none');
        this.chips[0].parts.setLabel(this.pending.suggestion.label);
        this.setAction(this.chips[1], 'keep');
        this.chips[1].parts.setLabel('Keep');
        this.setAction(this.chips[2], 'undo');
        this.chips[2].parts.setLabel('Undo');
        this.note.text.setText(this.pending.suggestion.why);
      } else {
        this.chips.forEach((chip, i) => {
          const s = this.suggestions[(this.chipOffset + i) % this.suggestions.length];
          this.setAction(chip, `chip:${i}`);
          chip.parts.setLabel(s.label);
        });
        this.note.text.setText('Poke an idea to hear it. Keep it or undo it.');
      }
      this.chips[0].parts.setActive(this.pending !== null);
    }
  }

  /** Put the fixed UI where the layout says, facing the user. */
  private placeAll(): void {
    if (this.sphereEntity.object3D!.visible) this.showSphere();
    const all: Button[] = [
      ...this.trackTiles,
      ...Object.values(this.wholeRow),
      ...Object.values(this.panel),
      ...Object.values(this.browse),
      ...this.chips,
    ];
    for (const b of all) {
      if (!b.place) continue;
      b.place(b.parts.root.position);
      this.faceHead(b.parts.root);
    }
    this.layout.stripPosition(this.waves.strip.position);
    this.faceHead(this.waves.strip);
    for (const label of [this.note, this.toast]) {
      const root = label.entity.object3D!;
      label.place(root.position);
      this.faceHead(root);
    }
  }

  /** Turn a flat object so its front (+Z) faces the anchored head. */
  private faceHead(obj: Object3D): void {
    const head = this.layout.head;
    const dx = head.x - obj.position.x;
    const dz = head.z - obj.position.z;
    const dy = head.y - obj.position.y;
    obj.rotation.set(-Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(dx, dz), 0, 'YXZ');
  }

  // ================================================================ frame

  update(delta: number, time: number): void {
    this.readHead();
    if (this.needsAnchor > 0 && --this.needsAnchor === 0 && this.state.phase !== 'split') {
      this.layout.anchor(this.headPos, this.headFwd);
      this.placeAll();
    }
    this.engine.setListener(
      this.headPos.x, this.headPos.y, this.headPos.z,
      this.headFwd.x, this.headFwd.y, this.headFwd.z,
      this.headUp.x, this.headUp.y, this.headUp.z,
    );
    this.player.gripSpaces.left.getWorldPosition(this.leftHand);
    this.player.gripSpaces.right.getWorldPosition(this.rightHand);

    if (this.savedToastTimer > 0) {
      this.savedToastTimer -= delta;
      const root = this.toast.entity.object3D!;
      root.visible = this.savedToastTimer > 0 && this.state.phase === 'whole';
      // Fade out over the last half second.
      (this.toast.text.mesh.material).opacity = Math.min(1, this.savedToastTimer * 2);
    }
    if (this.recState === 'countin') {
      // Live count-in numbers, then "Recording" until the take is in.
      this.recordButton.parts.setLabel(this.recordLabel());
      const t = this.engine.ctx.currentTime;
      const flash = t >= this.recStart && Math.floor(t * 3) % 2 === 0;
      this.recordButton.parts.setActive(!flash);
    }
    if (this.state.phase === 'split') this.updateOrbs(delta);
    else this.updateSphere(time);
    if (this.state.phase !== 'idle') this.waves.update(this.state, this.playheadOf, this.orbWaveList);
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

  private updateSphere(time: number): void {
    const root = this.sphereEntity.object3D!;
    const { parts } = root.userData.visual as SphereVisual;
    root.getWorldPosition(this.v1);

    // Every stem comes from the sphere until it splits.
    let level = 0;
    for (const id of ALL_STEMS) {
      this.engine.setStemPosition(id, this.v1.x, this.v1.y, this.v1.z);
      level += this.engine.getLevel(id);
    }
    level /= STEM_IDS.length;

    const playing = this.engine.isPlaying;
    const speed = playing ? 1.6 : 0.3;
    for (let i = 0; i < parts.satellites.length; i += 1) {
      const a = time * speed + (i * Math.PI) / 2;
      const r = SPHERE_RADIUS * 0.5;
      parts.satellites[i].position.set(Math.cos(a) * r, Math.sin(a * 1.3 + i) * r * 0.5, Math.sin(a) * r);
    }

    const held = this.queries.sphereHeld.entities.size > 0;
    const leftNear = this.leftHand.distanceTo(this.v1) < SPHERE_RADIUS + 0.15;
    const rightNear = this.rightHand.distanceTo(this.v1) < SPHERE_RADIUS + 0.15;
    const hovered = playing && (leftNear || rightNear);

    const idleDim = playing ? 1 : 0.4;
    parts.core.material.emissiveIntensity =
      (0.35 + level * 1.4) * idleDim + (hovered ? 0.3 : 0) + (held ? 0.4 : 0);
    parts.glow.material.opacity = (0.12 + level * 0.3) * idleDim + (hovered ? 0.1 : 0);

    if (!held) {
      root.scale.setScalar(1 + level * 0.06);
      return;
    }
    if (!playing) return;

    // Pull apart: compare hand spread now to where the two-hand grab began.
    const spread = this.leftHand.distanceTo(this.rightHand);
    if (this.pullBaseline === null) {
      if (leftNear && rightNear) this.pullBaseline = spread;
    } else if (spread - this.pullBaseline > SPLIT_PULL_METERS) {
      this.split();
      return;
    }
    if (root.scale.x >= SPLIT_SCALE) this.split();
  }

  private updateOrbs(delta: number): void {
    const follow = 1 - Math.exp(-delta * 8);
    const merging = this.mergeTimer > 0;
    const sp = this.state.spherePosition;
    let heldStem: StemId | null = null;

    for (const entity of this.queries.orbs.entities) {
      const stem = entity.getValue(StemOrb, 'stem') as StemId;
      const s = this.state.stems[stem];
      const root = entity.object3D!;
      const visual = root.userData.visual as OrbVisual;
      const held = entity.hasComponent(Grabbed);

      if (held) {
        heldStem = stem;
        // Hands write the mix state.
        root.getWorldPosition(this.v1);
        s.position[0] = this.v1.x;
        s.position[1] = this.v1.y;
        s.position[2] = this.v1.z;
      } else {
        // Visuals read the mix state (this also animates split, chips and merge).
        if (merging) this.v2.set(sp[0], sp[1], sp[2]);
        else this.v2.set(s.position[0], s.position[1], s.position[2]);
        root.position.lerp(this.v2, merging ? 1 - Math.exp(-delta * 12) : follow);
      }

      root.getWorldPosition(this.v1);
      this.engine.setStemPosition(stem, this.v1.x, this.v1.y, this.v1.z);

      // Tab floats below its orb, facing the user.
      const record = this.orbRecords.get(stem);
      if (record) {
        const tabRoot = record.tab.parts.root;
        tabRoot.position.set(this.v1.x, this.v1.y - TAB_DROP, this.v1.z);
        this.faceHead(tabRoot);
        const waveRoot = record.wave.root;
        waveRoot.position.set(this.v1.x, this.v1.y + ORB_WAVE_RISE, this.v1.z);
        waveRoot.visible = !merging;
        this.faceHead(waveRoot);
      }

      const near =
        Math.min(this.leftHand.distanceTo(this.v1), this.rightHand.distanceTo(this.v1)) <
        ORB_RADIUS + HOVER_RANGE;
      visual.pulse = Math.max(0, visual.pulse - delta * 2.5);

      const audible = isStemAudible(this.state, stem);
      const level = this.engine.getLevel(stem);
      const { core, glow } = visual.parts;
      const shade = audible ? 0.45 + 0.55 * s.filter : 0.08;
      // Muted stems lose their color; darker filter settings deepen it.
      core.material.color.copy(visual.parts.baseColor);
      if (!audible) core.material.color.lerp(MUTED_GRAY, 0.85);
      else core.material.color.multiplyScalar(0.55 + 0.45 * s.filter);
      core.material.emissiveIntensity =
        (0.4 + level * 2) * shade + (near ? 0.4 : 0) + (held ? 0.6 : 0);
      glow.material.opacity =
        (audible ? 0.12 + level * 0.35 + s.echo * 0.25 : 0.03) + (near ? 0.12 : 0) + (held ? 0.15 : 0);

      const base = audible ? 1 : 0.8;
      const target =
        merging ? 0.4 : base * (held ? 1.15 : near ? 1.06 : 1) + visual.pulse * 0.25 + level * 0.08;
      const s0 = root.scale.x;
      root.scale.setScalar(s0 + (target - s0) * Math.min(1, delta * 12));
    }

    if (merging) {
      this.mergeTimer -= delta;
      if (this.mergeTimer <= 0) this.finishMerge();
      return;
    }

    // Recombine: hold a grabbed orb pushed into another one.
    let touching: StemId | null = null;
    if (heldStem) {
      const held = this.state.stems[heldStem].position;
      for (const id of this.orbRecords.keys()) {
        if (id === heldStem) continue;
        const p = this.state.stems[id].position;
        if (Math.hypot(p[0] - held[0], p[1] - held[1], p[2] - held[2]) < FUSE_DISTANCE) {
          touching = id;
          break;
        }
      }
    }
    if (!touching || !heldStem) {
      this.fuseTimer = 0;
      return;
    }
    this.fuseTimer += delta;
    // Warn with a growing pulse on the orb about to absorb it.
    const target = this.orbRecords.get(touching)?.orb.object3D;
    if (target) (target.userData.visual as OrbVisual).pulse = Math.min(1, this.fuseTimer / FUSE_HOLD_SECONDS);
    if (this.fuseTimer >= FUSE_HOLD_SECONDS) {
      // Save the pushed orb where it came from, not on top of its neighbor.
      const start = this.grabStart;
      if (start && start.stem === heldStem) {
        this.state.stems[heldStem].position = start.position;
        this.state.stems[heldStem].slot = start.slot;
      }
      this.fuseTimer = 0;
      this.mixDown();
    }
  }

  private updateButtons(delta: number): void {
    for (const entity of this.queries.buttons.entities) {
      const root = entity.object3D!;
      if (!root.visible) continue;
      const button = root.userData.button as Button | undefined;
      if (!button) continue;
      const hovered = entity.hasComponent(Hovered);
      const pressed = entity.hasComponent(Pressed);
      // Keys travel in when pressed and rest slightly in when on.
      const travel = pressed ? 0.007 : button.parts.active ? 0.004 : 0;
      const userData = root.userData as { travel?: number };
      const t0 = userData.travel ?? 0;
      const t1 = t0 + (travel - t0) * Math.min(1, delta * 20);
      userData.travel = t1;
      button.parts.setTravel(t1);
      const target = hovered && !pressed ? 1.04 : 1;
      const s0 = root.scale.x;
      root.scale.setScalar(s0 + (target - s0) * Math.min(1, delta * 15));
      button.parts.body.material.emissiveIntensity = pressed ? 0.35 : hovered ? 0.22 : 0.05;
    }
  }
}
