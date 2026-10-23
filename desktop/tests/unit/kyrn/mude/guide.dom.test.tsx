import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MudeState, MudeStatus, MudeTask } from '@/common/kyrn/mude';
import type { KyrnSettings, Result, SaveSettings } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import enSettings from '@/renderer/services/i18n/locales/en-US/settings.json';
import Welcome from '@/renderer/pages/welcome';

/**
 * mude in the first-run guide's judge step: set up where it is picked, through `mu judge mude` (played by the test),
 * and the guide's one save at the end keeping what that command wrote to mu.json.
 */

const bridge = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  availableModels: vi.fn(),
  importList: vi.fn(),
  loginStatus: vi.fn(),
  loginState: vi.fn(),
  localJudgeState: vi.fn(),
  mudeState: vi.fn(),
  mudeRun: vi.fn(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    settings: { invoke: bridge.settings },
    save: { invoke: bridge.save },
    availableModels: { invoke: bridge.availableModels },
    importList: { invoke: bridge.importList },
    loginStatus: { invoke: bridge.loginStatus },
    loginState: { invoke: bridge.loginState },
    localJudgeState: { invoke: bridge.localJudgeState },
    mudeState: { invoke: bridge.mudeState },
    mudeRun: { invoke: bridge.mudeRun },
  },
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));
const recheck = vi.hoisted(() => ({ recheckMu: vi.fn(async () => undefined) }));
vi.mock('@/renderer/pages/settings/KyrnSettings/recheck', () => recheck);
vi.mock('@/renderer/components/settings/LanguageSwitcher', () => ({
  default: () => <div data-testid='language-switcher' />,
}));

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu, settings: enSettings } } },
    interpolation: { escapeValue: false },
  });
});

const GB = 1024 ** 3;
const MUDE_PROFILE = {
  type: 'typesafe' as const,
  model: 'mude',
  baseUrl: 'http://127.0.0.1:8790/v1/systemone',
  apiKeyEnv: 'MU_JUDGE_MUDE_KEY',
  timeoutMs: 4000,
};

/** Someone who just installed mu: Jev as the judge, with no key yet. */
function newUser(patch: Partial<KyrnSettings> = {}): KyrnSettings {
  return {
    revision: 'r1',
    tiers: ['jev'],
    judges: {
      jev: { type: 'jev', model: 'jev-latest', baseUrl: '', apiKeyEnv: 'TYPESAFE_API_KEY', timeoutMs: 10000 },
      mude: MUDE_PROFILE,
      laya: { type: 'local', model: '', baseUrl: 'http://127.0.0.1:47823', apiKeyEnv: '', timeoutMs: 4000 },
    },
    mode: 'active',
    betaCompression: false,
    autoCompaction: true,
    maxContextTokens: 0,
    keys: { TYPESAFE_API_KEY: false },
    harness: { status: 'missing' },
    decisionModes: {},
    features: {},
    models: {
      providers: [],
      foreign: [],
      defaults: { provider: '', model: '', thinkingLevel: '' },
      commented: false,
      problem: '',
    },
    permissions: { mode: '', from: 'default' },
    boardModel: { supported: false, model: '' },
    ...patch,
  } as KyrnSettings;
}

/** What mu.json says once `mu judge mude install` ended: mude first, Jev behind it, a new revision. */
const afterInstall = () =>
  newUser({ revision: 'r2', tiers: ['mude', 'jev'], keys: { TYPESAFE_API_KEY: false, MU_JUDGE_MUDE_KEY: true } });

const NOT_INSTALLED: MudeStatus = {
  supported: true,
  problems: [],
  installed: false,
  pythonReady: false,
  running: false,
  ready: false,
  port: 8790,
  enabled: false,
  localOnly: false,
  fallback: [],
  model: 'mude',
  folder: '/Users/someone/.mu/mude',
  log: '/Users/someone/.mu/mude/server.log',
};
const RUNNING: MudeStatus = {
  ...NOT_INSTALLED,
  installed: true,
  pythonReady: true,
  running: true,
  ready: true,
  enabled: true,
  fallback: ['jev'],
};

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const state = (status?: MudeStatus, task?: MudeTask): Result<MudeState> =>
  ok({ available: true, ...(status ? { status } : {}), ...(task ? { task } : {}) });
/** Task ids grow across the file: a finished command is handed on only once. */
let nextId = 500;
const task = (command: MudeTask['command'], phase: MudeTask['phase'], patch: Partial<MudeTask> = {}): MudeTask => ({
  id: nextId++,
  command,
  phase,
  log: [],
  ...patch,
});

beforeEach(() => {
  localStorage.clear();
  bridge.settings.mockResolvedValue(ok(newUser()));
  bridge.availableModels.mockResolvedValue(ok({ providers: [], thinkingLevels: [] }));
  bridge.importList.mockResolvedValue(ok({ conversations: [] }));
  bridge.loginStatus.mockResolvedValue(ok({ signedIn: [] }));
  bridge.loginState.mockResolvedValue(ok({ id: 0, phase: 'idle' }));
  bridge.localJudgeState.mockResolvedValue(
    ok({ support: 'ok', installed: true, running: true, url: 'http://127.0.0.1:47823' })
  );
  bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED));
  bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED));
  // The store answers with what it was given, under a new revision.
  bridge.save.mockImplementation(async ({ models, credentials: _credentials, ...input }: SaveSettings) => {
    const base = newUser();
    return ok({ ...base, ...input, revision: 'r3', models: { ...base.models, ...models } });
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The guide, on its judge step (the model step skipped). */
async function judgeStep() {
  render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={['/welcome']}>
        <Routes>
          <Route path='/welcome' element={<Welcome />} />
          <Route path='/guid' element={<div>landing page</div>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>
  );
  fireEvent.click(await screen.findByTestId('mu-welcome-begin'));
  fireEvent.click(await screen.findByTestId('mu-welcome-skip'));
  const step = await screen.findByTestId('mu-welcome-step-judge');
  return { step, tile: within(step).getByTestId('mu-judge-choice-mude') };
}

/** On to the last step, and Start: what the guide saved. */
async function finish(): Promise<SaveSettings> {
  fireEvent.click(screen.getByTestId('mu-welcome-next'));
  await screen.findByTestId('mu-welcome-step-done');
  fireEvent.click(screen.getByTestId('mu-welcome-start'));
  await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
  await screen.findByText('landing page');
  return bridge.save.mock.calls[0][0] as SaveSettings;
}

describe('mude in the first-run guide', () => {
  it('is offered beside Jev, Laya and No judge, and says what installing takes before the one button', async () => {
    const { step, tile } = await judgeStep();
    const tiles = within(step)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('data-testid'));
    expect(tiles).toEqual([
      'mu-judge-choice-jev',
      'mu-judge-choice-mude',
      'mu-judge-choice-local',
      'mu-welcome-judge-none',
    ]);
    expect(tile).toHaveTextContent('mude');
    expect(tile).toHaveTextContent('On this Mac');
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(within(step).getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'false');
    expect(tile).toHaveTextContent(
      'About 1.8 GB to download, plus a Python environment of about 1.0 GB. It runs on this Mac and uses about 4 GB of memory while running.'
    );
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    // With the judges behind it, as usual: no "only local" in the guide.
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install' }));
  });

  it('on a machine that cannot run it: dimmed, says why and what mu does instead, and never in the way', async () => {
    bridge.mudeState.mockResolvedValue(
      state({
        ...NOT_INSTALLED,
        supported: false,
        problems: ['it needs Apple silicon (an M1 or newer); this Mac has an Intel processor'],
      })
    );
    const { tile } = await judgeStep();
    await waitFor(() => expect(tile).toHaveAttribute('aria-disabled', 'true'));
    expect(within(tile).getByTestId('mu-mude-unsupported')).toHaveTextContent(
      'mude needs a Mac with Apple silicon, macOS 14 or later and 8 GB of memory. mu uses the hosted judge instead.'
    );
    expect(tile).toHaveTextContent('this Mac has an Intel processor');
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'true');
    // Off macOS mude is not offered at all: the same tile, the same words, and the guide goes on.
    cleanup();
    bridge.mudeState.mockResolvedValue(ok({ available: false }));
    const off = await judgeStep();
    await waitFor(() => expect(off.tile).toHaveAttribute('aria-disabled', 'true'));
    expect(off.tile).toHaveTextContent('mu uses the hosted judge instead.');
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent('Jev');
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await screen.findByText('landing page');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
  });

  it('shows the install’s progress with the step it is on', async () => {
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    bridge.mudeRun.mockResolvedValue(
      state(
        NOT_INSTALLED,
        task('install', 'running', {
          step: 'download',
          message: 'Downloading mude and checking every file',
          download: { file: 'model.safetensors', done: 0.45 * GB, total: 1.8 * GB, checking: false },
        })
      )
    );
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    const progress = await within(tile).findByTestId('mu-mude-progress');
    expect(progress).toHaveTextContent('25%');
    expect(progress).toHaveTextContent('0.5 of 1.8 GB');
    expect(tile).toHaveTextContent('Downloading mude and checking every file');
    expect(within(tile).getByTestId('mu-mude-cancel')).toBeInTheDocument();
    expect(within(tile).queryByTestId('mu-mude-install')).not.toBeInTheDocument();
  });

  it('says when the model is not available for download yet, and tries again', async () => {
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    bridge.mudeRun.mockResolvedValue(
      state(
        NOT_INSTALLED,
        task('install', 'failed', { error: { message: 'Hugging Face refused the download (401)', kind: 'access' } })
      )
    );
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    expect(await within(tile).findByTestId('mu-mude-failed')).toHaveTextContent(
      "mude isn't available for download yet. Try again later."
    );
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-retry'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledTimes(2));
    expect(bridge.mudeRun).toHaveBeenLastCalledWith({ action: 'install' });
  });

  it('once installed it is the judge, and the guide’s one save keeps mude first with the rest of the guide', async () => {
    const { step, tile } = await judgeStep();
    // A key typed for Jev before mude was picked: it is saved too.
    fireEvent.click(within(step).getByTestId('mu-welcome-judge-more'));
    fireEvent.change(within(step).getByLabelText('TypeSafe API key'), { target: { value: 'jev-key' } });
    fireEvent.click(tile);
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install' }));
    // The command ends: it wrote mu.json itself.
    bridge.settings.mockResolvedValue(ok(afterInstall()));
    bridge.mudeState.mockResolvedValue(state(RUNNING, task('install', 'done')));
    expect(await within(tile).findByTestId('mu-mude-ready', {}, { timeout: 3000 })).toHaveTextContent(
      'mude is running and is your judge.'
    );
    expect(tile).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent('mude');
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    const saved = bridge.save.mock.calls[0][0] as SaveSettings;
    expect(saved.tiers[0]).toBe('mude');
    expect(saved.tiers).toEqual(['mude', 'jev']);
    expect(saved.mode).toBe('active');
    // Saved on the files as the command left them: no refusal as stale.
    expect(saved.revision).toBe('r2');
    expect(saved.credentials).toEqual([{ name: 'TYPESAFE_API_KEY', value: 'jev-key' }]);
    // mude is the judge: its server keeps running.
    expect(bridge.mudeRun).not.toHaveBeenCalledWith({ action: 'stop' });
    await screen.findByText('landing page');
  });

  it('keeps a judge picked after mude was installed, and stops mude’s server, which then serves nobody', async () => {
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    bridge.settings.mockResolvedValue(ok(afterInstall()));
    bridge.mudeState.mockResolvedValue(state(RUNNING, task('install', 'done')));
    await within(tile).findByTestId('mu-mude-ready', {}, { timeout: 3000 });
    // No judge after all.
    fireEvent.click(screen.getByTestId('mu-welcome-judge-none'));
    expect(screen.getByTestId('mu-welcome-judge-none')).toHaveAttribute('aria-checked', 'true');
    expect(tile).toHaveAttribute('aria-checked', 'false');
    bridge.mudeRun.mockResolvedValue(state(RUNNING));
    const saved = await finish();
    expect(saved.mode).toBe('off');
    expect(saved.revision).toBe('r2');
    expect(bridge.mudeRun).toHaveBeenLastCalledWith({ action: 'stop' });
  });

  it('skipped, or left for another judge before installing, keeps the judge from before', async () => {
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    fireEvent.click(screen.getByTestId('mu-welcome-skip'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent('Jev');
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await screen.findByText('landing page');
    // Nothing was changed: nothing to save, and no command ran.
    expect(bridge.save).not.toHaveBeenCalled();
    expect(bridge.mudeRun).not.toHaveBeenCalled();

    cleanup();
    const again = await judgeStep();
    fireEvent.click(again.tile);
    fireEvent.click(screen.getByTestId('mu-judge-choice-local'));
    expect(again.tile).toHaveAttribute('aria-checked', 'false');
    const saved = await finish();
    expect(saved.tiers).toEqual(['laya']);
  });
});
