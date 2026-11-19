/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The sidebar's monitor entry: a row above the group-chat section, badged
 * with the live count, gone when there is nothing to monitor, one click to
 * the page.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TeamWall } from '@renderer/pages/monitor/monitorCore';
import type { MonitorOverview } from '@renderer/pages/monitor/useMonitorOverview';

let overview: MonitorOverview;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params === undefined
        ? key
        : `${key}:${Object.entries(params)
            .map(([name, value]) => `${name}=${value}`)
            .join(',')}`,
  }),
}));
vi.mock('@renderer/pages/monitor/useMonitorOverview', () => ({
  useMonitorOverview: () => overview,
}));
import SiderMonitorEntry from '@renderer/components/layout/Sider/SiderNav/SiderMonitorEntry';

const Where: React.FC = () => {
  const location = useLocation();
  return <div data-testid='where'>{location.pathname}</div>;
};

const renderEntry = () =>
  render(
    <MemoryRouter initialEntries={['/guid']}>
      <Routes>
        <Route
          path='*'
          element={
            <>
              <SiderMonitorEntry />
              <Where />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );

describe('SiderMonitorEntry', () => {
  beforeEach(() => {
    overview = {
      positionCards: [],
      teamWall: { active: [], retired: [] } satisfies TeamWall,
      activeCount: 0,
      positionCount: 1,
      activeTeamCount: 0,
      loading: false,
    };
  });
  afterEach(cleanup);

  it('renders with the live badge when work is mid-flight, and navigates on click', () => {
    overview = { ...overview, activeCount: 3 };
    renderEntry();
    expect(screen.getByTestId('sider-monitor')).toBeTruthy();
    expect(screen.getByTestId('sider-monitor-badge').textContent).toBe('3');
    fireEvent.click(screen.getByTestId('sider-monitor'));
    expect(screen.getByTestId('where').textContent).toBe('/monitor');
  });

  it('no badge when nothing runs, no row when there is nothing to monitor at all', () => {
    renderEntry();
    expect(screen.queryByTestId('sider-monitor-badge')).toBeNull();
    cleanup();
    overview = { ...overview, positionCount: 0 };
    renderEntry();
    expect(screen.queryByTestId('sider-monitor')).toBeNull();
  });
});
