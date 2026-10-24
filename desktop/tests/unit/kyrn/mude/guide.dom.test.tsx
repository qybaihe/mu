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

/** The model's size in bytes, as the command counts its download. */
const MODEL_BYTES = 1_782_005_734;
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

/** The judge step's choices, in the order shown. */
const tilesOf = (step: HTMLElement) =>
  within(step)
    .getAllByRole('radio')
    .map((radio) => radio.getAttribute('data-testid'));

/** Today's order, where mude is not the recommended judge. */
const USUAL_ORDER = ['mu-judge-choice-jev', 'mu-judge-choice-mude', 'mu-judge-choice-local', 'mu-welcome-judge-none'];
/** On a Mac that can run mude: mude first, then the others in their usual order. */
const MUDE_FIRST = ['mu-judge-choice-mude', 'mu-judge-choice-jev', 'mu-judge-choice-local', 'mu-welcome-judge-none'];

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
  it('on a Mac that can run it: first, recommended and already picked, installed only on a click', async () => {
    const { step, tile } = await judgeStep();
    // The status, read as the guide opened, says this Mac can run mude.
    await waitFor(() => expect(tilesOf(step)).toEqual(MUDE_FIRST), { timeout: 3000 });
    expect(tile).toHaveTextContent('mude 1.0');
    expect(within(tile).getByText('Recommended · on this Mac')).toBeInTheDocument();
    // Jev says what it is instead of being the recommended one.
    const jev = within(step).getByTestId('mu-judge-choice-jev');
    expect(within(jev).getByText('Hosted')).toBeInTheDocument();
    expect(within(jev).queryByText('Recommended')).not.toBeInTheDocument();
    // Picked without a click, with its one button right there; nothing is started by itself.
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(jev).toHaveAttribute('aria-checked', 'false');
    expect(within(step).queryByTestId('mu-welcome-judge-ready')).not.toBeInTheDocument();
    expect(tile).toHaveTextContent(enMu.judges.choices.mude.description);
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(
      '1.8 GB to download, plus a 1.0 GB Python environment. Uses about 4 GB of memory while running.'
    );
    // The memory it takes is said once.
    expect(tile.textContent?.match(/GB of memory/g)).toHaveLength(1);
    // Nothing on disk yet: a fresh install, with what it takes said right above.
    expect(within(tile).getByTestId('mu-mude-install')).toHaveTextContent('Install mude 1.0');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    // With the judges behind it, as usual: no "only local" in the guide.
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install' }));
  });

  it('picked but not installed, Next leaves the judge from before: the free Jev', async () => {
    const { tile } = await judgeStep();
    await waitFor(() => expect(tile).toHaveAttribute('aria-checked', 'true'), { timeout: 3000 });
    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent('Jev');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent(enMu.welcome.done.freeJev);
    fireEvent.click(screen.getByTestId('mu-welcome-start'));
    await screen.findByText('landing page');
    // Nothing was changed: nothing to save, and no command ran.
    expect(bridge.save).not.toHaveBeenCalled();
    expect(bridge.mudeRun).not.toHaveBeenCalled();
  });

  it('keeps Jev when it is picked before the status is read, also once it says mude can run here', async () => {
    // The status is not read yet: it is answered further down.
    const status: { answer?: (result: Result<MudeState>) => void } = {};
    bridge.mudeState.mockReturnValue(
      new Promise<Result<MudeState>>((resolve) => {
        status.answer = resolve;
      })
    );
    const { step, tile } = await judgeStep();
    // Not known yet: the usual order and tags, with the judge the files have.
    expect(tilesOf(step)).toEqual(USUAL_ORDER);
    const jev = within(step).getByTestId('mu-judge-choice-jev');
    expect(within(jev).getByText('Recommended')).toBeInTheDocument();
    expect(jev).toHaveAttribute('aria-checked', 'true');
    // The tile already picked: the press settles it all the same.
    fireEvent.click(jev);
    status.answer?.(state(NOT_INSTALLED));
    await waitFor(() => expect(tilesOf(step)).toEqual(MUDE_FIRST), { timeout: 3000 });
    expect(within(tile).getByText('Recommended · on this Mac')).toBeInTheDocument();
    expect(jev).toHaveAttribute('aria-checked', 'true');
    expect(tile).toHaveAttribute('aria-checked', 'false');
    expect(within(step).getByTestId('mu-welcome-judge-ready')).toBeInTheDocument();
    expect(bridge.mudeRun).not.toHaveBeenCalled();
  });

  it('leaves a judge set up before as it is, and only puts mude first', async () => {
    bridge.settings.mockResolvedValue(ok(newUser({ tiers: ['laya'] })));
    const { step, tile } = await judgeStep();
    await waitFor(() => expect(tilesOf(step)).toEqual(MUDE_FIRST), { timeout: 3000 });
    expect(within(step).getByTestId('mu-judge-choice-local')).toHaveAttribute('aria-checked', 'true');
    expect(tile).toHaveAttribute('aria-checked', 'false');
    cleanup();
    // Jev with a key of its own: set up on purpose, so it stays the pick too.
    bridge.settings.mockResolvedValue(ok(newUser({ keys: { TYPESAFE_API_KEY: true } })));
    const keyed = await judgeStep();
    await waitFor(() => expect(tilesOf(keyed.step)).toEqual(MUDE_FIRST), { timeout: 3000 });
    expect(within(keyed.step).getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'true');
    expect(keyed.tile).toHaveAttribute('aria-checked', 'false');
  });

  it('on a machine that cannot run it: dimmed, says why and what mu does instead, and never in the way', async () => {
    bridge.mudeState.mockResolvedValue(
      state({
        ...NOT_INSTALLED,
        supported: false,
        problems: ['it needs Apple silicon (an M1 or newer); this Mac has an Intel processor'],
      })
    );
    const { step, tile } = await judgeStep();
    await waitFor(() => expect(tile).toHaveAttribute('aria-disabled', 'true'));
    // Not recommended here: the usual order and tags, and Jev picked as the files say.
    expect(tilesOf(step)).toEqual(USUAL_ORDER);
    expect(within(tile).getByText('On this Mac')).toBeInTheDocument();
    expect(within(step).getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'true');
    expect(within(within(step).getByTestId('mu-judge-choice-jev')).getByText('Recommended')).toBeInTheDocument();
    expect(within(tile).getByTestId('mu-mude-unsupported')).toHaveTextContent(
      'mude 1.0 needs a Mac with Apple silicon, macOS 14 or later and 8 GB of memory. mu uses the hosted judge instead.'
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
    expect(tilesOf(off.step)).toEqual(USUAL_ORDER);
    expect(within(off.tile).getByText('On this Mac')).toBeInTheDocument();
    expect(within(off.step).getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'true');
    expect(within(within(off.step).getByTestId('mu-judge-choice-jev')).getByText('Recommended')).toBeInTheDocument();
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
          message: 'Downloading mude (qybaihe/mude-1.0-mlx-8bit, 1.78 GB) and checking every file',
          download: { file: 'mlx-q8.safetensors', done: MODEL_BYTES / 4, total: MODEL_BYTES, checking: false },
        })
      )
    );
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    const progress = await within(tile).findByTestId('mu-mude-progress');
    expect(progress).toHaveTextContent('25%');
    expect(progress).toHaveTextContent('0.4 of 1.8 GB');
    expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(enMu.judges.mude.step.download);
    expect(tile).not.toHaveTextContent('1.78');
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
      "mude 1.0 isn't available for download yet. Try again later."
    );
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(tile).getByTestId('mu-mude-retry'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledTimes(2));
    expect(bridge.mudeRun).toHaveBeenLastCalledWith({ action: 'install' });
  });

  it('folds the command’s output of a failed install, so Back and Next stay in sight', async () => {
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    bridge.mudeRun.mockResolvedValue(
      state(
        { ...NOT_INSTALLED, downloadedBytes: 700_000_000 },
        task('install', 'failed', {
          log: ['Fetching mlx-q8.safetensors'],
          error: { message: 'mlx-q8.safetensors could not be downloaded (fetch failed)', kind: 'network' },
        })
      )
    );
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    expect(await within(tile).findByTestId('mu-mude-failed')).toHaveTextContent(enMu.judges.mude.error.network);
    expect(within(tile).queryByTestId('mu-mude-error')).not.toBeInTheDocument();
    fireEvent.click(within(tile).getByTestId('mu-mude-details'));
    expect(within(tile).getByTestId('mu-mude-error')).toHaveTextContent('could not be downloaded (fetch failed)');
    // What is downloaded is kept: the button goes on from there, and the line above says how much, once.
    expect(within(tile).getByTestId('mu-mude-retry')).toHaveTextContent('Continue installing');
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(/^Downloaded 0\.7 of 1\.8 GB\.$/);
  });

  it('continues an install that stopped part way in one click, saying how much is there', async () => {
    // Stopped as the app quit or the power went out: no command of this run says how it ended.
    bridge.mudeState.mockResolvedValue(state({ ...NOT_INSTALLED, downloadedBytes: 900_000_000 }));
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    expect(await within(tile).findByTestId('mu-mude-hint')).toHaveTextContent(
      'Downloaded 0.9 of 1.8 GB. Continue installing to pick up where it left off.'
    );
    // Agreed to when it started: not what installing takes all over again.
    expect(tile).not.toHaveTextContent('to download');
    const resume = within(tile).getByTestId('mu-mude-install');
    expect(resume).toHaveTextContent('Continue installing');
    bridge.mudeRun.mockResolvedValue(
      state({ ...NOT_INSTALLED, downloadedBytes: 900_000_000 }, task('install', 'running'))
    );
    fireEvent.click(resume);
    // No flag either way: the command keeps the "Local only" choice of the install that stopped.
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledTimes(1));
    expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('after a cancelled install, says how much is kept once, beside how it ended', async () => {
    bridge.mudeState.mockResolvedValue(
      state({ ...NOT_INSTALLED, downloadedBytes: 900_000_000 }, task('install', 'cancelled', { step: 'download' }))
    );
    const { tile } = await judgeStep();
    fireEvent.click(tile);
    expect(await within(tile).findByTestId('mu-mude-cancelled')).toHaveTextContent(
      "Install canceled. What's downloaded is kept."
    );
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(/^Downloaded 0\.9 of 1\.8 GB\.$/);
    expect(within(tile).getByTestId('mu-mude-install')).toHaveTextContent('Continue installing');
  });

  it('once installed it is the judge, and the guide’s one save keeps mude first with the rest of the guide', async () => {
    const { step, tile } = await judgeStep();
    // A key typed for Jev, picked first, before mude was picked again: it is saved too.
    await waitFor(() => expect(tile).toHaveAttribute('aria-checked', 'true'), { timeout: 3000 });
    fireEvent.click(within(step).getByTestId('mu-judge-choice-jev'));
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
      'mude 1.0 is running and is your judge.'
    );
    expect(tile).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByTestId('mu-welcome-next'));
    await screen.findByTestId('mu-welcome-step-done');
    expect(screen.getByTestId('mu-welcome-done-judge')).toHaveTextContent('mude 1.0');
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
