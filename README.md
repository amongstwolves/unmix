# Unmix

Pull a song apart with your bare hands. Place each part in the room around you.
Remix by moving sound through space.

A hands-first WebXR stem player built on Meta's Immersive Web SDK (IWSDK) for the
Meta VR Start Developer Competition 2026.

## Run it

Needs Node.js 20.19+ and Chrome.

```sh
npm install
npm run dev
```

`npm run dev` opens a managed Chrome window with IWER, the IWSDK browser emulator
for a Quest 3 (headset, controllers and hands), so no headset is needed.

## Using it

1. Poke a record tile to load a song into the sphere.
2. Grab the sphere with both hands and pull them apart (or poke **Split**).
3. Grab an orb to move a stem around you. Where it is, is where you hear it.
4. Grab an orb, or poke the name tab under it, to open that stem's panel:
   Mute, Solo, Echo, Darker, Brighter, Pitch/speed − and + (pitch also changes
   speed; one stem at a time). Poke **Done** or the tab again to close it.
5. With no stem selected, poke **Ask producer** for three ideas. Poke one to
   hear it, then Keep or Undo.
6. Poke **Record** (it sits at a free spot on the orb arc) to add your own
   sound: a count-in, then two bars from your microphone, looped in time with
   the song as a fifth orb, **YOU**. **Re-record** replaces the take. The
   recording is kept for this track until you load another one.
7. Hold one orb pushed into another for a moment (or poke **Mix down**) to fuse
   them back into one song. The mix is saved ("Mix saved"); **Saved mix**
   brings it back.

The strip above the orbs shows the whole track, one lane per stem, with a
playhead per lane. Each orb carries its own small waveform.

## Design

Inspired by hardware stem players, not copied from them. Less, but better:
only what you are doing right now is shown (the stem panel appears for a
selected stem; producer ideas appear when asked for). Color means something:
the stem colors are the only accents, and controls are warm neutral keys
that travel in when pressed and rest pressed-in when on. State is shown by the
objects themselves: a muted orb loses its color, a darker one deepens.

## How it works

- `src/mix-state.ts`: the mix state, the single source of truth. Hands write it;
  audio and visuals read it. It is plain JSON, so a saved mix is a snapshot.
- `src/audio-engine.ts`: Web Audio graph per stem (source → low-pass → echo send →
  gain → HRTF panner → master). All four stems start on the same AudioContext time.
- `src/unmix-system.ts`: the song sphere, the split, the orbs, the buttons, the
  producer chips, recombine and the saved mix.
- `src/mix-actions.ts`: every allowed change to the mix, shared by buttons and
  the producer, plus validation of producer suggestions.
- `src/waveform.ts`: the full-track strip and per-orb waveforms.
- `src/recorder.ts`: records a loop from the microphone in an AudioWorklet,
  lined up to the bar grid and corrected for audio latency. Add `?fakemic` to
  the URL (or set localStorage `unmix.fakemic` to `1`) to test with a generated
  signal instead of a microphone.
- `src/layout.ts`: where things sit around a seated user (30–60 cm, chest to eye
  height, 8 arc slots for orbs).
- `src/tracks.ts` and `src/placeholder-stems.ts`: track loading, plus generated
  placeholder stems.

## Add a track

1. Split the song into 4 stems offline with Demucs (htdemucs, 44.1 kHz):

   ```sh
   demucs -n htdemucs --mp3 "my-song.wav"
   ```

   You get `vocals`, `drums`, `bass` and `other`. Check that they line up and sum
   back to the original.

2. Make a folder `public/tracks/<track-id>/` (lowercase, dashes, for example
   `night-drive`) and copy the four stems into it. Compressed audio (`.mp3`, `.ogg`
   or `.m4a`) keeps the download small. All four must be the same length.

3. Add `public/tracks/<track-id>/track.json`:

   ```json
   {
     "id": "night-drive",
     "title": "Night Drive",
     "artist": "Artist Name",
     "license": "CC-BY-4.0",
     "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
     "bpm": 96,
     "key": "F minor",
     "stems": {
       "vocals": "vocals.mp3",
       "drums": "drums.mp3",
       "bass": "bass.mp3",
       "other": "other.mp3"
     },
     "sections": [
       { "id": "intro", "label": "Intro", "start": 0, "end": 12.5 },
       { "id": "chorus", "label": "Chorus", "start": 12.5, "end": 37.5 }
     ]
   }
   ```

   Section times are seconds from the start of the stems. Only use music whose
   license allows modification, or your own recordings.

4. Add the track id to `public/tracks/index.json` (shelf order, left to right):

   ```json
   { "tracks": ["night-drive", "placeholder"] }
   ```

   Remove `placeholder` once you have real tracks.

5. Optional but recommended: `public/tracks/<track-id>/suggestions.json` with 6
   producer ideas. The chips show three at a time. Each one must follow the AI
   producer contract (at most 6 words per label, one sentence per `why`, only
   allowed actions); invalid entries are skipped.

   ```json
   [
     {
       "label": "Strip it to bass and voice",
       "why": "Taking out drums and pads shows how the bass and vocal fit.",
       "actions": [
         { "type": "mute", "stem": "drums" },
         { "type": "mute", "stem": "other" }
       ]
     }
   ]
   ```

   Action types: `move` (stem, slot 0-7, left to right), `setVolume`,
   `setFilter`, `setEcho` (stem, value 0-1), `setPitch` (stem, value -12..12),
   `mute`, `solo`, `halfTime` (stem), `loopSection` (sectionId from track.json).

A stem file that fails to load is replaced by a placeholder tone and a warning
appears in the console, so a typo never silences the demo. The `placeholder`
track (`"placeholder": true`) generates all four stems in the browser.

## Credits

- Placeholder loop: generated in code, CC0.

## Ideas for a future version

Not planned for the competition build; kept here so they are not lost.

- **Hardware synths and controllers (e.g. the M-VAVE FM-1).** Today a synth can
  already join the mix by playing it into **Record**. Later: Web MIDI so a
  controller's knobs set stem volume or filter alongside your hands; MIDI clock
  out so a hardware sequencer plays in time with the song; USB audio in for a
  cleaner take than the microphone. First check that the Quest browser supports
  Web MIDI (a small test page on the headset), since that is unconfirmed.
- **Live AI producer.** A small relay (Cloudflare Worker) holding the API key,
  asking a model for three suggestions in the same validated format as
  `suggestions.json`, falling back to the precomputed ones.
- **Pinch-drag shaping gestures** for the filter ring, pitch handle and echo
  tail, on top of the existing poke buttons.
- **Upload your own sound** from the page before entering XR, as a fifth orb.
