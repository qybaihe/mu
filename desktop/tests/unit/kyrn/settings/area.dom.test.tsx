import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Select } from '@arco-design/web-react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { Link, MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { defaultFeatureState, parseManifest, type OptionInfo, type OptionValue } from '@/common/kyrn/manifest';
import type { KyrnSettings, Result, SaveSettings } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import MuSettingsPage, { MovedFeatureOptions } from '@/renderer/pages/settings/KyrnSettings';
import SettingsArea from '@/renderer/pages/settings/KyrnSettings/SettingsArea';
import { PAGE_ROWS, isTerminalOnly } from '@/renderer/pages/settings/KyrnSettings/draft';
import { DETAIL_AREAS, MOVED_FEATURE_LISTS } from '@/renderer/pages/settings/settingsNav';
import OptionField, { inSeconds } from '@/renderer/pages/settings/KyrnSettings/fields/OptionField';
import { filterModelOption } from '@/renderer/pages/settings/KyrnSettings/providers/modelOptions';
import { MuSettingsProvider } from '@/renderer/pages/settings/KyrnSettings/useMuSettings';
import { consumePendingDeepLink, offerAddProviderLink } from '@/renderer/hooks/system/useDeepLink';
import manifestJson from './manifest.fixture.json';
import { withOwnPlaces } from './muState.fixture';

const bridge = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  availableModels: vi.fn(),
  recheck: vi.fn(),
  testProvider: vi.fn(),
  loginStatus: vi.fn(),
  loginState: vi.fn(),
  loginStart: vi.fn(),
  loginAnswer: vi.fn(),
  loginCancel: vi.fn(),
  loginLogout: vi.fn(),
  localJudgeState: vi.fn(),
  localJudgeRun: vi.fn(),
  clmCheck: vi.fn(),
}));
// The pickers' copy of what mu offers, read again after mu is checked again.
const catalog = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('@/renderer/hooks/agent/useManagedAgents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/hooks/agent/useManagedAgents')>()),
  refreshManagedAgentCatalogAndAssistants: catalog.refresh,
}));
// The routed page's frame (the settings rail's phone navigation, the scroll box) is not what is tested here.
vi.mock('@/renderer/pages/settings/components/SettingsPageWrapper', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    settings: { invoke: bridge.settings },
    save: { invoke: bridge.save },
    availableModels: { invoke: bridge.availableModels },
    recheck: { invoke: bridge.recheck },
    testProvider: { invoke: bridge.testProvider },
    loginStatus: { invoke: bridge.loginStatus },
    loginState: { invoke: bridge.loginState },
    loginStart: { invoke: bridge.loginStart },
    loginAnswer: { invoke: bridge.loginAnswer },
    loginCancel: { invoke: bridge.loginCancel },
    loginLogout: { invoke: bridge.loginLogout },
    localJudgeState: { invoke: bridge.localJudgeState },
    localJudgeRun: { invoke: bridge.localJudgeRun },
    clmCheck: { invoke: bridge.clmCheck },
  },
  // As the real one: a failure keeps the code the store gave it.
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));

const i18n = createInstance();
beforeAll(async () => {
  const translation = { common: enCommon, mu: enMu };
  await i18n.init({
    lng: 'en-US',
    // Japanese stands for "any locale that is not Chinese": the manifest has no Japanese, so it reads English.
    resources: {
      'en-US': { translation },
      'ja-JP': { translation },
      'zh-CN': { translation: { common: enCommon, mu: zhMu } },
    },
    interpolation: { escapeValue: false },
  });
});

const harness = parseManifest(manifestJson);
if (harness.status !== 'ok') throw new Error('fixture manifest is not readable');
const { manifest } = harness;

function settings(patch: Partial<KyrnSettings> = {}): KyrnSettings {
  return {
    revision: 'r1',
    tiers: ['jev'],
    judges: {
      jev: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 },
      laya: { type: 'local', model: '', baseUrl: 'http://127.0.0.1:47823', apiKeyEnv: '', timeoutMs: 10000 },
    },
    mode: 'shadow',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: { TYPESAFE_API_KEY: true },
    harness,
    decisionModes: {},
    features: Object.fromEntries(manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])),
    models: {
      providers: [
        {
          id: 'relay',
          name: 'Relay',
          api: 'openai-completions',
          baseUrl: 'https://relay.example.com/v1',
          authHeader: false,
          key: 'managed',
          keySet: true,
          headerNames: [],
          models: [
            {
              id: 'plain',
              name: '',
              reasoning: false,
              imageInput: false,
              contextWindow: 128000,
              maxTokens: 16384,
              thinkingLevelMap: {},
              thinkingLevels: ['off'],
            },
          ],
        },
      ],
      foreign: [],
      defaults: { provider: 'relay', model: 'plain', thinkingLevel: '' },
      commented: false,
      problem: '',
    },
    permissions: { mode: 'jev', from: 'default' },
    boardModel: { supported: true, model: '' },
    ...patch,
  };
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US');
  bridge.settings.mockResolvedValue({ ok: true, data: settings() });
  bridge.localJudgeState.mockResolvedValue({
    ok: true,
    data: { support: 'ok', installed: true, running: true, url: 'http://127.0.0.1:47823' },
  });
  bridge.availableModels.mockResolvedValue({
    ok: true,
    data: {
      providers: [
        { id: 'openai-codex', models: [{ id: 'sol', name: 'Sol' }] },
        { id: 'corp-gateway', models: [] },
      ],
      thinkingLevels: [],
    },
  });
  bridge.loginStatus.mockResolvedValue({ ok: true, data: { signedIn: [] } });
  bridge.loginState.mockResolvedValue({ ok: true, data: { id: 0, phase: 'idle' } });
  bridge.recheck.mockResolvedValue({ ok: true, data: undefined });
  catalog.refresh.mockResolvedValue([]);
  // The store answers a save with the whole state again.
  bridge.save.mockImplementation(
    async ({ models, permissions, boardModel, credentials: _credentials, ...input }: SaveSettings) => {
      const base = settings();
      return {
        ok: true,
        data: {
          ...base,
          ...input,
          revision: 'r2',
          models: { ...base.models, ...models },
          permissions: { ...base.permissions, ...permissions },
          boardModel: { ...base.boardModel, ...boardModel },
        },
      };
    }
  );
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
);

async function open(section: string) {
  render(<SettingsArea />, { wrapper });
  fireEvent.click(await screen.findByTestId(`mu-nav-${section}`));
}
/** A harness text that reads the same in both of the harness's languages. */
const bilingual = (words: string) => ({ zh: words, en: words });

/**
 * The settings of a harness shaped like the real one where it matters for the length of a page: thirteen points in the
 * context group, six of them the lessons', and the capability packs with eighteen options, a switch leading each set.
 */
function realShaped() {
  const recall = manifestJson.decisions.find((decision) => decision.id === 'memory.recall')!;
  const risk = manifestJson.decisions.find((decision) => decision.id === 'tool.risk')!;
  const packs: Record<string, unknown>[] = [];
  for (const [lead, ...rest] of [
    ['astGrep', 'maxResults', 'maxDiffChars', 'astGrepCommand'],
    ['github', 'ghCommand'],
    ['commit', 'maxPlanChars'],
    ['review'],
    ['conflicts', 'maxSideLines', 'maxConflictChars', 'maxFindings'],
    ['debugger', 'maxFrames', 'maxVariables', 'debugOutputChars', 'debugWaitMs'],
  ]) {
    packs.push({ key: lead, kind: 'boolean', default: true, label: bilingual(lead) });
    for (const key of rest) packs.push({ key, kind: 'number', default: 1, min: 0, max: 100000, label: bilingual(key) });
  }
  const lessons = ['outcome', 'worth', 'merge', 'applied'].map((name) =>
    Object.assign({}, recall, { id: `memory.${name}` })
  );
  const parsed = parseManifest({
    ...manifestJson,
    decisions: [...manifestJson.decisions, ...lessons, { ...risk, id: 'packs.open', feature: 'packs' }],
    features: [
      ...manifestJson.features,
      {
        name: 'packs',
        title: { zh: '能力包', en: 'Capability packs' },
        summary: bilingual('Tool packs that stay hidden until a task needs them.'),
        defaultEnabled: true,
        options: packs,
      },
    ],
  });
  if (parsed.status !== 'ok') throw new Error('the real-shaped manifest is not readable');
  // As the main process sends them: a state for every feature the manifest has.
  return settings({
    harness: parsed,
    features: Object.fromEntries(
      parsed.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
    ),
  });
}

/** A model's entry in a picker, as the picker's search sees it. */
const modelChoice = (id: string, name: string) => <Select.Option value={id} extra={name} />;

const option = (feature: string, key: string): OptionInfo =>
  manifest.features.find((item) => item.name === feature)!.options.find((item) => item.key === key)!;

describe('generic option fields', () => {
  function field(info: OptionInfo, value: OptionValue) {
    const onChange = vi.fn();
    render(<OptionField scope='x' option={info} value={value} onChange={onChange} />, { wrapper });
    return { onChange, row: screen.getByTestId(`mu-option-x-${info.key}`) };
  }
  it('draws a boolean as a switch', () => {
    const { onChange, row } = field(option('preflight', 'hints'), true);
    const control = within(row).getByRole('switch', { name: 'Give the model a one-line hint' });
    expect(control).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(control);
    expect(onChange).toHaveBeenCalledWith(false, expect.anything());
    expect(within(row).queryByTestId('mu-modified')).not.toBeInTheDocument();
  });
  it('draws a number with its unit and range, and says when a value is out of range', () => {
    const { onChange, row } = field(option('admission', 'minChars'), 100);
    // The bounds are numbers in the app language, and the range is a line of its own under the harness's help.
    expect(row).toHaveTextContent('Range 500 – 200,000.');
    expect(row).toHaveTextContent('chars');
    expect(within(row).getByRole('alert')).toHaveTextContent('outside the allowed range');
    expect(within(row).getByTestId('mu-modified')).toBeInTheDocument();
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '9000' } });
    expect(onChange).toHaveBeenLastCalledWith(9000);
  });
  it('shows a wait kept in milliseconds in seconds, and saves milliseconds', () => {
    const { onChange, row } = field(option('preflight', 'waitMs'), 6000);
    expect(row).toHaveTextContent('Range 0.5 – 30.');
    expect(row).toHaveTextContent('s');
    expect(row).not.toHaveTextContent('ms');
    expect(within(row).getByRole('spinbutton')).toHaveValue('6');
    fireEvent.change(within(row).getByRole('spinbutton'), { target: { value: '2.5' } });
    expect(onChange).toHaveBeenLastCalledWith(2500);
    // Under a second it stays in milliseconds: nothing to gain from 0.25 s.
    expect(inSeconds({ ...option('interjection', 'waitMs'), kind: 'number', default: 250 } as OptionInfo)).toBe(false);
  });
  it('draws text, a choice, a list of strings and a list of numbers', () => {
    const text = field(option('swarm', 'defaultAgent'), 'worker');
    fireEvent.change(within(text.row).getByRole('textbox'), { target: { value: 'scout' } });
    expect(text.onChange).toHaveBeenLastCalledWith('scout', expect.anything());

    const choice = field(option('admission', 'testLog'), 'rules');
    expect(choice.row).toHaveTextContent('Drop exact repeats only (lossless)');
    expect(within(choice.row).getByTestId('mu-modified')).toBeInTheDocument();

    const list = field(option('admission', 'passThrough'), ['read', 'edit', 'write']);
    for (const tag of ['read', 'edit', 'write']) expect(list.row).toHaveTextContent(tag);
    expect(within(list.row).queryByTestId('mu-modified')).not.toBeInTheDocument();

    const numbers = field(option('forgetting', 'thresholds'), [40, 85]);
    expect(numbers.row).toHaveTextContent('40');
    expect(within(numbers.row).getByTestId('mu-modified')).toBeInTheDocument();
  });
});

describe('the details: every feature, with the decision points it asks under it', () => {
  /** The switch of whether Jev's verdict at a point takes effect, by the point's name. */
  const askJev = (row: HTMLElement, point: string) =>
    within(row).getByRole('switch', { name: `Let Jev judge: ${point}` });

  it('lists every feature on the page of its area, each point indented under its feature, each page within twelve rows', async () => {
    await open('details-input');
    const decisions: string[] = [];
    const features: string[] = [];
    for (const area of DETAIL_AREAS) {
      fireEvent.click(screen.getByTestId(`mu-nav-details-${area}`));
      const section = screen.getByTestId(`mu-section-details-${area}`);
      const rows = within(section).queryAllByTestId(/^mu-feature-[a-zA-Z]+$/);
      const points = within(section).queryAllByTestId(/^mu-decision-[a-z.-]+$/);
      expect(rows.length + points.length, area).toBeLessThanOrEqual(PAGE_ROWS);
      features.push(...rows.map((row) => row.dataset.testid!.replace('mu-feature-', '')));
      decisions.push(...points.map((point) => point.dataset.testid!.replace('mu-decision-', '')));
      // Every point is in the row of its own feature.
      for (const point of points) {
        const id = point.dataset.testid!.replace('mu-decision-', '');
        const feature = manifest.decisions.find((decision) => decision.id === id)!.feature;
        expect(point.closest(`[data-testid="mu-feature-${feature}"]`), id).not.toBeNull();
      }
    }
    // Each point and each feature once, on one page; the terminal's welcome box on none.
    expect(decisions.toSorted()).toEqual(manifest.decisions.map((decision) => decision.id).toSorted());
    expect(features.toSorted()).toEqual(
      manifest.features
        .filter((feature) => !isTerminalOnly(feature.name))
        .map((feature) => feature.name)
        .toSorted()
    );
    // Tools and safety are two pages: the guard on the safety page, the file location on the tools page.
    fireEvent.click(screen.getByTestId('mu-nav-details-safety'));
    expect(screen.getByTestId('mu-feature-guard')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-feature-locate')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-details-context'));
    expect(within(screen.getByTestId('mu-feature-compaction')).getByText('Beta')).toBeInTheDocument();
  });
  it.each([
    ['zh-CN', '消息预判', '让 Jev 判断', '让 Jev 判断：消息预判'],
    ['ja-JP', 'Message preflight', 'Let Jev judge', 'Let Jev judge: Message preflight'],
    ['en-US', 'Message preflight', 'Let Jev judge', 'Let Jev judge: Message preflight'],
  ])('reads the manifest in the language of %s', async (language, title, ask, label) => {
    await i18n.changeLanguage(language);
    await open('details-input');
    const feature = screen.getByTestId('mu-feature-preflight');
    expect(within(feature).getByRole('switch', { name: title })).toBeInTheDocument();
    // The point named as its feature needs no name of its own under it: it is the judge's say in the feature.
    const point = within(feature).getByTestId('mu-decision-input.preflight');
    expect(point).toHaveTextContent(ask);
    expect(point).not.toHaveTextContent(title);
    expect(within(point).getByRole('switch', { name: label })).toBeInTheDocument();
  });
  it('names a point by itself where its name is not its feature’s, and lists a point without a feature alone', async () => {
    const preflight = manifestJson.decisions.find((decision) => decision.id === 'input.preflight')!;
    const custom = parseManifest({
      ...manifestJson,
      groups: {},
      decisions: [
        { ...preflight, title: { ...preflight.title, ja: 'メッセージ事前判定' } },
        { ...preflight, id: 'misc.one', group: 'misc', feature: 'gone' },
      ],
    });
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ harness: custom }) });
    await open('details-input');
    expect(screen.getByTestId('mu-decision-input.preflight')).toHaveTextContent('Let Jev judge');
    // The harness has Japanese for the point and not for its feature: the point reads in Japanese, by its name.
    await act(() => i18n.changeLanguage('ja-JP'));
    expect(screen.getByTestId('mu-decision-input.preflight')).toHaveTextContent('Let Jev judge: メッセージ事前判定');
    // A group the desktop has no page for, and a feature the harness does not describe: a row of its own, on Other.
    fireEvent.click(screen.getByTestId('mu-nav-details-other'));
    const stray = screen.getByTestId('mu-decision-misc.one');
    expect(stray.parentElement).toBe(screen.getByTestId('mu-feature-list-other'));
    expect(stray).toHaveTextContent('Message preflight');
    expect(stray).not.toHaveTextContent('misc');
  });
  it('has no search of its own: the search at the top of the rail finds every setting', async () => {
    await open('details-input');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/search/i)).not.toBeInTheDocument();
  });
  it('shows each feature as a switch, and its options on a page of their own, never folded into the list', async () => {
    await open('details-input');
    const preflight = screen.getByTestId('mu-feature-preflight');
    expect(within(preflight).getByRole('switch', { name: 'Message preflight' })).toBeChecked();
    expect(screen.queryByTestId('mu-option-preflight-waitMs')).not.toBeInTheDocument();
    expect(screen.queryByText(/Advanced/)).not.toBeInTheDocument();
    // A feature without options has nothing to open.
    fireEvent.click(screen.getByTestId('mu-nav-details-safety'));
    expect(screen.queryByTestId('mu-feature-open-guard')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-details-input'));
    fireEvent.click(within(screen.getByTestId('mu-feature-preflight')).getByTestId('mu-feature-open-preflight'));
    const page = screen.getByTestId('mu-section-feature-preflight');
    expect(within(page).getByRole('heading', { name: 'Message preflight' })).toBeInTheDocument();
    expect(within(page).getByTestId('mu-option-preflight-waitMs')).toBeInTheDocument();
    // The switch is on this page too, next to the feature's name; the way back names the page.
    expect(within(page).getByRole('switch', { name: 'Message preflight' })).toBeChecked();
    expect(screen.getByTestId('mu-feature-back')).toHaveTextContent('Input features');
    fireEvent.click(screen.getByTestId('mu-feature-back'));
    expect(screen.getByTestId('mu-section-details-input')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-option-preflight-waitMs')).not.toBeInTheDocument();
  });
  it('marks what differs from the default and restores a feature', async () => {
    await open('details-input');
    fireEvent.click(screen.getByTestId('mu-feature-open-preflight'));
    const page = () => screen.getByTestId('mu-section-feature-preflight');
    expect(within(page()).queryByTestId('mu-modified')).not.toBeInTheDocument();
    fireEvent.click(within(page()).getByRole('switch', { name: 'Show the wait and the verdict' }));
    // One marker on the option, one on the feature.
    expect(within(page()).getAllByTestId('mu-modified')).toHaveLength(2);
    // The list says so too.
    fireEvent.click(screen.getByTestId('mu-feature-back'));
    expect(within(screen.getByTestId('mu-feature-preflight')).getByTestId('mu-modified')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-feature-open-preflight'));
    fireEvent.click(within(page()).getByText('Restore defaults'));
    expect(within(page()).queryByTestId('mu-modified')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });
  it('says the harness is too old without a manifest, and keeps the judges’ switch working', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ harness: { status: 'missing' }, features: {} }) });
    await open('details-input');
    expect(screen.getByText(/too old to list/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-judges'));
    fireEvent.click(within(screen.getByTestId('mu-judge-mode')).getByRole('switch', { name: 'Verdicts take effect' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.mode).toBe('active');
    expect(sent).not.toHaveProperty('features');
    expect(sent).not.toHaveProperty('decisionModes');
  });
  it('shows each point as a switch: a stored shadow reads as off, and a change writes active or off', async () => {
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({ mode: 'shadow', decisionModes: { 'tool.risk': 'shadow', 'input.preflight': 'active' } }),
    });
    await open('details-safety');
    const risk = screen.getByTestId('mu-decision-tool.risk');
    // A switch, not a choice of modes; the harness's third mode is not offered, and is not named anywhere.
    expect(within(risk).queryByRole('radio')).not.toBeInTheDocument();
    expect(askJev(risk, 'Risky command guard')).not.toBeChecked();
    expect(screen.getByTestId('kyrn-settings')).not.toHaveTextContent(/shadow/i);
    fireEvent.click(screen.getByTestId('mu-nav-details-input'));
    expect(askJev(screen.getByTestId('mu-decision-input.preflight'), 'Message preflight')).toBeChecked();
    // The mode every point without its own follows is the judges page's switch, not a row of the details.
    expect(screen.queryByTestId('mu-judge-mode')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-judges'));
    const verdicts = within(screen.getByTestId('mu-judge-mode')).getByRole('switch', { name: 'Verdicts take effect' });
    expect(verdicts).not.toBeChecked();
    // Nothing is written until a switch is moved: a shadow left alone stays as it is in the file.
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    fireEvent.click(verdicts);
    fireEvent.click(verdicts);
    fireEvent.click(screen.getByTestId('mu-nav-details-safety'));
    fireEvent.click(askJev(screen.getByTestId('mu-decision-tool.risk'), 'Risky command guard'));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges and Decision points');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.mode).toBe('off');
    expect(sent.decisionModes).toEqual({ 'tool.risk': 'active', 'input.preflight': 'active' });
  });
  it('greys the points of a feature that is off and says so, and gives them back once it is on', async () => {
    await open('details-team');
    const hive = screen.getByTestId('mu-feature-hive');
    const deliver = () => screen.getByTestId('mu-decision-hive.deliver');
    expect(askJev(deliver(), 'Hive: delivery')).toBeEnabled();
    expect(deliver()).not.toHaveTextContent('The feature is off');
    fireEvent.click(within(hive).getByRole('switch', { name: 'Hive' }));
    for (const id of ['hive.publish', 'hive.deliver']) {
      const point = screen.getByTestId(`mu-decision-${id}`);
      expect(point).toHaveTextContent('The feature is off');
      expect(within(point).getByRole('switch')).toBeDisabled();
    }
    // The sub-agents' point, under a feature that is on, is not touched.
    expect(within(screen.getByTestId('mu-decision-swarm.routing')).getByRole('switch')).toBeEnabled();
    fireEvent.click(within(hive).getByRole('switch', { name: 'Hive' }));
    expect(askJev(deliver(), 'Hive: delivery')).toBeEnabled();
    expect(screen.queryByText('The feature is off')).not.toBeInTheDocument();
  });
});

describe('the save bar', () => {
  it('appears with the first change, names the sections, saves everything at once and goes away', async () => {
    await open('details-safety');
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('mu-decision-tool.risk')).getByRole('switch'));
    fireEvent.click(
      within(screen.getByTestId('mu-feature-guard')).getAllByRole('switch', { name: 'Risky command guard' })[0]
    );
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Decision points and Features');
    expect(within(screen.getByTestId('mu-nav-details-safety')).getByLabelText('Unsaved changes')).toBeInTheDocument();
    expect(within(screen.getByTestId('mu-nav-providers')).queryByLabelText('Unsaved changes')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());
    expect(bridge.save).toHaveBeenCalledTimes(1);
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.revision).toBe('r1');
    expect(sent.decisionModes).toEqual({ 'tool.risk': 'active' });
    expect(sent.features?.guard.enabled).toBe(false);
    expect(sent).not.toHaveProperty('keys');
    expect(sent).not.toHaveProperty('credentials');
  });
  it('has mu checked again after a save, and only then the pickers read what it offers', async () => {
    let checked!: (value: { ok: true; data: undefined }) => void;
    bridge.recheck.mockReturnValue(new Promise((resolve) => (checked = resolve)));
    bridge.save.mockResolvedValueOnce({ ok: false, code: 'backend', error: 'EACCES: permission denied' });
    await open('details-context');
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic compaction' }));
    fireEvent.click(screen.getByText('Save'));
    expect(await within(screen.getByTestId('mu-save-bar')).findByText(/EACCES/)).toBeInTheDocument();
    // Nothing was saved, so nothing changed for mu.
    expect(bridge.recheck).not.toHaveBeenCalled();

    fireEvent.click(within(screen.getByTestId('mu-save-bar')).getByText('Save'));
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());
    expect(bridge.recheck).toHaveBeenCalledTimes(1);
    // The save bar is gone while the check runs: nobody waits for it.
    expect(catalog.refresh).not.toHaveBeenCalled();
    await act(async () => checked({ ok: true, data: undefined }));
    await waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(1));
  });
  it('going back to the default removes the override, and discard puts everything back', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ decisionModes: { 'tool.risk': 'off' } }) });
    await open('details-safety');
    const row = () => screen.getByTestId('mu-decision-tool.risk');
    expect(within(row()).getByRole('switch')).not.toBeChecked();
    // A point without a mode of its own shows the default (a shadow, which reads as off) and offers nothing to undo.
    expect(within(screen.getByTestId('mu-decision-tool.constraint')).getByRole('switch')).not.toBeChecked();
    expect(screen.queryByTestId('mu-decision-default-tool.constraint')).not.toBeInTheDocument();
    fireEvent.click(within(row()).getByText('Use the default (Off)'));
    expect(within(row()).getByRole('switch')).not.toBeChecked();
    expect(screen.queryByTestId('mu-decision-default-tool.risk')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard'));
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-decision-default-tool.risk')).toBeInTheDocument();
  });
  it('shows a point whose feature is off as muted, with a plain sentence instead of a code name', async () => {
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({ features: { ...settings().features, guard: { enabled: false, options: {} } } }),
    });
    await open('details-safety');
    const row = screen.getByTestId('mu-decision-tool.risk');
    expect(row).toHaveTextContent('The feature is off');
    expect(row).not.toHaveTextContent('tool.risk');
    expect(within(row).getByRole('switch')).toBeDisabled();
  });
  it('explains a stale revision and offers to reload; another failure shows its reason', async () => {
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'stale',
      error: 'Configuration changed. Reload before saving.',
    });
    await open('details-context');
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic compaction' }));
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(/Another program .* changed the configuration/)).toBeInTheDocument();
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ revision: 'r9', autoCompaction: true }) });
    fireEvent.click(within(screen.getByTestId('mu-save-bar')).getByText('Reload'));
    await waitFor(() => expect(bridge.settings).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument());

    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'optionValue',
      params: { feature: 'preflight', option: 'waitMs', problem: 'range' },
      error: 'Invalid value for preflight.waitMs (range)',
    });
    fireEvent.click(await screen.findByTestId('mu-nav-details-context'));
    fireEvent.click(screen.getByRole('switch', { name: 'Automatic compaction' }));
    fireEvent.click(screen.getByText('Save'));
    // The option is named in the reader's words, from the manifest; the store's English stays out.
    expect(await screen.findByText('Not saved: “Wait at most” is outside the allowed range.')).toBeInTheDocument();
    expect(screen.queryByText(/Invalid value/)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('mu-save-bar')).queryByText('Reload')).not.toBeInTheDocument();
  });
  it('translates a failed save in Chinese too, with list and number formats of the language', async () => {
    await i18n.changeLanguage('zh-CN');
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'sharedKey',
      params: { providers: ['a-b', 'a.b'] },
      error: 'Providers a-b and a.b would share a key',
    });
    await open('details-context');
    fireEvent.click(screen.getByRole('switch', { name: '自动压缩' }));
    // The common module is the English one in this setup.
    fireEvent.click(screen.getByText('Save'));
    expect(
      await screen.findByText('保存失败：a-b 和 a.b 会共用同一个密钥变量，请修改其中一个 ID。')
    ).toBeInTheDocument();
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'contextLimit',
      params: { min: 8192, max: 10000000 },
      error: 'Context threshold must be 0 or an integer between 8192 and 10000000',
    });
    fireEvent.click(screen.getByText('Save'));
    expect(
      await screen.findByText('保存失败：上下文上限必须是 0，或 8,192 到 10,000,000 之间的整数。')
    ).toBeInTheDocument();
  });
  it('shows a failed load with a way to try again', async () => {
    bridge.settings.mockResolvedValueOnce({
      ok: false,
      code: 'invalidJson',
      params: { file: '/home/me/.mu/agent/mu.json' },
      error: "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
    });
    render(<SettingsArea />, { wrapper });
    // A sentence the reader can act on, naming the file; the parser's own words only as the detail under it.
    expect(await screen.findByText('The settings could not be loaded')).toBeInTheDocument();
    expect(
      screen.getByText('/home/me/.mu/agent/mu.json is not valid JSON. Fix it by hand, then reload.')
    ).toBeInTheDocument();
    expect(screen.getByTestId('mu-error-detail')).toHaveTextContent('at position 1 (line 1 column 2)');
    fireEvent.click(screen.getByText('Reload'));
    expect(await screen.findByTestId('mu-nav-judges')).toBeInTheDocument();
  });
});

describe('providers and the default model', () => {
  it('lists the subscriptions above the endpoints, each subscription once, and opens the first endpoint', async () => {
    await open('providers');
    const list = screen.getByRole('listbox', { name: 'Providers' });
    const names = within(list)
      .getAllByRole('option')
      .map((item) => item.textContent);
    expect(names).toEqual(['ChatGPT', 'Claude', 'Grok', 'Relay', 'corp-gateway']);
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('Relay');
    // mu reported openai-codex too: it is the subscription above, not another built-in provider.
    expect(screen.queryByTestId('mu-provider-item-builtin-openai-codex')).not.toBeInTheDocument();
    const relay = screen.getByTestId('mu-provider-item-custom-0');
    expect(within(relay).getByRole('img', { name: 'Usable' })).toBeInTheDocument();
  });

  it('signs in to a subscription at once, outside the save bar', async () => {
    await open('providers');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-openai-codex'));
    const detail = screen.getByTestId('mu-account-openai-codex');
    expect(detail).toHaveTextContent('Plus / Pro plan');
    expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Not signed in');
    const running = {
      id: 1,
      provider: 'openai-codex',
      phase: 'running',
      url: 'https://auth.openai.com/oauth/authorize',
    };
    bridge.loginStart.mockResolvedValue({ ok: true, data: running });
    bridge.loginState.mockResolvedValue({ ok: true, data: running });
    fireEvent.click(within(detail).getByTestId('mu-account-signin-openai-codex'));
    expect(await screen.findByTestId('mu-login-waiting')).toHaveTextContent('ChatGPT');
    const item = screen.getByTestId('mu-provider-item-account-openai-codex');
    expect(within(item).getByRole('img', { name: 'Signing in…' })).toBeInTheDocument();

    bridge.loginState.mockResolvedValue({
      ok: true,
      data: { ...running, phase: 'done', models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }] },
    });
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'), {
      timeout: 3000,
    });
    expect(detail).toHaveTextContent('GPT-5.5');
    expect(within(item).getByRole('img', { name: 'Signed in' })).toBeInTheDocument();
    expect(within(detail).getByTestId('mu-account-signout-openai-codex')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    expect(bridge.save).not.toHaveBeenCalled();
    // The account's models reach the home page's pill without a new start of the app.
    await waitFor(() => expect(bridge.recheck).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(catalog.refresh).toHaveBeenCalledTimes(1));
  });

  it('signs out only after asking, and shows who is still signed in', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] }] },
    });
    bridge.loginLogout.mockResolvedValue({ ok: true, data: { signedIn: [] } });
    await open('providers');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-anthropic'));
    const detail = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(detail).getByTestId('mu-account-signout-anthropic'));
    expect(bridge.loginLogout).not.toHaveBeenCalled();
    const confirm = await screen.findByText('Sign out of Claude? You will need to sign in again to use it.');
    expect(confirm).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(bridge.loginLogout).toHaveBeenCalledWith({ provider: 'anthropic' }));
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Not signed in'));
    expect(within(detail).getByTestId('mu-account-signin-anthropic')).toBeInTheDocument();
    await waitFor(() => expect(bridge.recheck).toHaveBeenCalledTimes(1));
  });

  it('says in the app language when signing out or in did not work, with the raw reason under it', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }] }] },
    });
    bridge.loginLogout.mockResolvedValue({
      ok: false,
      code: 'backend',
      error: 'EACCES: permission denied',
      params: { status: 500 },
    });
    await open('providers');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-anthropic'));
    const detail = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(detail).getByTestId('mu-account-signout-anthropic'));
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    const problem = await within(detail).findByTestId('mu-login-problem');
    // Its own headline, not the sign-in one; the call's words stay as a detail.
    expect(problem).toHaveTextContent('Signing out did not finish. You can try again.');
    expect(problem).toHaveTextContent('EACCES: permission denied');

    bridge.loginStart.mockResolvedValue({ ok: false, code: 'runtimeOffline', error: 'runtime offline' });
    fireEvent.click(screen.getByTestId('mu-provider-item-account-xai'));
    const xai = screen.getByTestId('mu-account-xai');
    fireEvent.click(within(xai).getByTestId('mu-account-signin-xai'));
    const failed = await within(xai).findByTestId('mu-login-problem');
    expect(failed).toHaveTextContent('Signing in did not finish. You can try again.');
    expect(failed).toHaveTextContent('The mu runtime is not online.');
    // A coded reason says all there is: the raw text is not repeated.
    expect(failed).not.toHaveTextContent('runtime offline');
  });
  it('puts the API format first, and sends a typed key only as a credential', async () => {
    const user = userEvent.setup();
    await open('providers');
    const editor = screen.getByTestId('mu-provider-editor');
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('Set');
    await user.click(within(editor).getByTestId('mu-endpoint-select'));
    fireEvent.click(await screen.findByText('Anthropic compatible (Messages)'));
    expect(editor).toHaveTextContent('Without /v1');
    fireEvent.change(within(editor).getByLabelText('API key'), { target: { value: 'sk-typed' } });
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('New key, not saved yet');
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Providers');

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers[0].api).toBe('anthropic-messages');
    expect(sent.models).not.toHaveProperty('removeEntries');
    expect(sent.credentials).toEqual([{ name: 'MU_PROVIDER_RELAY_API_KEY', value: 'sk-typed' }]);
    expect(JSON.stringify(sent.models)).not.toContain('sk-typed');
  });
  it('opens a new provider filled from a mu:// add-provider link, saved only from the save bar', async () => {
    offerAddProviderLink({
      name: 'Team Relay',
      base_url: 'https://team.example.com/v1',
      api_key: 'sk-link',
      platform: 'new-api',
    });
    await open('providers');
    const editor = screen.getByTestId('mu-provider-editor');
    expect(within(editor).getByLabelText('Display name')).toHaveValue('Team Relay');
    expect(within(editor).getByLabelText('ID')).toHaveValue('team-relay');
    expect(within(editor).getByLabelText('Base URL')).toHaveValue('https://team.example.com/v1');
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('New key, not saved yet');
    expect(consumePendingDeepLink()).toBeNull();
    expect(bridge.save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers[1]).toMatchObject({
      id: 'team-relay',
      name: 'Team Relay',
      api: 'openai-completions',
      baseUrl: 'https://team.example.com/v1',
    });
    expect(sent.credentials).toEqual([{ name: 'MU_PROVIDER_TEAM_RELAY_API_KEY', value: 'sk-link' }]);
  });

  it('takes a link that arrives while the page is open, in the format its platform names, under a free id', async () => {
    await open('providers');
    act(() => offerAddProviderLink({ name: 'Relay', base_url: 'https://proxy.example.com', platform: 'anthropic' }));
    const editor = screen.getByTestId('mu-provider-editor');
    // "relay" is the saved provider's id already.
    expect(within(editor).getByLabelText('ID')).toHaveValue('custom');
    expect(within(editor).getByLabelText('Base URL')).toHaveValue('https://proxy.example.com');
    expect(editor).toHaveTextContent('Without /v1');
    expect(within(editor).getByTestId('mu-key-state')).toHaveTextContent('Not set');
  });

  it('adds a provider whose id follows its name, and refuses the id of a built-in or reported provider', async () => {
    await open('providers');
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    expect(
      within(screen.getByTestId('mu-provider-item-custom-1')).getByRole('img', { name: 'Not saved' })
    ).toBeInTheDocument();
    fireEvent.change(within(editor).getByLabelText('Display name'), { target: { value: 'My Proxy (EU)' } });
    expect(within(editor).getByLabelText('ID')).toHaveValue('my-proxy-eu');
    for (const [id, message] of [
      ['openai', 'id of a built-in provider'],
      ['corp-gateway', 'already in use'],
      ['relay', 'already in use'],
      ['Bad Id', 'lowercase letters'],
    ]) {
      fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: id } });
      expect(editor).toHaveTextContent(message);
    }
    expect(within(editor).getByText('Test connection').closest('button')).toBeDisabled();
  });
  it('names providers in words: a new one, the API format of an entry, subscriptions as startup providers', async () => {
    const user = userEvent.setup();
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [
            {
              id: 'anthropic',
              name: '',
              api: 'anthropic-messages',
              baseUrl: 'https://p.example.com',
              modelCount: 1234,
            },
            { id: 'lab', name: 'Lab', api: 'bedrock-converse', baseUrl: '', modelCount: 1 },
          ],
        },
      }),
    });
    await open('providers');
    fireEvent.click(screen.getByText('Add provider'));
    // Not the placeholder id "custom" it was given.
    expect(screen.getByTestId('mu-provider-item-custom-1')).toHaveTextContent(/^New provider$/);
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('New provider');

    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-anthropic'));
    expect(screen.getByTestId('mu-provider-foreign')).toHaveTextContent(
      'Anthropic compatible · https://p.example.com · 1,234 models'
    );
    // An API format this screen does not know goes by what models.json says.
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab'));
    expect(screen.getByTestId('mu-provider-foreign')).toHaveTextContent('bedrock-converse · 1 model');

    fireEvent.click(screen.getByTestId('mu-nav-board-model'));
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(0));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    expect(offered).toEqual(expect.arrayContaining(['Relay', 'ChatGPT', 'corp-gateway']));
    expect(offered).not.toContain('openai-codex');
  });
  it('tests the connection through the main process and offers the models it listed', async () => {
    bridge.testProvider.mockResolvedValue({
      ok: true,
      data: { ok: true, code: 'ok-models', status: 200, latencyMs: 12, detail: '', models: ['plain', 'fresh-model'] },
    });
    await open('providers');
    fireEvent.click(screen.getByText('Test connection'));
    expect(await screen.findByTestId('mu-test-result')).toHaveTextContent('The endpoint lists 2 models.');
    expect(bridge.testProvider).toHaveBeenCalledWith({
      id: 'relay',
      api: 'openai-completions',
      baseUrl: 'https://relay.example.com/v1',
      authHeader: false,
      model: 'plain',
    });
    const offer = screen.getByTestId('mu-model-offer-fresh-model');
    // A listed model is offered with a plus mark and says so in words, not with a "+" glued to its id.
    expect(offer).toHaveTextContent(/^fresh-model$/);
    expect(offer).toHaveAttribute('title', 'Add fresh-model');
    fireEvent.click(offer);
    expect(screen.getByTestId('mu-model-1')).toHaveTextContent('fresh-model');
    expect(screen.queryByTestId('mu-model-offer-fresh-model')).not.toBeInTheDocument();
  });
  it('shows each model on one line and opens one to edit; a model without an id stays open', async () => {
    await open('providers');
    const line = screen.getByTestId('mu-model-0');
    expect(line).toHaveTextContent('plain');
    expect(line).toHaveTextContent('128K');
    expect(screen.queryByLabelText('Model ID 1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit plain' }));
    fireEvent.change(screen.getByLabelText('Model ID 1'), { target: { value: 'renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('Model ID 1')).not.toBeInTheDocument();
    expect(line).toHaveTextContent('renamed');

    fireEvent.click(screen.getByTestId('mu-model-add'));
    expect(screen.getByLabelText('Model ID 2')).toHaveValue('');
    expect(screen.getByTestId('mu-model-edit-1')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove New model' }));
    expect(screen.queryByTestId('mu-model-1')).not.toBeInTheDocument();
    expect(screen.getByTestId('mu-model-0')).toHaveTextContent('renamed');
  });
  it('writes the thinking levels toggled on a model, and the default-model page follows', async () => {
    await open('providers');
    fireEvent.click(screen.getByRole('button', { name: 'Edit plain' }));
    expect(screen.queryByTestId('mu-model-levels-0')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Thinking 1' }));
    const levels = screen.getByTestId('mu-model-levels-0');
    expect(levels).toHaveTextContent('Very high and Max stay off until you turn them on.');
    expect(within(levels).getByRole('checkbox', { name: 'Low 1' })).toBeChecked();
    expect(within(levels).getByRole('checkbox', { name: 'Very high 1' })).not.toBeChecked();
    expect(within(levels).getByRole('checkbox', { name: 'Max 1' })).not.toBeChecked();
    fireEvent.click(within(levels).getByRole('checkbox', { name: 'Very high 1' }));
    fireEvent.click(within(levels).getByRole('checkbox', { name: 'Low 1' }));
    fireEvent.click(screen.getByTestId('mu-nav-default-model'));
    const thinking = screen.getByTestId('mu-thinking-level');
    expect(thinking).toHaveTextContent('Levels this model does not take are disabled.');
    expect(within(thinking).getByRole('radio', { name: 'Very high' })).toBeEnabled();
    expect(within(thinking).getByRole('radio', { name: 'Low' })).toBeDisabled();
    expect(within(thinking).getByRole('radio', { name: 'Max' })).toBeDisabled();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers?.[0].models[0]).toMatchObject({
      id: 'plain',
      reasoning: true,
      thinkingLevelMap: { low: null, xhigh: 'xhigh' },
    });
  });
  it('words a refused test and the endpoint’s own answer apart, and gives the model id one placeholder', async () => {
    await open('providers');
    // The model id field has one placeholder sentence, not two glued ones.
    fireEvent.click(screen.getByRole('button', { name: 'Edit plain' }));
    expect(screen.getByPlaceholderText('Model ID · as the API expects it')).toBeInTheDocument();
    bridge.testProvider.mockResolvedValueOnce({ ok: false, code: 'credential', error: 'Invalid credential' });
    fireEvent.click(screen.getByText('Test connection'));
    const failed = await screen.findByTestId('mu-test-failure');
    expect(failed).toHaveTextContent('The key contains characters a key cannot have');
    expect(failed).not.toHaveTextContent('Invalid credential');
    bridge.testProvider.mockResolvedValueOnce({
      ok: true,
      data: { ok: false, code: 'auth', status: 401, latencyMs: 1200, detail: 'Incorrect API key provided', models: [] },
    });
    fireEvent.click(screen.getByText('Test connection'));
    const result = await screen.findByTestId('mu-test-result');
    expect(within(result).getByText('The key was rejected (HTTP 401).')).toBeInTheDocument();
    expect(within(result).getByText('The endpoint said: Incorrect API key provided')).toBeInTheDocument();
  });
  it('picks the model that writes the board, the recommended ones first, or the conversation’s own', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: {
        providers: [
          {
            id: 'corp-gateway',
            models: [
              { id: 'gpt-5', name: '' },
              { id: 'claude-opus-4-6', name: '' },
            ],
          },
        ],
        thinkingLevels: [],
      },
    });
    await open('board-model');
    // A page of its own, apart from the model new sessions start with; its header says what the model is for.
    expect(screen.queryByTestId('mu-defaults')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plain-language model' })).toBeInTheDocument();
    const card = screen.getByTestId('mu-board-model');
    expect(card).toHaveTextContent('None yet: mu asks the first time the board is switched on.');
    expect(card).toHaveTextContent('Pick a provider first');
    const user = userEvent.setup();
    await user.click(within(card).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    // Nothing is set before a model is picked.
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    await user.click(within(card).getByLabelText('Model'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(1));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    expect(offered.slice(-2)).toEqual(['claude-opus-4-6 · recommended', 'gpt-5']);
    fireEvent.click(screen.getByText('claude-opus-4-6 · recommended', { selector: '.arco-select-option span' }));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Plain-language model');
    expect(card).not.toHaveTextContent('None yet');

    // The conversation's own model, then back to the one picked.
    fireEvent.click(within(card).getByTestId('mu-board-model-session'));
    expect(within(card).getByTestId('mu-board-model-session')).toHaveAttribute('aria-checked', 'true');
    expect(within(card).queryByLabelText('Model')).not.toBeInTheDocument();
    fireEvent.click(within(card).getByTestId('mu-board-model-pick'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    expect((bridge.save.mock.calls[0][0] as SaveSettings).boardModel).toEqual({
      model: 'corp-gateway/claude-opus-4-6',
    });
  });
  it('starts new sessions with the provider, model and thinking level picked on the default model page', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'corp-gateway', models: [{ id: 'gpt-5', name: '' }] }], thinkingLevels: [] },
    });
    await open('default-model');
    const card = screen.getByTestId('mu-defaults');
    // Relay's model does not think, and the page says so instead of offering levels it would not take.
    expect(card).toHaveTextContent('This model does not think');
    expect(within(card).getByRole('radio', { name: 'High' })).toBeDisabled();
    const user = userEvent.setup();
    await user.click(within(card).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    // A model belongs to its provider: another provider, and it is to be picked again.
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Default model');
    await user.click(within(card).getByLabelText('Model'));
    fireEvent.click(await screen.findByText('gpt-5', { selector: '.arco-select-option span' }));
    fireEvent.click(within(card).getByRole('radio', { name: 'High' }));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    expect((bridge.save.mock.calls[0][0] as SaveSettings).models?.defaults).toEqual({
      provider: 'corp-gateway',
      model: 'gpt-5',
      thinkingLevel: 'high',
    });
  });
  it('offers models by their names, with the id in the tooltip, found by either, and saves the id', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: {
        providers: [
          {
            id: 'corp-gateway',
            models: [
              { id: 'gpt-5-6-terra', name: 'GPT-5.6 Terra' },
              { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
            ],
          },
        ],
        thinkingLevels: [],
      },
    });
    await open('default-model');
    const card = screen.getByTestId('mu-defaults');
    const user = userEvent.setup();
    await user.click(within(card).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    await user.click(within(card).getByLabelText('Model'));
    const terra = await screen.findByText('GPT-5.6 Terra');
    expect(terra).toHaveAttribute('title', 'gpt-5-6-terra');
    expect(screen.queryByText('gpt-5-6-terra')).not.toBeInTheDocument();
    // The search finds a model by its id as well as by its name.
    expect(filterModelOption('opus-4', modelChoice('claude-opus-4-6', 'Claude Opus 4.6'))).toBe(true);
    expect(filterModelOption('terra', modelChoice('gpt-5-6-terra', 'GPT-5.6 Terra'))).toBe(true);
    expect(filterModelOption('terra', modelChoice('claude-opus-4-6', 'Claude Opus 4.6'))).toBe(false);
    fireEvent.click(screen.getByText('Claude Opus 4.6'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    expect((bridge.save.mock.calls[0][0] as SaveSettings).models?.defaults.model).toBe('claude-opus-4-6');

    // The board's picker names them the same way, the recommended one marked after its name.
    fireEvent.click(screen.getByTestId('mu-nav-board-model'));
    const board = screen.getByTestId('mu-board-model');
    await user.click(within(board).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    await user.click(within(board).getByLabelText('Model'));
    expect(await screen.findByText('Claude Opus 4.6 · recommended')).toHaveAttribute('title', 'claude-opus-4-6');
  });
  it('says when this mu cannot be told which model writes the board', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ boardModel: { supported: false, model: '' } }) });
    await open('board-model');
    const card = screen.getByTestId('mu-board-model');
    expect(card).toHaveTextContent('Update mu first.');
    expect(within(card).queryByRole('radio')).not.toBeInTheDocument();
  });

  it('removes a provider from its menu after asking, with its key and the startup model that used it', async () => {
    await open('providers');
    const editor = screen.getByTestId('mu-provider-editor');
    fireEvent.change(within(editor).getByLabelText('API key'), { target: { value: 'sk-typed' } });
    fireEvent.click(within(editor).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText('Remove Relay?')).toBeInTheDocument();
    expect(screen.getByText(/deleted from models.json, and so is the key/)).toBeInTheDocument();
    expect(screen.getByText(/the default model is cleared too/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-0')).not.toBeInTheDocument());
    // With no endpoint left, the first subscription is shown.
    expect(screen.getByTestId('mu-account-openai-codex')).toBeInTheDocument();
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Providers');

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.providers).toEqual([]);
    expect(sent.models?.defaults).toEqual({ provider: '', model: '', thinkingLevel: '' });
    expect(sent.credentials).toBeUndefined();
  });

  it('keeps a provider when the question is cancelled, and drops one not saved yet without a save', async () => {
    await open('providers');
    fireEvent.click(screen.getByText('Add provider'));
    const more = () => within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more');
    fireEvent.click(more());
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText(/not saved yet, so what you filled in here is discarded/)).toBeInTheDocument();
    expect(screen.queryByText(/the default model is cleared too/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByTestId('mu-provider-item-custom-1')).toBeInTheDocument();

    fireEvent.click(more());
    const items = await screen.findAllByText('Remove provider');
    fireEvent.click(items[items.length - 1]);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Remove' }).length).toBeGreaterThan(0));
    const oks = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(oks[oks.length - 1]);
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-1')).not.toBeInTheDocument());
    expect(screen.getByTestId('mu-provider-editor')).toHaveTextContent('Relay');
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('removes a hand-written entry by name when saved; one that rerouted a built-in provider keeps the startup model', async () => {
    const base = settings();
    const foreign = [
      { id: 'anthropic', name: '', api: '', baseUrl: 'https://p.example.com', modelCount: 0 },
      { id: 'lab', name: 'Lab', api: 'bedrock-converse', baseUrl: '', modelCount: 2 },
    ];
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: { ...base.models, foreign, defaults: { provider: 'lab', model: 'x', thinkingLevel: '' } },
      }),
    });
    await open('providers');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    expect(await screen.findByText(/this hand-written entry is deleted from models.json/)).toBeInTheDocument();
    expect(screen.getByText(/the default model is cleared too/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-foreign-lab')).not.toBeInTheDocument());
    expect(screen.getByTestId('mu-provider-item-foreign-anthropic')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.removeEntries).toEqual(['lab']);
    expect(sent.models?.defaults.provider).toBe('');
  });

  it('keeps a removed id taken until the removal is saved, so a new provider cannot take over the old entry', async () => {
    await open('providers');
    fireEvent.click(within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-0')).not.toBeInTheDocument());
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    expect(within(editor).getByLabelText('ID')).not.toHaveValue('relay');
    fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: 'relay' } });
    expect(editor).toHaveTextContent('already in use');
  });

  it('does not list a removed entry again from what mu last reported, nor offer it for the board', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [{ id: 'lab-2', name: 'Lab 2', api: 'bedrock-converse', baseUrl: '', modelCount: 1 }],
        },
      }),
    });
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'lab-2', models: [{ id: 'm', name: 'M' }] }], thinkingLevels: [] },
    });
    await open('providers');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-lab-2'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-foreign-lab-2')).not.toBeInTheDocument());
    expect(screen.queryByTestId('mu-provider-item-builtin-lab-2')).not.toBeInTheDocument();
    const user = userEvent.setup();
    fireEvent.click(screen.getByTestId('mu-nav-board-model'));
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    await waitFor(() => expect(document.querySelectorAll('.arco-select-option').length).toBeGreaterThan(0));
    const offered = [...document.querySelectorAll('.arco-select-option')].map((choice) => choice.textContent);
    // A custom provider is offered by its name, not its id.
    expect(offered).toContain('Relay');
    expect(offered).not.toContain('relay');
    expect(offered).not.toContain('lab-2');
    expect(offered).not.toContain('Lab 2');
  });

  it('shows Claude as usable through an API key when mu reported it and nobody is signed in', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] }], thinkingLevels: [] },
    });
    await open('providers');
    const item = await screen.findByTestId('mu-provider-item-account-anthropic');
    await waitFor(() => expect(within(item).getByRole('img', { name: 'Usable (API key)' })).toBeInTheDocument());
    expect(screen.queryByTestId('mu-provider-item-builtin-anthropic')).not.toBeInTheDocument();
    fireEvent.click(item);
    const detail = screen.getByTestId('mu-account-anthropic');
    expect(within(detail).getByTestId('mu-account-state')).toHaveTextContent('Usable (API key)');
    expect(detail).toHaveTextContent('its API key is in the environment');
    expect(detail).toHaveTextContent('Claude X');
    expect(within(detail).getByTestId('mu-account-signin-anthropic')).toBeInTheDocument();
  });

  it('shows a failed sign-in under its own subscription only, not under the one signed out next', async () => {
    bridge.loginStatus.mockResolvedValue({
      ok: true,
      data: { signedIn: [{ provider: 'anthropic', models: [] }] },
    });
    bridge.loginStart.mockResolvedValue({ ok: false, error: 'Timed out' });
    bridge.loginLogout.mockResolvedValue({ ok: true, data: { signedIn: [] } });
    await open('providers');
    fireEvent.click(await screen.findByTestId('mu-provider-item-account-xai'));
    fireEvent.click(screen.getByTestId('mu-account-signin-xai'));
    await waitFor(() => expect(screen.getByTestId('mu-account-xai')).toHaveTextContent('Timed out'));

    fireEvent.click(screen.getByTestId('mu-provider-item-account-anthropic'));
    const claude = screen.getByTestId('mu-account-anthropic');
    await waitFor(() => expect(within(claude).getByTestId('mu-account-state')).toHaveTextContent('Signed in'));
    fireEvent.click(within(claude).getByTestId('mu-account-signout-anthropic'));
    const buttons = await screen.findAllByRole('button', { name: 'Sign out' });
    fireEvent.click(buttons[buttons.length - 1]);
    await waitFor(() => expect(bridge.loginLogout).toHaveBeenCalled());
    await waitFor(() => expect(within(claude).getByTestId('mu-account-state')).toHaveTextContent('Not signed in'));
    expect(claude).not.toHaveTextContent('Timed out');
  });

  it('opens a sign-in that is running, and points to it from another subscription', async () => {
    bridge.loginState.mockResolvedValue({
      ok: true,
      data: {
        id: 3,
        provider: 'xai',
        phase: 'running',
        url: 'https://accounts.x.ai/device',
        device: { userCode: 'ABCD-1234', verificationUri: 'https://accounts.x.ai/device' },
      },
    });
    await open('providers');
    const grok = await screen.findByTestId('mu-account-xai');
    expect(within(grok).getByTestId('mu-login-waiting')).toHaveTextContent('ABCD-1234');
    fireEvent.click(screen.getByTestId('mu-provider-item-account-openai-codex'));
    expect(screen.getByTestId('mu-account-signin-openai-codex')).toBeDisabled();
    const hint = screen.getByTestId('mu-account-other');
    expect(hint).toHaveTextContent('Grok is signing in');
    fireEvent.click(within(hint).getByRole('button', { name: 'Show it' }));
    expect(screen.getByTestId('mu-account-xai')).toBeInTheDocument();
  });

  it('keeps the startup model when the removed entry only rerouted a built-in or subscription provider', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        models: {
          ...base.models,
          foreign: [{ id: 'google-gemini-cli', name: '', api: '', baseUrl: 'https://g.example.com', modelCount: 0 }],
          defaults: { provider: 'google-gemini-cli', model: 'gemini-2.5-pro', thinkingLevel: '' },
        },
      }),
    });
    await open('providers');
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-google-gemini-cli'));
    fireEvent.click(within(screen.getByTestId('mu-provider-foreign')).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    await screen.findByText(/this hand-written entry is deleted from models.json/);
    expect(screen.queryByText(/the default model is cleared too/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(await screen.findByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.models?.removeEntries).toEqual(['google-gemini-cli']);
    expect(sent.models?.defaults.provider).toBe('google-gemini-cli');
  });

  it('leaves a startup model without a provider alone when a provider without an id is removed', async () => {
    const base = settings();
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({ models: { ...base.models, defaults: { provider: '', model: 'gpt-5', thinkingLevel: '' } } }),
    });
    await open('providers');
    fireEvent.click(screen.getByText('Add provider'));
    const editor = screen.getByTestId('mu-provider-editor');
    fireEvent.change(within(editor).getByLabelText('ID'), { target: { value: '' } });
    fireEvent.click(within(editor).getByTestId('mu-provider-more'));
    fireEvent.click(await screen.findByText('Remove provider'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByTestId('mu-provider-item-custom-1')).not.toBeInTheDocument());
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('shows hand-written and reported providers as they are, and locks editing when models.json has comments', async () => {
    const base = settings();
    const models = {
      ...base.models,
      commented: true,
      foreign: [{ id: 'anthropic', name: '', api: '', baseUrl: 'https://p.example.com', modelCount: 0 }],
    };
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ models }) });
    await open('providers');
    expect(screen.getByText(/models.json contains comments/)).toBeInTheDocument();
    expect(screen.getByText('Add provider').closest('button')).toBeDisabled();
    expect(within(screen.getByTestId('mu-provider-editor')).getByTestId('mu-provider-more')).toBeDisabled();
    fireEvent.click(screen.getByTestId('mu-provider-item-foreign-anthropic'));
    const entry = screen.getByTestId('mu-provider-foreign');
    expect(entry).toHaveTextContent('can be removed here but not edited');
    expect(within(entry).getByTestId('mu-provider-more')).toBeDisabled();
    // A read-only model line still opens, to show what it leaves out.
    fireEvent.click(screen.getByTestId('mu-provider-item-custom-0'));
    fireEvent.click(screen.getByRole('button', { name: 'Show plain' }));
    expect(screen.getByLabelText('Max output 1')).toBeDisabled();
    fireEvent.click(await screen.findByTestId('mu-provider-item-builtin-corp-gateway'));
    const reported = screen.getByTestId('mu-provider-builtin');
    expect(reported).toHaveTextContent('cannot be removed here');
    expect(within(reported).queryByTestId('mu-provider-more')).not.toBeInTheDocument();
  });
});

describe('the permission modes and the board', () => {
  /** Settings from a harness with permission modes and a board that can be told its model. */
  function withModes(patch: Partial<KyrnSettings> = {}): KyrnSettings {
    const parsed = parseManifest(withOwnPlaces(manifestJson));
    if (parsed.status !== 'ok') throw new Error('manifest with permission modes is not readable');
    const features = Object.fromEntries(
      parsed.manifest.features.map((feature) => [feature.name, defaultFeatureState(feature)])
    );
    return settings({ harness: parsed, features, ...patch });
  }

  it('sets the mode a new conversation starts in on the permission feature’s own page, and never the picked one', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: withModes({ permissions: { mode: 'ask', from: 'picked' } }) });
    await open('details-safety');
    // There is no page of its own for it any more: the mode is the feature's option, one click from its row.
    expect(screen.queryByTestId('mu-nav-permissions')).not.toBeInTheDocument();
    const row = screen.getByTestId('mu-feature-permissions');
    expect(row).not.toHaveTextContent('chosen under Permissions');
    fireEvent.click(within(row).getByTestId('mu-feature-open-permissions'));
    const page = screen.getByTestId('mu-section-feature-permissions');
    const mode = within(page).getByTestId('mu-option-permissions-mode');
    expect(mode).toHaveTextContent('Mode of a new conversation');
    const user = userEvent.setup();
    await user.click(within(mode).getByLabelText('Mode of a new conversation'));
    fireEvent.click(await screen.findByText('Full access', { selector: '.arco-select-option' }));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Features');
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.features?.permissions.options).toEqual({ mode: 'full' });
    // The mode picked with /permissions has a file of its own, which the settings never write.
    expect(sent).not.toHaveProperty('permissions');
  });

  it('still draws when an older main process sends no permission default and no board model', async () => {
    const { permissions: _permissions, boardModel: _boardModel, ...older } = withModes();
    bridge.settings.mockResolvedValue({ ok: true, data: older as KyrnSettings });
    render(<SettingsArea page='board-model' />, { wrapper });
    expect(await screen.findByTestId('mu-board-model')).toHaveTextContent('Update mu');
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('points from the features to where the board’s model is set, and keeps the mode of a new conversation', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: withModes() });
    await open('details-goal');
    fireEvent.click(screen.getByTestId('mu-feature-open-board'));
    const board = screen.getByTestId('mu-section-feature-board');
    expect(board).toHaveTextContent('The model that writes the board is chosen under Plain-language model.');
    expect(within(board).queryByTestId('mu-option-board-model')).not.toBeInTheDocument();
    expect(within(board).getByTestId('mu-option-board-defaultOn')).toBeInTheDocument();
  });

  it('neither marks nor resets from the features an option set elsewhere, and marks the mode as the feature’s own', async () => {
    const base = withModes();
    const features = {
      ...base.features,
      permissions: { ...base.features.permissions, options: { mode: 'full' } },
      board: { ...base.features.board, options: { ...base.features.board.options, defaultOn: true, model: 'a/b' } },
    };
    bridge.settings.mockResolvedValue({ ok: true, data: { ...base, features } });
    await open('details-safety');
    // The mode differs from the feature's default, and it is this feature's option now.
    expect(within(screen.getByTestId('mu-feature-permissions')).getByTestId('mu-modified')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-nav-details-goal'));
    fireEvent.click(screen.getByTestId('mu-feature-open-board'));
    const board = screen.getByTestId('mu-section-feature-board');
    fireEvent.click(within(board).getByText('Restore defaults'));
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.features?.board.options).toMatchObject({ defaultOn: false, model: 'a/b' });
    expect(sent.features?.permissions.options).toEqual({ mode: 'full' });
  });

  it('draws the sections afresh on discard, so no field keeps a choice that was dropped', async () => {
    bridge.availableModels.mockResolvedValue({
      ok: true,
      data: { providers: [{ id: 'corp-gateway', models: [{ id: 'gpt-5', name: '' }] }], thinkingLevels: [] },
    });
    await open('board-model');
    const user = userEvent.setup();
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Provider'));
    fireEvent.click(await screen.findByText('corp-gateway', { selector: '.arco-select-option' }));
    await user.click(within(screen.getByTestId('mu-board-model')).getByLabelText('Model'));
    fireEvent.click(await screen.findByText('gpt-5', { selector: '.arco-select-option span' }));
    expect(screen.getByTestId('mu-save-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Discard'));
    const card = screen.getByTestId('mu-board-model');
    expect(within(card).queryByText('corp-gateway')).not.toBeInTheDocument();
    expect(card).toHaveTextContent('Pick a provider first');
  });
});

describe('the kernel pages', () => {
  it('starts the judges page with whether verdicts take effect, then the choice; the order is a page of its own', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ tiers: ['jev', 'laya'], mode: 'active' }) });
    render(<SettingsArea page='judges' />, { wrapper });
    const page = await screen.findByTestId('mu-section-judges');
    // The switch every step without a setting of its own follows, first, as a switch.
    const verdicts = within(page).getByTestId('mu-judge-mode');
    expect(within(verdicts).getByRole('switch', { name: enMu.judges.mode })).toBeChecked();
    expect(verdicts).toHaveTextContent(enMu.judges.modeHelp);
    // The three choices, Jev, Laya and CLM, and no second way to pick a judge.
    const choice = within(page).getByTestId('mu-judge-choice-jev');
    expect(verdicts.compareDocumentPosition(choice) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(page).getByTestId('mu-judge-choice-local')).toBeInTheDocument();
    expect(within(page).getByTestId('mu-judge-choice-clm')).toBeInTheDocument();
    // The service and its long help once, in the choice; no order and no model id on this page.
    expect(within(page).getAllByLabelText(enMu.judges.service)).toHaveLength(1);
    expect(page.textContent?.split(enMu.judges.services.auto.help)).toHaveLength(2);
    expect(within(page).queryByTestId('mu-judge-tiers')).not.toBeInTheDocument();
    expect(within(page).queryByLabelText(enMu.judges.model)).not.toBeInTheDocument();
    expect(within(choice).getByLabelText(enMu.judges.services.auto.key)).toBeInTheDocument();
    // Nothing is folded away.
    expect(within(page).queryByText(/Advanced/)).not.toBeInTheDocument();
  });

  it('lists the order by name, and asks of the first judge only what the judges page does not', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ tiers: ['jev', 'laya'] }) });
    render(<SettingsArea page='judge-order' />, { wrapper });
    const page = await screen.findByTestId('mu-section-judgeOrder');
    expect(within(page).getByRole('heading', { name: enMu.sections.judgeOrder })).toBeInTheDocument();
    const order = within(page).getByTestId('mu-judge-tiers');
    expect(order).toHaveTextContent(enMu.judges.orderHelp);
    // The order says the judges' names, never the profiles' ids.
    const tags = [...order.querySelectorAll('.arco-tag')].map((tag) => tag.textContent);
    expect(tags).toEqual([enMu.judges.choices.jev.title, enMu.judges.choices.local.title]);
    expect(order).not.toHaveTextContent(/\bjev\b|\blaya\b/);
    // Jev, first: its model. Its service, address and key are the judges page's.
    const jev = within(page).getByTestId('mu-judge-tier-0');
    expect(jev).toHaveTextContent(`Tier 1: ${enMu.judges.choices.jev.title}`);
    expect(jev).toHaveTextContent(enMu.judges.firstTier);
    expect(within(jev).getByLabelText(enMu.judges.model)).toHaveValue('jev-latest');
    expect(within(jev).queryByLabelText(enMu.judges.service)).not.toBeInTheDocument();
    expect(within(jev).queryByLabelText(enMu.judges.services.auto.key)).not.toBeInTheDocument();
    expect(page).not.toHaveTextContent(enMu.judges.services.auto.help);
    // Laya: its name and nothing to fill in.
    const laya = within(page).getByTestId('mu-judge-tier-1');
    expect(laya).toHaveTextContent(`Tier 2: ${enMu.judges.choices.local.title}`);
    expect(within(laya).queryByRole('textbox')).not.toBeInTheDocument();
    // No variable names, endpoints or timeouts: none of it is a person's decision.
    expect(page).not.toHaveTextContent(/TYPESAFE_API_KEY|AI_GATEWAY_API_KEY|MU_JUDGE_|provider\/model-id/);
    expect(within(page).queryByLabelText('Timeout')).not.toBeInTheDocument();
    expect(within(page).queryByRole('button', { expanded: false })).not.toBeInTheDocument();
  });

  it('keeps each of Jev’s services as a profile of its own: picking one puts that profile in the order', async () => {
    const gateway = {
      type: 'gateway' as const,
      model: 'typesafe-ai/jev',
      baseUrl: '',
      apiKeyEnv: 'AI_GATEWAY_API_KEY',
      timeoutMs: 10000,
    };
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({ judges: { ...settings().judges, 'jev-gateway': gateway } }),
    });
    await open('judges');
    const choice = screen.getByTestId('mu-judge-choice-jev');
    fireEvent.click(within(choice).getByLabelText(enMu.judges.service));
    fireEvent.click(await screen.findByText(enMu.judges.services.gateway.name, { selector: '.arco-select-option' }));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges');
    // The gateway's own model, and still one Jev in the order.
    fireEvent.click(screen.getByTestId('mu-nav-judge-order'));
    expect(within(screen.getByTestId('mu-judge-tier-0')).getByLabelText(enMu.judges.model)).toHaveValue(
      'typesafe-ai/jev'
    );
    expect(screen.queryByTestId('mu-judge-tier-1')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.tiers).toEqual(['jev-gateway']);
  });

  it('shows a base URL only for TypeSafe and a custom service, and accepts a private-network HTTP address', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings() });
    render(<SettingsArea page='judges' />, { wrapper });
    const choice = await screen.findByTestId('mu-judge-choice-jev');
    expect(within(choice).queryByLabelText(enMu.judges.baseUrl)).not.toBeInTheDocument();
    fireEvent.click(within(choice).getByLabelText(enMu.judges.service));
    fireEvent.click(await screen.findByText(enMu.judges.services.typesafe.name, { selector: '.arco-select-option' }));
    const tile = () => screen.getByTestId('mu-judge-choice-jev');
    const field = await within(tile()).findByLabelText(enMu.judges.baseUrl);
    fireEvent.change(field, { target: { value: 'http://example.com/v1' } });
    expect(tile()).toHaveTextContent(enMu.endpointRule);
    fireEvent.change(field, { target: { value: 'http://192.168.31.124:8000/v1/systemone' } });
    expect(tile()).not.toHaveTextContent(enMu.endpointRule);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    // TypeSafe's own profile, made for it: the automatic one keeps no address it never had.
    expect(sent.tiers).toEqual(['jev-direct']);
    expect(sent.judges['jev-direct']).toMatchObject({
      type: 'typesafe',
      baseUrl: 'http://192.168.31.124:8000/v1/systemone',
    });
    expect(sent.judges.jev).toEqual(settings().judges.jev);
  });

  it('asks for the service, address and key of a Jev further down the order, which the judges page does not show', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: settings({ tiers: ['laya', 'jev'], keys: {} }) });
    render(<SettingsArea page='judge-order' />, { wrapper });
    const jev = await screen.findByTestId('mu-judge-tier-1');
    expect(within(jev).getByLabelText(enMu.judges.service)).toBeInTheDocument();
    fireEvent.change(within(jev).getByLabelText(enMu.judges.services.auto.key), { target: { value: 'jev-key' } });
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges');
    // Laya, first, is installed and started from the choice on the judges page: no panel for it here.
    expect(within(screen.getByTestId('mu-judge-tier-0')).queryByTestId('mu-laya')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('mu-laya')).toHaveLength(0);
  });

  it('reaches Jev through OpenRouter from the choice, with OpenRouter’s own key and nothing typed for another', async () => {
    const openRouter = {
      type: 'typesafe' as const,
      model: '~typesafe/jev-latest',
      baseUrl: 'https://openrouter.ai/api/v1/systemone',
      apiKeyEnv: 'MU_JUDGE_OPENROUTER_API_KEY',
      timeoutMs: 10000,
    };
    // As the store sends it: the built-in profile, and the state of its key.
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        judges: { ...settings().judges, 'jev-openrouter': openRouter },
        keys: { TYPESAFE_API_KEY: false, MU_JUDGE_OPENROUTER_API_KEY: false },
      }),
    });
    await open('judges');
    const choice = screen.getByTestId('mu-judge-choice-jev');
    // Automatic, first: TypeSafe's key. A key typed there stays TypeSafe's.
    expect(within(choice).getByLabelText(enMu.judges.service)).toBeInTheDocument();
    expect(choice).toHaveTextContent(enMu.judges.services.auto.help);
    fireEvent.change(within(choice).getByLabelText(enMu.judges.services.auto.key), {
      target: { value: 'typesafe-key' },
    });
    fireEvent.click(within(choice).getByLabelText(enMu.judges.service));
    fireEvent.click(await screen.findByText(enMu.judges.services.openrouter.name, { selector: '.arco-select-option' }));
    const key = await within(screen.getByTestId('mu-judge-choice-jev')).findByLabelText(
      enMu.judges.services.openrouter.key
    );
    expect(key).toHaveValue('');
    // OpenRouter's address is its own: nothing to type.
    expect(
      within(screen.getByTestId('mu-judge-choice-jev')).queryByLabelText(enMu.judges.baseUrl)
    ).not.toBeInTheDocument();
    fireEvent.change(key, { target: { value: 'openrouter-key' } });
    fireEvent.click(screen.getByTestId('mu-nav-judge-order'));
    expect(within(screen.getByTestId('mu-judge-tier-0')).getByLabelText(enMu.judges.model)).toHaveValue(
      '~typesafe/jev-latest'
    );
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.tiers).toEqual(['jev-openrouter']);
    expect(sent.credentials).toEqual([
      { name: 'TYPESAFE_API_KEY', value: 'typesafe-key' },
      { name: 'MU_JUDGE_OPENROUTER_API_KEY', value: 'openrouter-key' },
    ]);
  });

  it('asks a custom service for its address, and says why it cannot be saved without one', async () => {
    render(<SettingsArea page='judges' />, { wrapper });
    const choice = await screen.findByTestId('mu-judge-choice-jev');
    fireEvent.click(within(choice).getByLabelText(enMu.judges.service));
    fireEvent.click(await screen.findByText(enMu.judges.services.custom.name, { selector: '.arco-select-option' }));
    const tile = screen.getByTestId('mu-judge-choice-jev');
    const address = await within(tile).findByLabelText(enMu.judges.baseUrl);
    // Empty: the problem, in the choice, the one place the address is typed.
    expect(within(tile).getByRole('alert')).toHaveTextContent(enMu.judges.baseUrlNeeded);
    expect(address).toHaveClass('arco-input-error');
    fireEvent.change(within(tile).getByLabelText(enMu.judges.services.custom.key), { target: { value: 'relay-key' } });
    // The store refuses it, and the save bar says so in words.
    bridge.save.mockResolvedValueOnce({
      ok: false,
      code: 'judgeEndpoint',
      params: { name: 'jev-custom' },
      error: 'Judge jev-custom has no base URL, and its key is not sent to TypeSafe',
    });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText(`Not saved: ${enMu.errors.judgeEndpoint}`)).toBeInTheDocument();
    // An address a key must not go to is the other problem; a private-network one is fine.
    fireEvent.change(address, { target: { value: 'http://relay.example.com/v1/systemone' } });
    expect(within(tile).getByRole('alert')).toHaveTextContent(enMu.endpointRule);
    fireEvent.change(address, { target: { value: 'http://192.168.1.20:8000/v1/systemone' } });
    expect(within(tile).queryByRole('alert')).not.toBeInTheDocument();
    expect(tile).toHaveTextContent(enMu.judges.customUrlHelp);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(2));
    const sent = bridge.save.mock.calls[1][0] as SaveSettings;
    expect(sent.tiers).toEqual(['jev-custom']);
    expect(sent.judges['jev-custom']).toMatchObject({
      type: 'typesafe',
      baseUrl: 'http://192.168.1.20:8000/v1/systemone',
      apiKeyEnv: 'MU_JUDGE_CUSTOM_API_KEY',
    });
    expect(sent.credentials).toEqual([{ name: 'MU_JUDGE_CUSTOM_API_KEY', value: 'relay-key' }]);
  });

  it('asks CLM, chosen, for its server’s address and says how the server is, once, with the address rule', async () => {
    const clm = {
      type: 'clm' as const,
      model: 'clm-latest',
      baseUrl: '',
      apiKeyEnv: 'MU_JUDGE_CLM_API_KEY',
      timeoutMs: 8000,
    };
    // As the store sends it: the built-in profile, and the state of its key.
    bridge.settings.mockResolvedValue({
      ok: true,
      data: settings({
        judges: { ...settings().judges, clm },
        keys: { TYPESAFE_API_KEY: true, MU_JUDGE_CLM_API_KEY: false },
      }),
    });
    bridge.clmCheck.mockResolvedValue({
      ok: true,
      data: { status: 'ready', models: ['clm-latest', 'clm-raw'], mock: false, keyRequired: false, latencyMs: 12 },
    });
    await open('judges');
    fireEvent.click(screen.getByTestId('mu-judge-choice-clm'));
    const tile = screen.getByTestId('mu-judge-choice-clm');
    expect(tile).toHaveAttribute('aria-checked', 'true');
    // Empty is clm-serve's own address on this machine, and the server there is asked.
    const address = within(tile).getByLabelText(enMu.judges.clm.address);
    expect(address).toHaveValue('');
    expect(tile).toHaveTextContent('Empty is this computer (http://127.0.0.1:8700).');
    await waitFor(() =>
      expect(within(tile).getByTestId('mu-clm-status')).toHaveTextContent('Answering · clm-latest and clm-raw · 12 ms')
    );
    expect(bridge.clmCheck).toHaveBeenCalledWith({ baseUrl: '' });
    expect(tile).toHaveTextContent(enMu.judges.clm.unmeasured);
    expect(screen.getAllByTestId('mu-clm-server')).toHaveLength(1);
    // A public address over plain HTTP breaks the rule, and is not asked.
    bridge.clmCheck.mockClear();
    fireEvent.change(address, { target: { value: 'http://example.com:8700' } });
    expect(within(tile).getByRole('alert')).toHaveTextContent(enMu.endpointRule);
    expect(screen.queryByTestId('mu-clm-server')).not.toBeInTheDocument();
    // A private-network one is fine, and asked.
    fireEvent.change(address, { target: { value: 'http://192.168.1.20:8700' } });
    expect(within(tile).queryByRole('alert')).not.toBeInTheDocument();
    await waitFor(() => expect(bridge.clmCheck).toHaveBeenCalledWith({ baseUrl: 'http://192.168.1.20:8700' }));
    expect(bridge.clmCheck).toHaveBeenCalledTimes(1);
    fireEvent.change(within(tile).getByLabelText(enMu.judges.clm.key), { target: { value: 'clm-key' } });
    // The order: CLM by its name and its model. Its address, key and server are the choice's.
    fireEvent.click(screen.getByTestId('mu-nav-judge-order'));
    const tier = screen.getByTestId('mu-judge-tier-0');
    expect(tier).toHaveTextContent(`Tier 1: ${enMu.judges.choices.clm.title}`);
    expect(tier).toHaveTextContent(enMu.judges.firstTier);
    expect(within(tier).getByLabelText(enMu.judges.model)).toHaveValue('clm-latest');
    expect(within(tier).queryByLabelText(enMu.judges.clm.address)).not.toBeInTheDocument();
    expect(within(tier).queryByLabelText(enMu.judges.clm.key)).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-clm-server')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalled());
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.tiers).toEqual(['clm']);
    expect(sent.judges.clm).toMatchObject({ type: 'clm', baseUrl: 'http://192.168.1.20:8700' });
    expect(sent.credentials).toEqual([{ name: 'MU_JUDGE_CLM_API_KEY', value: 'clm-key' }]);
  });

  it('puts the switches that carry the product on the core features page, each with the way to its row', async () => {
    await open('features');
    const featured = screen.getByTestId('mu-feature-list-features');
    // The fixture harness has four of the six; the others simply are not there.
    expect(
      within(featured)
        .getAllByTestId(/^mu-feature-[a-z]+$/)
        .map((row) => row.dataset.testid)
    ).toEqual(['mu-feature-swarm', 'mu-feature-hive', 'mu-feature-memory', 'mu-feature-forgetting']);
    // A shortcut, not a second set: the options and the decision points are on the feature's row in the details.
    expect(within(featured).queryByTestId(/^mu-feature-open-/)).not.toBeInTheDocument();
    expect(within(featured).queryByTestId(/^mu-decision-/)).not.toBeInTheDocument();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      fireEvent.click(within(screen.getByTestId('mu-feature-hive')).getByRole('button', { name: 'Hive: Details' }));
      const row = screen.getByTestId('mu-feature-hive');
      expect(row.closest('[data-testid="mu-section-details-team"]')).not.toBeNull();
      expect(row).toHaveAttribute('data-focused', 'true');
      expect(scroll.mock.contexts).toContain(row);
      expect(within(row).getByTestId('mu-decision-hive.deliver')).toBeInTheDocument();
    } finally {
      scroll.mockRestore();
    }
  });

  it('writes a switch straight into the draft, and says which page is unsaved', async () => {
    render(<SettingsArea page='features' />, { wrapper });
    const swarm = await screen.findByTestId('mu-feature-swarm');
    const control = within(swarm).getByRole('switch');
    const before = control.getAttribute('aria-checked');
    fireEvent.click(control);
    expect(within(swarm).getByRole('switch').getAttribute('aria-checked')).not.toBe(before);
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Features');
  });
});

describe('one draft across the settings pages', () => {
  /** A route change draws the page afresh, as the app's route boundary does. */
  function Fresh({ children }: { children: React.ReactNode }) {
    const { pathname } = useLocation();
    return <React.Fragment key={pathname}>{children}</React.Fragment>;
  }
  function Where() {
    const { pathname, search } = useLocation();
    return <output data-testid='where'>{`${pathname}${search}`}</output>;
  }
  /** The browser's way back. */
  function Back() {
    const navigate = useNavigate();
    return (
      <button type='button' onClick={() => void navigate(-1)}>
        back
      </button>
    );
  }
  function renderSettings(path: string) {
    const page = (
      <Fresh>
        <MuSettingsPage />
      </Fresh>
    );
    return render(
      <MemoryRouter initialEntries={[path]}>
        <nav>
          <Link to='/settings/judges'>judges</Link>
          <Link to='/settings/details-safety'>safety</Link>
          <Link to='/settings/appearance'>appearance</Link>
          <Back />
        </nav>
        <Where />
        <Routes>
          <Route
            element={
              <MuSettingsProvider>
                <Outlet />
              </MuSettingsProvider>
            }
          >
            <Route path='/settings/appearance' element={<div data-testid='appearance'>appearance</div>} />
            {MOVED_FEATURE_LISTS.map((list) => (
              <Route key={list} path={`${list}/:feature/:part?`} element={<MovedFeatureOptions />} />
            ))}
            <Route path='/settings/:page' element={page} />
            <Route path='/settings/:page/:feature' element={page} />
            <Route path='/settings/:page/:feature/:part' element={page} />
          </Route>
        </Routes>
      </MemoryRouter>,
      { wrapper }
    );
  }

  it('keeps an edit made on one page, unsaved, on the next and after a page that is not mu’s', async () => {
    renderSettings('/settings/judges');
    fireEvent.click(await screen.findByTestId('mu-judge-choice-local'));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges');

    fireEvent.click(screen.getByRole('link', { name: 'safety' }));
    // Another page, drawn afresh: the draft is the same one.
    expect(await screen.findByTestId('mu-section-details-safety')).toBeInTheDocument();
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges');
    fireEvent.click(within(screen.getByTestId('mu-decision-tool.risk')).getByRole('switch'));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Judges and Decision points');

    fireEvent.click(screen.getByRole('link', { name: 'appearance' }));
    expect(await screen.findByTestId('appearance')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'judges' }));
    expect(await screen.findByTestId('mu-judge-choice-local')).toHaveAttribute('aria-checked', 'true');
    // Loaded once for all the pages, and saved once for all of them.
    expect(bridge.settings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const sent = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(sent.tiers).toEqual(['laya']);
    expect(sent.decisionModes).toEqual({ 'tool.risk': 'active' });
  });

  it('opens a feature’s options at a route of its own, and goes back to its page', async () => {
    renderSettings('/settings/details-input');
    fireEvent.click(await screen.findByTestId('mu-feature-open-preflight'));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/details-input/preflight');
    const page = await screen.findByTestId('mu-section-feature-preflight');
    fireEvent.click(within(page).getByRole('switch', { name: 'Show the wait and the verdict' }));
    fireEvent.click(screen.getByTestId('mu-feature-back'));
    expect(await screen.findByTestId('mu-section-details-input')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-input$/);
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Features');
  });

  it('opens a feature’s page from a link as well, and its way back is the page its row is on', async () => {
    renderSettings('/settings/details-team/swarm');
    const page = await screen.findByTestId('mu-section-feature-swarm');
    expect(within(page).getByRole('switch', { name: 'Sub-agents' })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-feature-back'));
    expect(await screen.findByTestId('mu-section-details-team')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-team$/);
  });

  it('leads from a core feature to its row among the details, and back to the core features', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    try {
      renderSettings('/settings/features');
      fireEvent.click(await screen.findByTestId('mu-feature-area-memory'));
      expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-memory\?feature=memory$/);
      const row = await screen.findByTestId('mu-feature-memory');
      expect(row).toHaveAttribute('data-focused', 'true');
      expect(scroll.mock.contexts).toContain(row);
      // The same switch on both pages: one setting.
      fireEvent.click(within(row).getByRole('switch', { name: 'Lessons' }));
      fireEvent.click(screen.getByRole('button', { name: 'back' }));
      expect(await screen.findByTestId('mu-section-features')).toBeInTheDocument();
      expect(
        within(screen.getByTestId('mu-feature-memory')).getByRole('switch', { name: 'Lessons' })
      ).not.toBeChecked();
      expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Features');
    } finally {
      scroll.mockRestore();
    }
  });

  it('puts the compaction settings on top of the context page, then its features, still within a page', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: realShaped() });
    renderSettings('/settings/details-context');
    const section = await screen.findByTestId('mu-section-details-context');
    expect(within(section).getByRole('heading', { level: 1, name: 'Context' })).toBeInTheDocument();
    const compaction = within(section).getByTestId('mu-context-rows');
    const auto = within(compaction).getByRole('switch', { name: 'Automatic compaction' });
    expect(within(compaction).getByLabelText('Context cap')).toBeInTheDocument();
    const list = within(section).getByTestId('mu-feature-list-context');
    expect(compaction.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const rows =
      within(list).getAllByTestId(/^mu-feature-[a-z]+$/).length + within(list).getAllByTestId(/^mu-decision-/).length;
    expect(rows + 2).toBeLessThanOrEqual(PAGE_ROWS);
    // A compaction change is the context's in the save bar; a point's is the decision points'.
    fireEvent.click(auto);
    fireEvent.click(within(screen.getByTestId('mu-decision-context.forget')).getByRole('switch'));
    expect(screen.getByTestId('mu-save-bar')).toHaveTextContent('Unsaved changes in: Decision points and Context');
  });

  it('gives the lessons a page of their own, so the context page stays within a page', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: realShaped() });
    renderSettings('/settings/details-context');
    const context = await screen.findByTestId('mu-feature-list-context');
    expect(within(context).queryByTestId('mu-decision-memory.recall')).not.toBeInTheDocument();
    cleanup();
    renderSettings('/settings/details-memory');
    const lessons = await screen.findByTestId('mu-feature-memory');
    expect(within(lessons).getAllByTestId(/^mu-decision-memory\./)).toHaveLength(6);
    expect(screen.getByRole('heading', { level: 1, name: 'Lessons' })).toBeInTheDocument();
  });

  it('leaves the terminal’s welcome box off the Other page: nothing in the app shows what it changes', async () => {
    renderSettings('/settings/details-other');
    const other = await screen.findByTestId('mu-feature-list-other');
    expect(within(other).getByTestId('mu-feature-background')).toBeInTheDocument();
    expect(screen.queryByTestId('mu-feature-welcome')).not.toBeInTheDocument();
    expect(screen.queryByText('Welcome screen')).not.toBeInTheDocument();
  });

  it.each(DETAIL_AREAS)('shows the features of %s on a page of its own, in one list, within a page', async (area) => {
    renderSettings(`/settings/details-${area}`);
    const section = await screen.findByTestId(`mu-section-details-${area}`);
    const rows =
      within(section).queryAllByTestId(/^mu-feature-[a-zA-Z]+$/).length +
      within(section).queryAllByTestId(/^mu-decision-[a-z.-]+$/).length;
    expect(rows).toBeLessThanOrEqual(PAGE_ROWS);
    // One list, titled by its page: no group headings inside it; the mode the points follow is the judges page's.
    expect(screen.queryAllByRole('heading', { level: 3 })).toHaveLength(0);
    expect(within(section).queryByTestId('mu-judge-mode')).not.toBeInTheDocument();
  });

  it('puts the options of a feature with more than a page of them on pages, and the way back is its page', async () => {
    bridge.settings.mockResolvedValue({ ok: true, data: realShaped() });
    renderSettings('/settings/details-tools');
    fireEvent.click(await screen.findByTestId('mu-feature-open-packs'));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-tools\/packs$/);
    const first = await screen.findByTestId('mu-section-feature-packs');
    expect(within(first).getByTestId('mu-feature-parts')).toHaveTextContent('Options, page 1 of 2');
    expect(within(first).getAllByTestId(/^mu-option-packs-/)).toHaveLength(9);
    expect(within(first).getByTestId('mu-option-packs-review')).toBeInTheDocument();
    expect(within(first).queryByTestId('mu-option-packs-debugger')).not.toBeInTheDocument();
    expect(within(first).getByTestId('mu-feature-part-previous')).toBeDisabled();

    fireEvent.click(within(first).getByTestId('mu-feature-part-next'));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/details-tools/packs/2');
    const second = await screen.findByTestId('mu-section-feature-packs');
    expect(within(second).getByTestId('mu-feature-parts')).toHaveTextContent('Options, page 2 of 2');
    expect(within(second).getAllByTestId(/^mu-option-packs-/)).toHaveLength(9);
    expect(within(second).getByTestId('mu-option-packs-debugger')).toBeInTheDocument();
    expect(within(second).getByTestId('mu-feature-part-next')).toBeDisabled();

    // The pages of options take each other's place: back leads to the list, not to the first page.
    fireEvent.click(screen.getByTestId('mu-feature-back'));
    expect(await screen.findByTestId('mu-section-details-tools')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-tools$/);
  });

  it.each([
    ['/settings/more-features/preflight', '/settings/details-input/preflight'],
    ['/settings/more-features-input/preflight', '/settings/details-input/preflight'],
    ['/settings/more-features-tools/locate', '/settings/details-tools/locate'],
    ['/settings/more-features-turn/notify', '/settings/details-turn/notify'],
    ['/settings/features/swarm', '/settings/details-team/swarm'],
    ['/settings/more-features/swarm', '/settings/details-team/swarm'],
    ['/settings/more-features-context/memory', '/settings/details-memory/memory'],
  ])('sends the old link %s to the feature’s options on the page of its area', async (link, target) => {
    renderSettings(link);
    const feature = target.split('/').at(-1)!;
    expect(await screen.findByTestId(`mu-section-feature-${feature}`)).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(new RegExp(`^${target}$`));
  });

  it('sends an old link to a feature the harness no longer has to the first page of the details', async () => {
    renderSettings('/settings/more-features/gone?x=1');
    expect(await screen.findByTestId('mu-section-details-input')).toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/settings\/details-input\?x=1$/);
  });
});
