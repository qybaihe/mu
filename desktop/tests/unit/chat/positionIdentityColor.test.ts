/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The identity-colour derivations, as tests: the hue is a pure function of
 * the id (stable, in range, spread across the roster), the colour strings
 * stay in the narrow band that reads on both skins, and the built-in
 * supervisor reads its fixed emphasis red.
 */
import { describe, expect, it } from 'vitest';
import { SUPERVISOR_POSITION_NAME } from '@/common/chat/supervisor/supervisorCore';
import { positionHue, positionIdentityColor } from '@/common/chat/positions/positionIdentityColor';

const HSL = /^hsl\((\d+) (\d+)% (\d+)%\)$/;
const parts = (color: string): { h: number; s: number; l: number } => {
  const match = HSL.exec(color);
  expect(match, `not an hsl triple: ${color}`).not.toBeNull();
  return { h: Number(match![1]), s: Number(match![2]), l: Number(match![3]) };
};

describe('positionHue', () => {
  it('hashes the same id to the same hue, different ids usually apart', () => {
    expect(positionHue('forwarder')).toBe(positionHue('forwarder'));
    // Twelve roster-shaped ids stay well spread: at least 9 distinct hues.
    const ids = [
      'forwarder',
      'reviewer',
      'ops',
      'sales',
      'finance',
      'hr',
      'legal',
      'dev',
      'qa',
      'data',
      'pm',
      'support',
    ];
    const hues = new Set(ids.map((id) => positionHue(id)));
    expect(hues.size).toBeGreaterThanOrEqual(9);
  });

  it('folds every id into 0-359', () => {
    for (const id of ['', 'a', '货代', 'very-long-position-identifier-with-unicode-中文']) {
      const hue = positionHue(id);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe('positionIdentityColor', () => {
  it('derives the same colour for the same id, every call', () => {
    expect(positionIdentityColor('forwarder')).toEqual(positionIdentityColor('forwarder'));
  });

  it('keeps the fill in the narrow mid-tone band and the text dark on it', () => {
    const { background, foreground } = positionIdentityColor('ops');
    const fill = parts(background);
    expect(fill.s).toBeGreaterThanOrEqual(45);
    expect(fill.s).toBeLessThanOrEqual(55);
    expect(fill.l).toBeGreaterThanOrEqual(55);
    expect(fill.l).toBeLessThanOrEqual(65);
    // The same hue, dark enough to keep avatar initials readable on the fill.
    const text = parts(foreground);
    expect(text.h).toBe(fill.h);
    expect(text.l).toBeLessThanOrEqual(20);
  });

  it('gives the built-in supervisor its fixed red, hue 0', () => {
    expect(parts(positionIdentityColor(SUPERVISOR_POSITION_NAME).background).h).toBe(0);
    // An ordinary id may also hash to another hue, but supervisor is fixed.
    expect(positionIdentityColor(SUPERVISOR_POSITION_NAME)).toEqual(positionIdentityColor('supervisor'));
  });
});
