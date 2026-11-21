/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One ⚡ steward row: the marker names the action, the receipt line under
 * it, and the numbers behind the call one click away. i18n is mocked to the
 * key with interpolations inlined, so the assertions read the composed
 * strings.
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContextStewardNote } from '@renderer/pages/team/core/notes/contextStewardNotes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params === undefined) return key;
      return `${key}:${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`;
    },
  }),
}));
import ContextStewardRow from '@renderer/pages/team/components/ContextStewardRow';

afterEach(cleanup);

const compactNote: ContextStewardNote = {
  id: 'n1',
  conversationId: 'c1',
  createdAt: 1,
  kind: 'compact',
  reason: '已收尾',
  tokens: 160_000,
  contextWindow: 200_000,
  percent: 0.8,
};

const switchNote: ContextStewardNote = {
  ...compactNote,
  kind: 'switch',
  reason: '任务进行中',
  part: 1,
  oldTitle: '货代 (part 1)',
  newTitle: '货代',
  counterpartId: 'c2',
};

const continuationNote: ContextStewardNote = {
  ...compactNote,
  kind: 'continuation',
  part: 1,
  oldTitle: '货代 (part 1)',
  newTitle: '货代',
  counterpartId: 'c1',
};

describe('ContextStewardRow', () => {
  it('renders the compact marker with its reason and the numbers behind it', async () => {
    render(<ContextStewardRow note={compactNote} />);
    expect(screen.getByTestId('context-steward-title').textContent).toBe('contextSteward.compact.title');
    expect(screen.getByTestId('context-steward-body').textContent).toBe('contextSteward.compact.body:reason=已收尾');
    await userEvent.click(screen.getByTestId('context-steward-basis-trigger'));
    expect(screen.getByTestId('context-steward-basis').textContent).toContain('160000 / 200000 (80%)');
  });

  it('renders the switch marker with the part number and the part the work moved to', async () => {
    render(<ContextStewardRow note={switchNote} />);
    expect(screen.getByTestId('context-steward-title').textContent).toBe('contextSteward.switch.title:part=1');
    expect(screen.getByTestId('context-steward-body').textContent).toBe(
      'contextSteward.switch.body:reason=任务进行中,target=货代'
    );
    await userEvent.click(screen.getByTestId('context-steward-basis-trigger'));
    expect(screen.getByTestId('context-steward-basis').textContent).toContain('contextSteward.details.part:part=1');
  });

  it('renders the continuation row a new part opens with, naming where it came from', () => {
    render(<ContextStewardRow note={continuationNote} />);
    expect(screen.getByTestId('context-steward-title').textContent).toBe('contextSteward.continuation.title:part=1');
    expect(screen.getByTestId('context-steward-body').textContent).toBe(
      'contextSteward.continuation.body:source=货代 (part 1)'
    );
  });
});
