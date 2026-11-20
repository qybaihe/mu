/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The monitor's hidden-positions list: what a position card's hide action
 * writes, and the restore entry's one-click recovery. localStorage is the
 * store; the parse is pure and tolerant.
 */
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  hidePosition,
  parseHiddenPositions,
  resetHiddenPositionsForTest,
  restoreHiddenPositions,
  useHiddenPositions,
} from '@renderer/pages/monitor/hiddenPositions';

describe('parseHiddenPositions', () => {
  it('keeps unique non-empty strings, drops everything else', () => {
    expect(parseHiddenPositions('["a","b","a",""]')).toEqual(['a', 'b']);
    expect(parseHiddenPositions('[]')).toEqual([]);
    expect(parseHiddenPositions('not json')).toEqual([]);
    expect(parseHiddenPositions('{"a":1}')).toEqual([]);
    expect(parseHiddenPositions('[1,null,{"x":"a"}]')).toEqual([]);
  });
});

describe('the hidden list store', () => {
  beforeEach(() => {
    localStorage.clear();
    resetHiddenPositionsForTest();
  });
  afterEach(() => {
    localStorage.clear();
    resetHiddenPositionsForTest();
    cleanup();
  });

  it('hides a position, persists it, and the hook sees it live', async () => {
    const { result } = renderHook(() => useHiddenPositions());
    expect(result.current.size).toBe(0);
    hidePosition('forwarder');
    await waitFor(() => expect(result.current.has('forwarder')).toBe(true));
    expect(JSON.parse(localStorage.getItem('monitor-hidden-positions') ?? '[]')).toEqual(['forwarder']);
    // A second hide of another name keeps the first.
    hidePosition('video-lab');
    await waitFor(() => expect(result.current.size).toBe(2));
  });

  it('restores everything at once', async () => {
    hidePosition('forwarder');
    hidePosition('video-lab');
    const { result } = renderHook(() => useHiddenPositions());
    await waitFor(() => expect(result.current.size).toBe(2));
    restoreHiddenPositions();
    await waitFor(() => expect(result.current.size).toBe(0));
    expect(localStorage.getItem('monitor-hidden-positions')).toBe('[]');
  });
});
