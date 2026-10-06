/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The settings rail is six groups of short pages with a search over all of them, and every place that used to be a
 * page of its own still leads to the page that holds its settings now. Both halves are tested here: the rail a person
 * sees, and the redirects the router installs for the retired paths and for the tabs that became pages.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { defaultFeatureState, parseManifest } from '@/common/kyrn/manifest';
import manifestJson from '../kyrn/settings/manifest.fixture.json';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({
  useExtensionSettingsTabs: () => extensionTabs,
}));

vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url?: string) => url,
}));

// The rail's search reads the harness's manifest from the settings once something is typed.
const readSettings = vi.hoisted(() => vi.fn());
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { settings: { invoke: readSettings } },
  unwrap: (result: { ok: boolean; data?: unknown; error?: string }) => {
    if (!result.ok) throw new Error(result.error);
    return result.data;
  },
}));

// What the router module pulls in besides the redirects under test.
vi.mock('@/renderer/components/layout/AppLoader', () => ({ default: () => <span>Loading</span> }));
vi.mock('@/renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({ useCrossSessionRateLimitNotice: () => {} }));
vi.mock('@/renderer/pages/settings/KyrnSettings/StartupGate', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

let extensionTabs: { id: string; name: string; url: string; position?: unknown }[] = [];

import { RetiredSettingsPath, WithMovedTabs } from '@/renderer/components/layout/Router';
import SettingsSider, { BUILTIN_TAB_IDS } from '@/renderer/pages/settings/components/SettingsSider';
import {
  DETAIL_AREAS,
  FEATURE_LIST_PAGES,
  MOVED_FEATURE_LISTS,
  MOVED_SETTINGS_TABS,
  RETIRED_SETTINGS_PATHS,
  SETTINGS_ANCHOR_REMAP,
  SETTINGS_GROUPS,
  SETTINGS_HOME,
  SETTINGS_PAGES,
  isSettingsRouteActive,
  retiredSettingsTarget,
} from '@/renderer/pages/settings/settingsNav';

/** Where the router is now: path with query, and the navigation state that came along. */
function Here() {
  const { pathname, search, state } = useLocation();
  return <output data-testid='here' data-path={`${pathname}${search}`} data-state={JSON.stringify(state ?? null)} />;
}

const here = () => screen.getByTestId('here');

function renderRail(path = '/settings/providers') {
  return render(
    // A cache of its own for each rail: the manifest the search read is not carried into the next test.
    <SWRConfig value={{ provider: () => new Map() }}>
      <MemoryRouter initialEntries={[path]}>
        <SettingsSider />
        <Here />
      </MemoryRouter>
    </SWRConfig>
  );
}

const railRows = (root: ParentNode) =>
  [...root.querySelectorAll('[data-settings-id]')].map((row) => row.getAttribute('data-settings-id'));

const groupRows = (container: HTMLElement) =>
  Object.fromEntries(
    [...container.querySelectorAll('[data-settings-group]')].map((group) => [
      group.getAttribute('data-settings-group'),
      railRows(group),
    ])
  );

describe('the settings rail', () => {
  beforeEach(() => {
    extensionTabs = [];
  });
  afterEach(() => cleanup());

  it('shows six groups under muted headers, each with its pages in order', () => {
    const { container } = renderRail();
    const groups = [...container.querySelectorAll('[data-settings-group]')];
    expect(groups.map((group) => group.getAttribute('data-settings-group'))).toEqual([
      'preferences',
      'models',
      'kernel',
      'details',
      'capabilities',
      'system',
    ]);
    // A header is a label, not a row: it names the group and cannot be clicked.
    expect(groups.map((group) => group.querySelector('.settings-sider__group-header')?.textContent)).toEqual(
      SETTINGS_GROUPS.map((group) => group.labelKey)
    );
    expect(screen.getByRole('group', { name: 'settings.groups.kernel' })).toBeInTheDocument();
    expect(groupRows(container)).toEqual({
      preferences: ['appearance', 'system', 'conversations'],
      models: ['providers', 'default-model', 'board-model'],
      kernel: ['judges', 'judge-order', 'features'],
      // The decision points and the other features are one list: each feature with its points under it, by area.
      details: [
        'details-input',
        'details-context',
        'details-memory',
        'details-tools',
        'details-safety',
        'details-turn',
        'details-goal',
        'details-team',
        'details-other',
      ],
      capabilities: ['skills', 'tools', 'assistants', 'browser'],
      system: ['archived', 'developer', 'about'],
    });
    expect(BUILTIN_TAB_IDS).toEqual(railRows(container));
    // No page of decision points or of more features is left, no web server page, no collapsed "advanced" entry.
    expect(container.querySelector('[data-settings-id^="decisions"]')).toBeNull();
    expect(container.querySelector('[data-settings-id^="more-features"]')).toBeNull();
    expect(container.querySelector('[data-settings-id="webui"]')).toBeNull();
    expect(container.querySelector('[data-settings-id*="advanced"]')).toBeNull();
  });

  it('keeps a flat list of every page, with its route and group, in rail order', () => {
    const groupIds = SETTINGS_GROUPS.map((group) => group.id);
    for (const page of SETTINGS_PAGES) {
      expect(page.path).toBe(page.id);
      expect(page.route).toBe(`/settings/${page.path}`);
      expect(groupIds).toContain(page.group);
      expect(page.labelKey).toMatch(/\./);
    }
    expect(new Set(SETTINGS_PAGES.map((page) => page.route)).size).toBe(SETTINGS_PAGES.length);
    // Flat, but each group's pages sit together, in the order of the groups.
    const order = SETTINGS_PAGES.map((page) => groupIds.indexOf(page.group));
    expect(order).toEqual(order.toSorted((a, b) => a - b));
  });

  it('says under a group only what its header leaves out, and keeps the whole name for where a page stands alone', () => {
    const { container } = renderRail();
    const row = (id: string) => container.querySelector(`[data-settings-id="${id}"]`);
    // Under "Details", the row is "Safety"; the page's own title and the palette say "Safety features".
    expect(row('details-safety')).toHaveTextContent('mu.details.areas.safety');
    expect(row('details-other')).toHaveTextContent('mu.details.areas.other');
    const pages = Object.fromEntries(SETTINGS_PAGES.map((page) => [page.id, page]));
    expect(pages['details-safety'].labelKey).toBe('mu.pages.details.safety');
    // A page whose name needs no group keeps it in the rail too.
    expect(row('judges')).toHaveTextContent('mu.sections.judges');
    expect(row('features')).toHaveTextContent('mu.sections.coreFeatures');
    expect(row('board-model')).toHaveTextContent('mu.sections.boardModel');
    expect(DETAIL_AREAS.map((area) => `details-${area}`)).toEqual(groupRows(container).details);
  });

  it('marks the page shown, also from one of its sub-pages, and goes to the page a row names', () => {
    const { container } = renderRail('/settings/details-input/preflight');
    const current = () =>
      [...container.querySelectorAll('[aria-current="page"]')].map((row) => row.getAttribute('data-settings-id'));
    expect(current()).toEqual(['details-input']);
    fireEvent.click(container.querySelector('[data-settings-id="judges"]') as Element);
    expect(here()).toHaveAttribute('data-path', '/settings/judges');
    expect(current()).toEqual(['judges']);
    cleanup();
    // The second page of a feature's options is still under its area's entry, and so is a row a link pointed to.
    renderRail('/settings/details-tools/packs/2');
    expect(
      [...document.querySelectorAll('[aria-current="page"]')].map((row) => row.getAttribute('data-settings-id'))
    ).toEqual(['details-tools']);
    cleanup();
    renderRail('/settings/details-team?feature=hive');
    expect(
      [...document.querySelectorAll('[aria-current="page"]')].map((row) => row.getAttribute('data-settings-id'))
    ).toEqual(['details-team']);
    expect(FEATURE_LIST_PAGES).toEqual(DETAIL_AREAS.map((area) => `details-${area}`));
  });

  it('scrolls the rail just far enough to show the page shown, when it opens and whenever the page changes', () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    try {
      // 关于 is the last row, below the fold of most windows: a link or the palette can open it directly.
      const { container } = renderRail('/settings/about');
      const scrolledRows = () => scroll.mock.contexts.map((row) => (row as Element).getAttribute('data-settings-id'));
      expect(scrolledRows()).toEqual(['about']);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
      fireEvent.click(container.querySelector('[data-settings-id="archived"]') as Element);
      expect(scrolledRows()).toEqual(['about', 'archived']);
      expect(scroll).toHaveBeenLastCalledWith({ block: 'nearest' });
    } finally {
      scroll.mockRestore();
    }
  });

  it('puts an extension next to the page it anchors to, in that group; one without a place ends the capabilities', () => {
    extensionTabs = [
      {
        id: 'ext-after',
        name: 'After tools',
        url: 'about:blank',
        position: { relativeTo: 'tools', placement: 'after' },
      },
      {
        id: 'ext-before',
        name: 'Before judges',
        url: 'about:blank',
        position: { relativeTo: 'judges', placement: 'before' },
      },
      // Anchored to a page of the six-page settings: it stays next to the page that took that one over.
      { id: 'ext-old', name: 'Old kernel', url: 'about:blank', position: { relativeTo: 'kernel', placement: 'after' } },
      { id: 'ext-free', name: 'Free', url: 'about:blank' },
      { id: 'ext-lost', name: 'Lost', url: 'about:blank', position: { relativeTo: 'nowhere', placement: 'after' } },
    ];
    const { container } = renderRail();
    const rows = groupRows(container);
    expect(rows.kernel).toEqual(['ext-before', 'judges', 'ext-old', 'judge-order', 'features']);
    expect(rows.capabilities).toEqual([
      'skills',
      'tools',
      'ext-after',
      'assistants',
      'browser',
      'ext-free',
      'ext-lost',
    ]);
    fireEvent.click(container.querySelector('[data-settings-id="ext-after"]') as Element);
    expect(here()).toHaveAttribute('data-path', '/settings/ext/ext-after');
  });

  it('opens on the first page of the models group: what a new user sets up first', () => {
    expect(SETTINGS_HOME).toBe(SETTINGS_PAGES.find((page) => page.group === 'models')?.route);
  });
});

/** Follows a link through the router's redirects, as the app installs them, to where it lands. */
function follow(link: string, state?: unknown) {
  const url = new URL(link, 'mu://app');
  render(
    <MemoryRouter initialEntries={[{ pathname: url.pathname, search: url.search, state }]}>
      <Routes>
        {Object.keys(RETIRED_SETTINGS_PATHS).map((from) => (
          <Route key={from} path={from} element={<RetiredSettingsPath from={from} />} />
        ))}
        {Object.keys(MOVED_SETTINGS_TABS)
          .filter((path) => !(path in RETIRED_SETTINGS_PATHS))
          .map((path) => (
            <Route
              key={path}
              path={path}
              element={
                <WithMovedTabs path={path}>
                  <Here />
                </WithMovedTabs>
              }
            />
          ))}
        <Route path='*' element={<Here />} />
      </Routes>
    </MemoryRouter>
  );
  const landed = here();
  cleanup();
  return { path: landed.getAttribute('data-path'), state: JSON.parse(landed.getAttribute('data-state') ?? 'null') };
}

const onAPage = (path: string) => SETTINGS_PAGES.some((page) => isSettingsRouteActive(path.split('?')[0], page.route));

describe('links to settings pages that no longer exist', () => {
  it('lands every retired path on a page of the rail, with its query string and its state', () => {
    const state = { openAssistantEditor: true, openAssistantId: 'writer' };
    for (const pattern of Object.keys(RETIRED_SETTINGS_PATHS)) {
      const link = pattern.replace(':section', 'unknown').replace(':id', 'claude');
      const { path, state: carried } = follow(`${link}?highlight=needle`, state);
      expect(onAPage(path ?? ''), `${link} landed on ${path}`).toBe(true);
      expect(new URL(path ?? '', 'mu://app').searchParams.get('highlight'), link).toBe('needle');
      expect(carried, link).toEqual(state);
    }
  });

  it('sends the six pages of the previous settings to the pages that hold them now', () => {
    const cases: [string, string][] = [
      ['/settings/models', '/settings/providers'],
      ['/settings/permissions', '/settings/details-safety/permissions'],
      ['/settings/kernel', '/settings/judges'],
      ['/settings/kernel?highlight=hive', '/settings/judges?highlight=hive'],
      ['/settings/skills', '/settings/skills'],
      ['/settings/skills?tab=skills', '/settings/skills'],
      ['/settings/skills?tab=tools', '/settings/tools'],
      ['/settings/skills?tab=agents&highlight=writer', '/settings/assistants?highlight=writer'],
      ['/settings/appearance', '/settings/appearance'],
      ['/settings/system', '/settings/system'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
  });

  it('sends every page of decision points and of more features to the page of the details for its area', () => {
    const cases: [string, string][] = [
      ['/settings/decisions', '/settings/details-input'],
      ['/settings/decisions?highlight=hive', '/settings/details-input?highlight=hive'],
      ['/settings/more-features', '/settings/details-input'],
      ['/settings/more-features?highlight=packs', '/settings/details-input?highlight=packs'],
      ['/settings/decisions-input', '/settings/details-input'],
      ['/settings/decisions-context', '/settings/details-context'],
      ['/settings/decisions-memory', '/settings/details-memory'],
      ['/settings/decisions-tools', '/settings/details-tools'],
      ['/settings/decisions-turn', '/settings/details-turn'],
      ['/settings/decisions-team?x=1', '/settings/details-team?x=1'],
      ['/settings/more-features-input', '/settings/details-input'],
      ['/settings/more-features-context', '/settings/details-context'],
      ['/settings/more-features-tools', '/settings/details-tools'],
      ['/settings/more-features-turn', '/settings/details-turn'],
      ['/settings/more-features-other', '/settings/details-other'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
    expect(SETTINGS_ANCHOR_REMAP.decisions).toBe('details-input');
    expect(SETTINGS_ANCHOR_REMAP['decisions-team']).toBe('details-team');
    expect(SETTINGS_ANCHOR_REMAP['more-features-tools']).toBe('details-tools');
    expect(SETTINGS_ANCHOR_REMAP.permissions).toBe('details-safety');
    // A feature's options under one of those lists move with the manifest, once the settings are read: the router
    // sends them on to the page of the feature's area (tested with the area itself).
    expect(MOVED_FEATURE_LISTS).toEqual([
      '/settings/features',
      '/settings/more-features',
      ...['input', 'context', 'tools', 'turn', 'other'].map((page) => `/settings/more-features-${page}`),
    ]);
  });

  it('sends mu’s old sections, and the pages that were folded into others, to their own page again', () => {
    const cases: [string, string][] = [
      ['/settings/kyrn', '/settings/providers'],
      ['/settings/kyrn/models', '/settings/providers'],
      ['/settings/kyrn/judges', '/settings/judges'],
      ['/settings/kyrn/decisions', '/settings/details-input'],
      ['/settings/kyrn/features', '/settings/features'],
      ['/settings/kyrn/context', '/settings/details-context'],
      ['/settings/kyrn/permissions', '/settings/details-safety/permissions'],
      ['/settings/model', '/settings/providers'],
      ['/settings/agent', '/settings/assistants'],
      ['/settings/agent/claude/repair', '/settings/assistants'],
      ['/assistants', '/settings/assistants'],
      ['/settings/skills-hub', '/settings/skills'],
      ['/settings/capabilities', '/settings/skills'],
      ['/settings/capabilities?tab=tools&highlight=x', '/settings/tools?highlight=x'],
      ['/settings/capabilities/skills/import-history', '/settings/skills/import-history'],
      ['/settings/display', '/settings/appearance'],
      ['/settings/webui', '/settings/system'],
      // Pages folded into others: the judge tiers are the judge order, the compaction settings on the context page,
      // and the mode of a new conversation on the page of the permission feature's options.
      ['/settings/judge-tiers', '/settings/judge-order'],
      ['/settings/context', '/settings/details-context'],
      ['/settings/context?highlight=limit', '/settings/details-context?highlight=limit'],
      ['/settings/permissions?x=1', '/settings/details-safety/permissions?x=1'],
      // Voice input and the desktop pet are gone: an old link opens the page each sat next to.
      ['/settings/voice', '/settings/system'],
      ['/settings/pet', '/settings/appearance'],
    ];
    for (const [link, target] of cases) expect(follow(link).path, link).toBe(target);
    // The tools, the assistants, the archive and About were folded into other pages; now they are pages.
    const routes = SETTINGS_PAGES.map((page) => page.route as string);
    for (const page of ['tools', 'assistants', 'archived', 'about']) {
      expect(routes).toContain(`/settings/${page}`);
      expect(RETIRED_SETTINGS_PATHS).not.toHaveProperty(`/settings/${page}`);
    }
  });

  it('lets an old link’s own parameters win over the target’s, and drops the tab it named', () => {
    expect(retiredSettingsTarget('/settings/capabilities', '?tab=tools&x=1')).toBe('/settings/tools?x=1');
    expect(retiredSettingsTarget('/settings/nothing-like-it', '?x=1')).toBe(`${SETTINGS_HOME}?x=1`);
  });

  it('resolves every extension anchor of the past to a page of the rail', () => {
    const ids = new Set<string>(SETTINGS_PAGES.map((page) => page.id));
    for (const [anchor, target] of Object.entries(SETTINGS_ANCHOR_REMAP)) expect(ids.has(target), anchor).toBe(true);
  });
});

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');

/** What the rail's search shows, in order, by what each hit is. */
const hits = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-settings-hit]')].map((hit) => hit.getAttribute('data-settings-hit'));

describe('the rail’s search', () => {
  beforeEach(() => {
    extensionTabs = [];
    readSettings.mockResolvedValue({
      ok: true,
      data: {
        harness,
        features: Object.fromEntries(
          harness.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
        ),
      },
    });
  });
  afterEach(() => {
    cleanup();
    readSettings.mockReset();
  });

  const box = () => screen.getByRole('textbox', { name: 'settings.search.placeholder' });

  it('puts what it finds in place of the groups: pages by their names and the texts on them', () => {
    const { container } = renderRail();
    // Nothing is read until something is searched.
    expect(readSettings).not.toHaveBeenCalled();
    fireEvent.change(box(), { target: { value: 'judgeOrder' } });
    expect(container.querySelector('[data-settings-group]')).toBeNull();
    expect(hits(container)[0]).toBe('page:judge-order');
    // A row's title on a page finds that page: the language picker is on the appearance page.
    fireEvent.change(box(), { target: { value: 'settings.language' } });
    expect(hits(container)).toContain('page:appearance');
    fireEvent.click(container.querySelector('[data-settings-hit="page:appearance"]') as Element);
    expect(here()).toHaveAttribute('data-path', '/settings/appearance');
    // The hit for the page shown is marked as the rail marks its page.
    expect(container.querySelector('[data-settings-hit="page:appearance"]')).toHaveAttribute('aria-current', 'page');
    fireEvent.change(box(), { target: { value: 'zzzz' } });
    expect(screen.getByText('settings.search.empty')).toBeInTheDocument();
    // Esc clears it, and the groups are back.
    fireEvent.keyDown(box(), { key: 'Escape' });
    expect(box()).toHaveValue('');
    expect(container.querySelector('[data-settings-group="details"]')).not.toBeNull();
  });

  it('finds every feature and decision point by what the harness calls them, in any of its languages', async () => {
    const { container } = renderRail();
    fireEvent.change(box(), { target: { value: '蜂群' } });
    await waitFor(() => expect(hits(container)).toContain('feature:hive'));
    // The points named apart from their feature are hits of their own; each leads to its feature's row.
    expect(hits(container)).toEqual(['feature:hive', 'decision:hive.publish', 'decision:hive.deliver']);
    const deliver = container.querySelector('[data-settings-hit="decision:hive.deliver"]') as HTMLElement;
    expect(within(deliver).getByText('mu.pages.details.team · Hive')).toBeInTheDocument();
    fireEvent.click(deliver);
    expect(here()).toHaveAttribute('data-path', '/settings/details-team?feature=hive');
    // A point named as its feature is found as the feature, not twice; Enter opens the first hit.
    fireEvent.change(box(), { target: { value: 'risky command' } });
    expect(hits(container)).toEqual(['feature:guard']);
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(here()).toHaveAttribute('data-path', '/settings/details-safety?feature=guard');
    expect(readSettings).toHaveBeenCalledTimes(1);
  });

  it('has no search box while the rail is folded to its icons', () => {
    render(
      <MemoryRouter initialEntries={['/settings/providers']}>
        <SettingsSider collapsed />
      </MemoryRouter>
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
