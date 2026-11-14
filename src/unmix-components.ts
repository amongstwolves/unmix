/**
 * ECS components for Unmix. System-free on purpose: systems import these,
 * never the other way round.
 */

import { createComponent, Types } from '@iwsdk/core';

/** A stem orb. `stem` is one of vocals, drums, bass, other. */
export const StemOrb = createComponent('StemOrb', {
  stem: { type: Types.String, default: 'vocals' },
});

/** The whole-song sphere that splits into stem orbs. */
export const SongSphere = createComponent('SongSphere', {});

/** A poke button. `action` names what pressing it does. */
export const PokeButton = createComponent('PokeButton', {
  action: { type: Types.String, default: '' },
});
