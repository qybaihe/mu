/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's position roster as it stands in the Sider: the rows the library
 * defines, the fold that persists, the header's create-wizard button — kept
 * even when the library is empty, an empty roster being exactly when the
 * wizard matters — and a row's click asking the open flow to start (or reuse)
 * that position's conversation. The data parsing and the open flow itself
 * live in their own tests; this is the section between them.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const openPosition = vi.fn();
const openSupervisor = vi.fn();
let positions: Array<{ name: string; displayName: string; description: string; projectRoot?: string; body: string }> =
  [];

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/pages/positions/usePositionRoster', () => ({
  usePositionRoster: () => ({ positions, isLoading: false }),
}));
vi.mock('@renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: [] }),
}));
vi.mock('@renderer/hooks/assistant/useAssistantList', () => ({
  useAssistantList: () => ({ assistants: [], assistantOrder: undefined, activeAssistantId: null }),
}));
vi.mock('@renderer/pages/positions/openPosition', () => ({
  useOpenPosition: () => openPosition,
}));
vi.mock('@renderer/pages/positions/openSupervisor', () => ({
  useOpenSupervisor: () => openSupervisor,
}));
// The wizard modal has its own test; here it stands as a stub so the section
// under test renders without the theme provider it would pull in.
vi.mock('@renderer/pages/positions/PositionCreationModal', () => ({
  default: () => null,
}));
import SiderPositionsGroup from '@renderer/components/layout/Sider/SiderNav/SiderPositionsGroup';

const row = (name: string) => screen.getByTestId(`sider-position-${name}`);

describe('SiderPositionsGroup', () => {
  beforeEach(() => {
    openPosition.mockClear();
    openSupervisor.mockClear();
    positions = [
      {
        name: 'forwarder',
        displayName: '货代',
        description: '货代岗',
        projectRoot: 'E:/Projects/forwarder',
        body: 'x',
      },
      { name: 'video-lab', displayName: 'video-lab', description: '视频岗', body: 'y' },
    ];
    localStorage.removeItem('sider-positions-folded');
  });
  afterEach(() => cleanup());

  it('shows the library’s rows, in the library’s order, under their display names', () => {
    render(<SiderPositionsGroup />);
    expect(screen.getByTestId('sider-positions')).toBeInTheDocument();
    expect(['货代', 'video-lab']).toEqual([row('forwarder'), row('video-lab')].map((r) => r.textContent?.trim()));
  });

  it('keeps the section header with its create button when the library is empty', () => {
    positions = [];
    render(<SiderPositionsGroup />);
    expect(screen.getByTestId('sider-positions')).toBeDefined();
    expect(screen.getByTestId('sider-positions-create')).toBeDefined();
    expect(screen.getByTestId('sider-positions-empty')).toBeDefined();
    expect(screen.queryByTestId('sider-position-forwarder')).toBeNull();
  });

  it('fixes the supervisor row at the top, above the library’s rows', () => {
    render(<SiderPositionsGroup />);
    const supervisor = screen.getByTestId('sider-position-supervisor');
    expect(supervisor.textContent?.trim()).toBe('supervisor.title');
    expect(supervisor.parentElement?.firstElementChild).toBe(supervisor);
    expect(supervisor.nextElementSibling).toBe(row('forwarder'));
  });

  it('opens the supervisor’s conversation on its row click', async () => {
    const user = userEvent.setup();
    render(<SiderPositionsGroup />);
    await user.click(screen.getByTestId('sider-position-supervisor'));
    expect(openSupervisor).toHaveBeenCalledTimes(1);
    expect(openPosition).not.toHaveBeenCalled();
  });

  it('opens the position’s conversation on a row click, and folds and unfolds on the label', async () => {
    const user = userEvent.setup();
    render(<SiderPositionsGroup />);
    await user.click(row('forwarder'));
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ name: 'forwarder' }));

    fireEvent.click(screen.getByRole('button', { name: 'positions.title' }));
    expect(screen.queryByTestId('sider-position-forwarder')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sider-position-supervisor')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'positions.title' }));
    expect(row('forwarder')).toBeInTheDocument();
    // The fold persists.
    expect(localStorage.getItem('sider-positions-folded')).toBe('0');
  });

  it('presses a row with Enter or Space, as a click would', async () => {
    const user = userEvent.setup();
    render(<SiderPositionsGroup />);
    row('video-lab').focus();
    await user.keyboard('{Enter}');
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ name: 'video-lab' }));
  });

  it('lists every position of the roster beside the supervisor row — the delete quarantine lives in the library, not a filter here', async () => {
    const user = userEvent.setup();
    render(<SiderPositionsGroup />);
    expect(screen.getByTestId('sider-position-supervisor')).toBeInTheDocument();
    expect(row('forwarder')).toBeInTheDocument();
    expect(row('video-lab')).toBeInTheDocument();
    await user.click(row('forwarder'));
    expect(openPosition).toHaveBeenCalledWith(expect.objectContaining({ name: 'forwarder' }));
  });
});
