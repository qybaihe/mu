/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A position's identity colour: a stable hue derived purely from the
 * position's frontmatter `name` — zero storage, zero schema, the same
 * position reading the same colour on every surface (the sidebar's roster
 * rows, the monitor's position cards, a team's member avatars). Identity
 * only: the working/waiting state colours keep their own semantics and are
 * never derived from here.
 */
import { SUPERVISOR_POSITION_NAME } from '@/common/chat/supervisor/supervisorCore';

/**
 * The identity hue of an id: FNV-1a over its code units, folded to 0-359.
 * Pure and stable — the same id always hashes to the same hue; collisions
 * between different ids are acceptable (the roster is small and the spread
 * is wide enough).
 */
export const positionHue = (id: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
};

/** The identity colour of one position, as CSS colour strings. */
export type PositionIdentityColor = {
  /** The solid fill for bars, dots and avatar backgrounds. */
  background: string;
  /**
   * Text on the background: the same hue near-black, so an initial stays
   * readable on the fill in both the light and the dark theme (≥ 5:1).
   */
  foreground: string;
};

/**
 * The saturation and lightness band every identity fill stays in: mid-toned
 * enough to read on light fills and on the monitor's dark lamel cards, never
 * neon. Fixed constants, not per-caller choices, so all surfaces agree.
 */
const SATURATION = 48; // of the 45-55 band
const LIGHTNESS = 58; // of the 55-65 band
/** Avatar-text lightness: dark enough for contrast on the fill above. */
const TEXT_LIGHTNESS = 15;

/** The identity colour of a position id; the built-in supervisor reads red. */
export const positionIdentityColor = (id: string): PositionIdentityColor => {
  const hue = id === SUPERVISOR_POSITION_NAME ? 0 : positionHue(id);
  return {
    background: `hsl(${hue} ${SATURATION}% ${LIGHTNESS}%)`,
    foreground: `hsl(${hue} ${SATURATION}% ${TEXT_LIGHTNESS}%)`,
  };
};
