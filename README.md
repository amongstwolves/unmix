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

## How it works

- `src/mix-state.ts`: the mix state, the single source of truth. Hands write it;
  audio and visuals read it. It is plain JSON, so a saved mix is a snapshot.
- `src/audio-engine.ts`: Web Audio graph per stem (source → low-pass → echo send →
  gain → HRTF panner → master). All four stems start on the same AudioContext time.
- `src/unmix-system.ts`: the song sphere, the split, the orbs and the buttons.
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

4. For now the app loads one track: set `DEFAULT_TRACK` in
   `src/unmix-system.ts` to your track id. A track shelf comes later.

A stem file that fails to load is replaced by a placeholder tone and a warning
appears in the console, so a typo never silences the demo. The `placeholder`
track (`"placeholder": true`) generates all four stems in the browser.

## Credits

- Placeholder loop: generated in code, CC0.
