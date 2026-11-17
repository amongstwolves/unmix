# Unmix

Pull a song apart with your bare hands. Place each part in the room around you.
Remix by moving sound through space.

A hands-first WebXR stem player built on Meta's Immersive Web SDK (IWSDK) for the
Meta VR Start Developer Competition 2026. Not affiliated with Teenage Engineering.

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
4. Grab an orb or poke the name tab under it to select that stem, then use the
   panel: Mute, Solo, Darker, Brighter, Echo, Pitch − / + (pitch also changes
   speed; one stem at a time).
5. Poke a producer chip to try an idea, then Keep or Undo.
6. Poke **Record** (it sits at a free spot on the orb arc) to add your own
   sound: you hear a count-in, then it records two bars from your microphone
   and loops them in time with the song as a fifth orb, **YOU**. Poke
   **Re-record** to replace the take. The recording is kept for this track
   until you load another one.
7. Hold one orb pushed into another for a moment (or poke **Mix down**) to fuse
   them back into one song. This saves the mix; **Saved mix** brings it back.

The strip above the chips shows the whole track, one lane per stem, with a
playhead per lane. Each orb carries its own small waveform.

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
