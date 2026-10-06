/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The work panel's tab strip in a panel too narrow for its labels (eight tabs in the 279px a 900px window leaves):
 * one icon per tab, each named by its tooltip and for screen readers, and the labels back once they fit again. The
 * strip never keeps tabs out of sight behind a sideways scroll.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import WorkPanelTabs from '@/renderer/components/layout/WorkPanel/WorkPanelTabs';
import { WORK_PANEL_TABS, type WorkPanelTab } from '@/renderer/components/layout/WorkPanel/workPanelStore';

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({ lng: 'en', resources: { en: { translation: { common } } }, interpolation: { escapeValue: false } });
});

/** The strip's width and what its labels take; an icon takes 26px. jsdom lays nothing out, so the test does. */
const layout = { room: 400, labels: 380 };
const ICON_PX = 26;
let resized: (() => void)[] = [];

class RecordingResizeObserver {
  constructor(callback: () => void) {
    resized.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const strip = () => screen.getByRole('tablist');
const tabs = () => screen.getAllByRole('tab');
const labels = WORK_PANEL_TABS.map((tab) => common.workPanel.tabs[tab]);
const shown = () => tabs().map((tab) => tab.getAttribute('data-tab'));
/** The tabs listed under 更多, once it is opened. */
const moreTabs = () => screen.queryAllByTestId('work-panel-more-tab').map((item) => item.getAttribute('data-tab'));
const moreTab = (tab: WorkPanelTab) =>
  screen.getAllByTestId('work-panel-more-tab').find((item) => item.getAttribute('data-tab') === tab) as HTMLElement;

function show(
  unread: WorkPanelTab[] = [],
  {
    used,
    active = 'judge',
    onSelect = () => {},
  }: { used?: WorkPanelTab[]; active?: WorkPanelTab; onSelect?: (tab: WorkPanelTab) => void } = {}
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <WorkPanelTabs
        active={active}
        unread={new Set(unread)}
        used={used ? new Set(used) : undefined}
        onSelect={onSelect}
        onClose={() => {}}
      />
    </I18nextProvider>
  );
}

/** The panel is dragged to a new width. */
function resize(room: number) {
  layout.room = room;
  act(() => {
    for (const callback of resized) callback();
  });
}

beforeEach(() => {
  resized = [];
  layout.room = 400;
  layout.labels = 380;
  vi.stubGlobal('ResizeObserver', RecordingResizeObserver);
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return this.getAttribute('role') === 'tablist' ? layout.room : 0;
  });
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') !== 'tablist') return 0;
    return this.getAttribute('data-icons') ? WORK_PANEL_TABS.length * ICON_PX : layout.labels;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the work panel tab strip', () => {
  it('shows the labels while they fit', () => {
    show();
    expect(tabs().map((tab) => tab.textContent)).toEqual(labels);
    expect(strip()).not.toHaveAttribute('data-icons');
  });

  it('shows one icon per tab, each still named, when the panel is too narrow for the labels', () => {
    // A 900px window: the labels need 298px, the strip has 236px.
    layout.labels = 298;
    layout.room = 236;
    show();
    expect(strip()).toHaveAttribute('data-icons', 'true');
    for (const tab of tabs()) {
      expect(tab.textContent).toBe('');
      expect(tab.querySelector('svg')).not.toBeNull();
    }
    expect(tabs().map((tab) => tab.getAttribute('aria-label'))).toEqual(labels);
    expect(screen.getByRole('tab', { selected: true })).toHaveAccessibleName(common.workPanel.tabs.judge);
    // Eight icons fit where the labels did not, even in the narrowest panel (228px for the tabs): nothing is left
    // out of view.
    expect(WORK_PANEL_TABS).toHaveLength(8);
    expect(WORK_PANEL_TABS.length * ICON_PX).toBeLessThanOrEqual(228);
  });

  it('names an icon in a tooltip on hover', async () => {
    vi.useFakeTimers();
    layout.labels = 298;
    layout.room = 236;
    show();
    fireEvent.mouseEnter(screen.getByRole('tab', { name: common.workPanel.tabs.hive }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByRole('tooltip')).toHaveTextContent(common.workPanel.tabs.hive);
  });

  it('keeps the news in an icon’s name', () => {
    layout.labels = 298;
    layout.room = 236;
    show(['board']);
    expect(screen.getByRole('tab', { name: `${common.workPanel.tabs.board}, new` })).toBeInTheDocument();
    expect(screen.getByTestId('work-panel-dot')).toBeInTheDocument();
  });

  it('goes to icons as the panel narrows, and back to the labels once it is wide enough for them again', () => {
    show();
    expect(strip()).not.toHaveAttribute('data-icons');
    resize(300);
    expect(strip()).toHaveAttribute('data-icons', 'true');
    // Wider, but still not wide enough for the labels.
    resize(360);
    expect(strip()).toHaveAttribute('data-icons', 'true');
    resize(380);
    expect(strip()).not.toHaveAttribute('data-icons');
    expect(tabs().map((tab) => tab.textContent)).toEqual(labels);
  });
});

describe('the tabs a conversation uses', () => {
  it('shows every tab, and no 更多, when it is not told which tabs were used', () => {
    show();
    expect(shown()).toEqual([...WORK_PANEL_TABS]);
    expect(screen.queryByTestId('work-panel-more')).not.toBeInTheDocument();
  });

  it('keeps board, judge and files in the strip, and lists the rest under 更多, where choosing one opens it', () => {
    const onSelect = vi.fn();
    show([], { used: [], onSelect });
    expect(shown()).toEqual(['board', 'judge', 'files']);
    expect(moreTabs()).toEqual([]);

    const more = screen.getByTestId('work-panel-more');
    expect(more).toHaveTextContent(common.more);
    fireEvent.click(more);
    expect(moreTabs()).toEqual(['hive', 'lessons', 'preview', 'source', 'browser']);
    fireEvent.click(moreTab('source'));
    expect(onSelect).toHaveBeenCalledWith('source');
  });

  it('puts the tabs the conversation used in the strip, in their order', () => {
    show([], { used: ['browser', 'hive'] });
    expect(shown()).toEqual(['board', 'judge', 'hive', 'files', 'browser']);
    fireEvent.click(screen.getByTestId('work-panel-more'));
    expect(moreTabs()).toEqual(['lessons', 'preview', 'source']);
  });

  it('brings a tab with news into the strip, dot and all', () => {
    show(['browser'], { used: [] });
    expect(shown()).toEqual(['board', 'judge', 'files', 'browser']);
    expect(screen.getByRole('tab', { name: `${common.workPanel.tabs.browser}, new` })).toBeInTheDocument();
  });

  it('shows the open tab even before it counts as used', () => {
    show([], { used: [], active: 'lessons' });
    expect(shown()).toEqual(['board', 'judge', 'lessons', 'files']);
  });

  it('leaves out 更多 once every tab is in the strip', () => {
    show([], { used: ['hive', 'lessons', 'preview', 'source', 'browser'] });
    expect(shown()).toEqual([...WORK_PANEL_TABS]);
    expect(screen.queryByTestId('work-panel-more')).not.toBeInTheDocument();
  });

  it('moves with the arrow keys between the tabs shown only', () => {
    const onSelect = vi.fn();
    show([], { used: ['browser'], active: 'files', onSelect });
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenLastCalledWith('browser');
    fireEvent.keyDown(screen.getByRole('tab', { selected: true }), { key: 'ArrowLeft' });
    expect(onSelect).toHaveBeenLastCalledWith('judge');
  });
});
