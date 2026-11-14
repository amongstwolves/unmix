/**
 * Where things go around a seated user. Everything is measured from the head
 * at anchor time, so it works seated or standing and in the emulator.
 *
 * Reach rules: targets 30-60 cm from the head, between chest and eye height,
 * nothing behind or above, at least 6 cm between target edges.
 */

import { Vector3 } from '@iwsdk/core';
import type { Vec3Tuple } from './mix-state.js';

export const SLOT_COUNT = 8;
/** Arc radius from the head, in meters. */
const ARC_RADIUS = 0.5;
/** Arc spans this many degrees either side of straight ahead. */
const ARC_HALF_ANGLE_DEG = 70;
/** Slots sit this far below eye height (chest to eye range). */
const ARC_DROP = 0.15;

const SPHERE_DISTANCE = 0.42;
const SPHERE_DROP = 0.2;

export const ORB_RADIUS = 0.045; // 9 cm across
export const SPHERE_RADIUS = 0.1; // 20 cm across, big enough for two hands

export class Layout {
  /** Head position when anchored. */
  readonly head = new Vector3(0, 1.2, 0);
  /** Yaw of the user's forward direction (radians, 0 = -Z). */
  yaw = 0;

  anchor(headPosition: Vector3, headForward: Vector3): void {
    this.head.copy(headPosition);
    // Keep only the horizontal direction; ignore looking up or down.
    const fx = headForward.x;
    const fz = headForward.z;
    if (Math.abs(fx) + Math.abs(fz) > 1e-4) this.yaw = Math.atan2(-fx, -fz);
  }

  /** Point at a horizontal angle (0 = straight ahead, + = right). */
  private around(angle: number, distance: number, drop: number, out: Vector3): Vector3 {
    const a = this.yaw - angle;
    out.set(
      this.head.x - Math.sin(a) * distance,
      this.head.y - drop,
      this.head.z - Math.cos(a) * distance,
    );
    return out;
  }

  spherePosition(out: Vector3): Vector3 {
    return this.around(0, SPHERE_DISTANCE, SPHERE_DROP, out);
  }

  /** The poke button row sits just below and in front of the sphere. */
  buttonPosition(index: number, count: number, out: Vector3): Vector3 {
    const spacing = 0.19; // 12 cm buttons with a 7 cm gap
    const offset = (index - (count - 1) / 2) * spacing;
    const angle = Math.atan2(offset, 0.36);
    return this.around(angle, Math.hypot(offset, 0.36), SPHERE_DROP + 0.17, out);
  }

  slotPosition(slot: number, out: Vector3): Vector3 {
    const t = slot / (SLOT_COUNT - 1);
    const angle = ((t * 2 - 1) * ARC_HALF_ANGLE_DEG * Math.PI) / 180;
    return this.around(angle, ARC_RADIUS, ARC_DROP, out);
  }

  slotTuple(slot: number): Vec3Tuple {
    const v = this.slotPosition(slot, new Vector3());
    return [v.x, v.y, v.z];
  }

  /** Nearest slot within `maxDistance` meters of a point, or null. */
  nearestSlot(point: Vector3, maxDistance: number, scratch: Vector3): number | null {
    let best: number | null = null;
    let bestDistance = maxDistance;
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const d = this.slotPosition(slot, scratch).distanceTo(point);
      if (d < bestDistance) {
        bestDistance = d;
        best = slot;
      }
    }
    return best;
  }
}
