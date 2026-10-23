import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { MudeState, MudeStatus, MudeTask } from '@/common/kyrn/mude';
import type { KyrnSettings, Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';
import zhMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import SettingsArea from '@/renderer/pages/settings/KyrnSettings/SettingsArea';

/** mude as a choice of the judges page: every command through the bridge to `mu judge mude`, played by the test. */

const bridge = vi.hoisted(() => ({
  settings: vi.fn(),
  save: vi.fn(),
  availableModels: vi.fn(),
  mudeState: vi.fn(),
  mudeRun: vi.fn(),
  localJudgeState: vi.fn(),
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
    settings: { invoke: bridge.settings },
    save: { invoke: bridge.save },
    availableModels: { invoke: bridge.availableModels },
    mudeState: { invoke: bridge.mudeState },
    mudeRun: { invoke: bridge.mudeRun },
    localJudgeState: { invoke: bridge.localJudgeState },
  },
  unwrap: <T,>(result: Result<T>) => {
    if (!result.ok) throw Object.assign(new Error(result.error), result);
    return result.data;
  },
}));
const recheck = vi.hoisted(() => ({ recheckMu: vi.fn(async () => undefined) }));
vi.mock('@/renderer/pages/settings/KyrnSettings/recheck', () => recheck);

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu } } },
    interpolation: { escapeValue: false },
  });
});

const GB = 1024 ** 3;
/** The model's size in bytes, as the command counts its download. */
const MODEL_BYTES = 1_782_005_734;
const MUDE_PROFILE = {
  type: 'typesafe' as const,
  model: 'mude',
  baseUrl: 'http://127.0.0.1:8790/v1/systemone',
  apiKeyEnv: 'MU_JUDGE_MUDE_KEY',
  timeoutMs: 4000,
};

function settings(patch: Partial<KyrnSettings> = {}): KyrnSettings {
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
    keys: { TYPESAFE_API_KEY: true },
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
const INSTALLED: MudeStatus = { ...NOT_INSTALLED, installed: true, pythonReady: true };
const RUNNING: MudeStatus = {
  ...INSTALLED,
  running: true,
  ready: true,
  pid: 4242,
  memoryBytes: 3.6 * GB,
  enabled: true,
  fallback: ['jev'],
};

const ok = <T,>(data: T): Result<T> => ({ ok: true, data });
const state = (status?: MudeStatus, task?: MudeTask): Result<MudeState> =>
  ok({ available: true, ...(status ? { status } : {}), ...(task ? { task } : {}) });
/** Task ids grow across the file: the page hands a finished command on only once. */
let nextId = 100;
const task = (command: MudeTask['command'], phase: MudeTask['phase'], patch: Partial<MudeTask> = {}): MudeTask => ({
  id: nextId++,
  command,
  phase,
  log: [],
  ...patch,
});

beforeEach(() => {
  bridge.settings.mockResolvedValue(ok(settings()));
  bridge.availableModels.mockResolvedValue(ok({ providers: [], thinkingLevels: [] }));
  bridge.localJudgeState.mockResolvedValue(
    ok({ support: 'ok', installed: true, running: true, url: 'http://127.0.0.1:47823' })
  );
  bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function judgesPage(language = i18n) {
  render(
    <I18nextProvider i18n={language}>
      <SettingsArea page='judges' />
    </I18nextProvider>
  );
  await screen.findByTestId('mu-section-judges');
  return screen.findByTestId('mu-judge-choice-mude');
}

/** Lets a read of the settings that was asked for land, with whatever it would draw afresh. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 50)));

/** `first` comes before `second` in the page. */
const before = (first: Element, second: Element) =>
  Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('mude as a choice of the judges page', () => {
  it('is not offered where the app does not offer mude', async () => {
    bridge.mudeState.mockResolvedValue(ok({ available: false }));
    render(
      <I18nextProvider i18n={i18n}>
        <SettingsArea page='judges' />
      </I18nextProvider>
    );
    await screen.findByTestId('mu-judge-choice-jev');
    await waitFor(() => expect(bridge.mudeState).toHaveBeenCalled());
    expect(screen.queryByTestId('mu-judge-choice-mude')).not.toBeInTheDocument();
  });

  it('on a Mac that cannot run it: why, dimmed, and never picked', async () => {
    bridge.mudeState.mockResolvedValue(
      state({ ...NOT_INSTALLED, supported: false, problems: ['it needs macOS 14 or later'] })
    );
    const tile = await judgesPage();
    await waitFor(() => expect(tile).toHaveAttribute('aria-disabled', 'true'));
    expect(within(tile).getByTestId('mu-mude-unsupported')).toHaveTextContent(
      'mude 1.0 needs a Mac with Apple silicon, macOS 14 or later and 8 GB of memory.'
    );
    expect(tile).toHaveTextContent('it needs macOS 14 or later');
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'false');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
  });

  it('picked when not installed: the install, after the consent with "Only local", and nothing in the draft', async () => {
    const tile = await judgesPage();
    expect(tile).toHaveTextContent(enMu.judges.choices.mude.description);
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'false');
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(
      '1.8 GB to download, plus a 1.0 GB Python environment. Uses about 4 GB of memory while running.'
    );
    // The memory it takes is said once.
    expect(tile.textContent?.match(/GB of memory/g)).toHaveLength(1);
    // Picking it changed nothing to save: its command does that.
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    // Nothing on disk yet: a fresh install, after the consent.
    expect(within(tile).getByTestId('mu-mude-install')).toHaveTextContent('Install mude 1.0');
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Install mude 1.0?');
    expect(dialog).toHaveTextContent('about 1.8 GB');
    expect(within(dialog).getByTestId('mu-mude-consent-help')).toHaveTextContent('go to Jev in the cloud');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    // The other explanation is shown in the same place, which kept room for it: the dialog does not change size.
    expect(within(dialog).getByTestId('mu-mude-consent-help')).toHaveTextContent('nothing goes to the cloud');
    expect(within(dialog).getAllByText(/go to Jev in the cloud/)[0]).toHaveAttribute('aria-hidden', 'true');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download and install' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install', localOnly: true }));
  });

  it('shows a running install with its progress and a Cancel, opened on it', async () => {
    const running = task('install', 'running', {
      step: 'download',
      message: 'Downloading mude (qybaihe/mude-1.0-mlx-8bit, 1.78 GB) and checking every file',
      download: { file: 'mlx-q8.safetensors', done: MODEL_BYTES / 2, total: MODEL_BYTES, checking: false },
      log: ['Collecting mlx'],
    });
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, running));
    const tile = await judgesPage();
    await waitFor(() => expect(tile).toHaveAttribute('aria-checked', 'true'));
    expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(enMu.judges.mude.step.download);
    // One size, as the consent gives it (decimal gigabytes): not the command's own sentence with another.
    expect(tile).not.toHaveTextContent('1.78');
    const progress = within(tile).getByTestId('mu-mude-progress');
    expect(progress).toHaveTextContent('50%');
    expect(progress).toHaveTextContent('0.9 of 1.8 GB');
    expect(within(tile).getByTestId('mu-mude-log')).toHaveTextContent('Collecting mlx');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { ...running, phase: 'cancelled' }));
    fireEvent.click(within(tile).getByTestId('mu-mude-cancel'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'cancel' }));
  });

  it('says each step of an install in the app language, not in the command’s English', async () => {
    const zh = createInstance();
    await zh.init({
      lng: 'zh-CN',
      resources: { 'zh-CN': { translation: { common: zhCommon, mu: zhMu } } },
      interpolation: { escapeValue: false },
    });
    const running = task('install', 'running', {
      step: 'download',
      message: 'Downloading mude (qybaihe/mude-1.0-mlx-8bit, 1.78 GB) and checking every file',
      download: { file: 'mlx-q8.safetensors', done: 700_000_000, total: MODEL_BYTES, checking: false },
    });
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, running));
    const tile = await judgesPage(zh);
    await waitFor(() =>
      expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(zhMu.judges.mude.step.download)
    );
    expect(within(tile).getByTestId('mu-mude-download')).toHaveTextContent('0.7 / 1.8 GB');
    expect(tile).not.toHaveTextContent('Downloading');
    bridge.mudeState.mockResolvedValue(
      state(NOT_INSTALLED, {
        ...running,
        step: 'python',
        message: "Setting up mude's Python environment (MLX, transformers; about 1 GB, once)",
        download: undefined,
      })
    );
    await waitFor(
      () => expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(zhMu.judges.mude.step.python),
      { timeout: 3000 }
    );
    expect(tile).not.toHaveTextContent('Setting up');
    bridge.mudeState.mockResolvedValue(
      state(NOT_INSTALLED, { ...running, step: 'start', message: "Starting mude's server on 127.0.0.1:8790" })
    );
    await waitFor(
      () => expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(zhMu.judges.mude.step.start),
      { timeout: 3000 }
    );
    expect(tile).not.toHaveTextContent('127.0.0.1');
  });

  it('keeps mude open with how a cancelled install ended, and does not draw the page afresh', async () => {
    const tile = await judgesPage();
    fireEvent.click(tile);
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    const dialog = await screen.findByRole('dialog');
    const running = task('install', 'running', {
      step: 'download',
      download: { file: 'mlx-q8.safetensors', done: 700_000_000, total: MODEL_BYTES, checking: false },
    });
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, running));
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, running));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download and install' }));
    fireEvent.click(await within(tile).findByTestId('mu-mude-cancel'));
    // Cancelled: what is downloaded stays.
    const left = { ...NOT_INSTALLED, downloadedBytes: 700_000_000 };
    bridge.mudeRun.mockResolvedValue(state(left, { ...running, phase: 'cancelled' }));
    bridge.mudeState.mockResolvedValue(state(left, { ...running, phase: 'cancelled' }));
    const reads = bridge.settings.mock.calls.length;
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'cancel' }));
    // mu.json is read again (the command may have changed it), and the page is not drawn afresh: the same tile,
    // still the open choice, with the message above the button that goes on with the install. The end of the install
    // is seen by the next status poll (1 s while busy): longer than waitFor's default wait on a slow machine.
    await waitFor(() => expect(bridge.settings.mock.calls.length).toBeGreaterThan(reads), { timeout: 3000 });
    await settle();
    expect(screen.getByTestId('mu-judge-choice-mude')).toBe(tile);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'false');
    const cancelled = within(tile).getByTestId('mu-mude-cancelled');
    expect(cancelled).toHaveTextContent(enMu.judges.mude.cancelled);
    const resume = within(tile).getByTestId('mu-mude-install');
    expect(before(cancelled, resume)).toBe(true);
    expect(resume).toHaveTextContent('Continue installing');
    // The message says the download is kept: the line under the status only says how much, no second sentence.
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(/^Downloaded 0\.7 of 1\.8 GB\.$/);
    expect(tile).not.toHaveTextContent('picks up');
  });

  it('opened on a running install, stays on it with why it failed, the command’s output folded', async () => {
    const running = task('install', 'running', { step: 'python', log: ['Collecting mlx'] });
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, running));
    const tile = await judgesPage();
    await waitFor(() => expect(tile).toHaveAttribute('aria-checked', 'true'));
    const reads = bridge.settings.mock.calls.length;
    bridge.mudeState.mockResolvedValue(
      state(
        { ...NOT_INSTALLED, installed: true, downloadedBytes: MODEL_BYTES },
        { ...running, phase: 'failed', error: { message: 'uv: failed to fetch mlx', kind: 'network' } }
      )
    );
    await waitFor(() => expect(bridge.settings.mock.calls.length).toBeGreaterThan(reads), { timeout: 3000 });
    await settle();
    expect(screen.getByTestId('mu-judge-choice-mude')).toBe(tile);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    const failed = within(tile).getByTestId('mu-mude-failed');
    expect(failed).toHaveTextContent(enMu.judges.mude.error.network);
    // The model is all there: the button below goes on with the install, and the line above says how much is kept.
    const resume = within(tile).getByTestId('mu-mude-install');
    expect(before(failed, resume)).toBe(true);
    expect(resume).toHaveTextContent('Continue installing');
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(/^Downloaded 1\.8 of 1\.8 GB\.$/);
    expect(within(tile).queryByTestId('mu-mude-error')).not.toBeInTheDocument();
    const details = within(tile).getByTestId('mu-mude-details');
    expect(details).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(details);
    expect(within(tile).getByTestId('mu-mude-error')).toHaveTextContent('uv: failed to fetch mlx');
  });

  it('continues an install that stopped part way in one click: how much is there, and no consent again', async () => {
    // Stopped as the app quit or the power went out: no command of this run says how it ended.
    bridge.mudeState.mockResolvedValue(state({ ...NOT_INSTALLED, downloadedBytes: 900_000_000 }));
    const tile = await judgesPage();
    fireEvent.click(tile);
    expect(within(tile).getByTestId('mu-mude-status')).toHaveTextContent(enMu.judges.mude.notInstalled);
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(
      'Downloaded 0.9 of 1.8 GB. Continuing picks up where it stopped.'
    );
    expect(tile).not.toHaveTextContent('to download');
    const resume = within(tile).getByTestId('mu-mude-install');
    expect(resume).toHaveTextContent('Continue installing');
    bridge.mudeRun.mockResolvedValue(
      state({ ...NOT_INSTALLED, downloadedBytes: 900_000_000 }, task('install', 'running'))
    );
    fireEvent.click(resume);
    // No flag either way: the command keeps the "Only local" choice of the install that stopped.
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledTimes(1));
    expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mu-mude-consent')).not.toBeInTheDocument();
  });

  it('says an install stopped part way without an amount when none of the model is there yet', async () => {
    bridge.mudeState.mockResolvedValue(state({ ...NOT_INSTALLED, pythonReady: true }));
    const tile = await judgesPage();
    fireEvent.click(tile);
    expect(within(tile).getByTestId('mu-mude-hint')).toHaveTextContent(
      "The last install didn't finish. Continuing picks up where it stopped."
    );
    expect(within(tile).getByTestId('mu-mude-install')).toHaveTextContent('Continue installing');
  });

  it('chosen when installed runs `enable`, not a save, and reads the settings again once it ended', async () => {
    bridge.mudeState.mockResolvedValue(state(INSTALLED));
    const tile = await judgesPage();
    expect(tile).not.toHaveAttribute('aria-disabled');
    bridge.mudeRun.mockResolvedValue(state(INSTALLED, task('enable', 'running')));
    const reads = bridge.settings.mock.calls.length;
    fireEvent.click(tile);
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'enable' }));
    expect(bridge.save).not.toHaveBeenCalled();
    // It ends; mu.json now asks mude first.
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['mude', 'jev'] })));
    bridge.mudeState.mockResolvedValue(state(RUNNING, task('enable', 'done')));
    await waitFor(() => expect(bridge.settings.mock.calls.length).toBeGreaterThan(reads), { timeout: 3000 });
    expect(recheck.recheckMu).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByTestId('mu-judge-choice-mude')).toHaveTextContent('Running on 127.0.0.1:8790 · 3.6 GB')
    );
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
  });

  it('selected when the order starts with mude: its server, "Only local", its folder', async () => {
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['mude', 'jev'] })));
    bridge.mudeState.mockResolvedValue(state(RUNNING));
    const tile = await judgesPage();
    expect(tile).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(tile).toHaveTextContent('Running on 127.0.0.1:8790 · 3.6 GB'));
    expect(tile).toHaveTextContent('including ones in the terminal');
    // What it uses is in the status already: no second figure under it.
    expect(tile).not.toHaveTextContent('about 4 GB');
    const only = within(within(tile).getByTestId('mu-mude-local-only')).getByRole('switch');
    expect(only).not.toBeChecked();
    const help = within(tile).getByTestId('mu-mude-local-only-help');
    expect(help).toHaveTextContent('go to Jev in the cloud');
    expect(help).toHaveTextContent('screening tool descriptions');
    // No second switch for mude being the judge: the choice is that.
    expect(within(tile).queryByTestId('mu-mude-use')).not.toBeInTheDocument();

    bridge.mudeRun.mockResolvedValue(state(RUNNING));
    fireEvent.click(within(tile).getByTestId('mu-mude-open'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'open' }));
    bridge.mudeRun.mockResolvedValue(state(RUNNING, task('enable', 'running')));
    fireEvent.click(only);
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'enable', localOnly: true }));
    expect(tile).toHaveTextContent('Turning on mude 1.0…');
  });

  it('stops and starts its server, and asks before it uninstalls', async () => {
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['mude', 'jev'] })));
    bridge.mudeState.mockResolvedValue(state({ ...RUNNING, running: false, ready: false }));
    const tile = await judgesPage();
    await waitFor(() => expect(tile).toHaveTextContent('Stopped'));
    bridge.mudeRun.mockResolvedValue(state(RUNNING));
    fireEvent.click(within(tile).getByTestId('mu-mude-start'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'start' }));
    fireEvent.click(await within(tile).findByTestId('mu-mude-uninstall'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('about 2.8 GB');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('uninstall', 'running')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'uninstall' }));
  });

  it('picking another judge while mude is the judge runs `disable` first, then makes the pick', async () => {
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['mude', 'jev'] })));
    bridge.mudeState.mockResolvedValue(state(RUNNING));
    await judgesPage();
    bridge.mudeRun.mockResolvedValue(state(RUNNING, task('disable', 'running')));
    fireEvent.click(screen.getByTestId('mu-judge-choice-local'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'disable' }));
    // The command brings back the judges from before, and stops the server.
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['jev'] })));
    bridge.mudeState.mockResolvedValue(state({ ...INSTALLED }, task('disable', 'done')));
    // Then Laya is picked in the settings read again: an edit like any other, for the save bar.
    await waitFor(() => expect(screen.getByTestId('mu-judge-choice-local')).toHaveAttribute('aria-checked', 'true'), {
      timeout: 3000,
    });
    expect(screen.getByTestId('mu-judge-choice-mude')).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByTestId('mu-save-bar')).toBeInTheDocument();
    bridge.save.mockResolvedValue(ok(settings({ tiers: ['laya'], revision: 'r3' })));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(bridge.save).toHaveBeenCalledTimes(1));
    expect(bridge.save.mock.calls[0][0].tiers).toEqual(['laya']);
  });

  it('waits for unsaved changes before a command that writes mu.json', async () => {
    bridge.mudeState.mockResolvedValue(state(INSTALLED));
    await judgesPage();
    // An unsaved change: verdicts off.
    fireEvent.click(screen.getByRole('switch', { name: enMu.judges.mode }));
    expect(await screen.findByTestId('mu-save-bar')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mu-judge-choice-mude'));
    const tile = screen.getByTestId('mu-judge-choice-mude');
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
    expect(within(tile).getByTestId('mu-mude-unsaved')).toHaveTextContent(enMu.judges.mude.saveFirst);
    expect(within(tile).getByTestId('mu-mude-use')).toBeDisabled();
    expect(within(tile).getByTestId('mu-mude-uninstall')).toBeDisabled();
  });

  it('says plainly when the model cannot be downloaded yet, and offers the install again', async () => {
    bridge.mudeState.mockResolvedValue(
      state(
        NOT_INSTALLED,
        task('install', 'failed', { error: { message: 'Hugging Face refused the download (401)', kind: 'access' } })
      )
    );
    const tile = await judgesPage();
    fireEvent.click(tile);
    expect(within(tile).getByTestId('mu-mude-failed')).toHaveTextContent(
      "mude 1.0 isn't available for download yet. Try again later."
    );
    expect(within(tile).queryByTestId('mu-mude-error')).not.toBeInTheDocument();
    // Nothing was downloaded: installing again starts afresh.
    expect(within(tile).getByTestId('mu-mude-install')).toHaveTextContent('Install mude 1.0');
  });

  it('names mude in the order by what it is', async () => {
    bridge.settings.mockResolvedValue(ok(settings({ tiers: ['mude', 'jev'] })));
    render(
      <I18nextProvider i18n={i18n}>
        <SettingsArea page='judge-order' />
      </I18nextProvider>
    );
    const order = await screen.findByTestId('mu-judge-tiers');
    const tags = [...order.querySelectorAll('.arco-select .arco-tag')].map((tag) => tag.textContent);
    expect(tags).toEqual([enMu.judges.mude.name, enMu.judges.choices.jev.title]);
    expect(screen.getByTestId('mu-judge-tier-0')).toHaveTextContent(enMu.judges.mude.tierHelp);
  });
});
