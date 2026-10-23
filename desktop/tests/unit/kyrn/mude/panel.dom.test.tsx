import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { MudeState, MudeStatus, MudeTask } from '@/common/kyrn/mude';
import type { KyrnSettings, Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
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

async function judgesPage() {
  render(
    <I18nextProvider i18n={i18n}>
      <SettingsArea page='judges' />
    </I18nextProvider>
  );
  await screen.findByTestId('mu-section-judges');
  return screen.findByTestId('mu-judge-choice-mude');
}

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
      'mude needs a Mac with Apple silicon, macOS 14 or later and 8 GB of memory.'
    );
    expect(tile).toHaveTextContent('it needs macOS 14 or later');
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'false');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
  });

  it('picked when not installed: the install, after the consent with "Only local", and nothing in the draft', async () => {
    const tile = await judgesPage();
    expect(tile).toHaveTextContent("mu's own judge model, running on this Mac");
    fireEvent.click(tile);
    expect(tile).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('mu-judge-choice-jev')).toHaveAttribute('aria-checked', 'false');
    expect(tile).toHaveTextContent('About 1.8 GB to download');
    // Picking it changed nothing to save: its command does that.
    expect(screen.queryByTestId('mu-save-bar')).not.toBeInTheDocument();
    fireEvent.click(within(tile).getByTestId('mu-mude-install'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Install mude?');
    expect(dialog).toHaveTextContent('go to Jev in the cloud');
    fireEvent.click(within(dialog).getByRole('checkbox'));
    expect(dialog).toHaveTextContent('nothing goes to the cloud');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, task('install', 'running')));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download and install' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install', localOnly: true }));
  });

  it('shows a running install with its progress and a Cancel, opened on it', async () => {
    const running = task('install', 'running', {
      step: 'download',
      message: 'Downloading mude and checking every file',
      download: { file: 'model.safetensors', done: 0.9 * GB, total: 1.8 * GB, checking: false },
      log: ['Collecting mlx'],
    });
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, running));
    const tile = await judgesPage();
    await waitFor(() => expect(tile).toHaveAttribute('aria-checked', 'true'));
    expect(tile).toHaveTextContent('Downloading mude and checking every file');
    const progress = within(tile).getByTestId('mu-mude-progress');
    expect(progress).toHaveTextContent('50%');
    expect(progress).toHaveTextContent('0.9 of 1.8 GB');
    expect(within(tile).getByTestId('mu-mude-log')).toHaveTextContent('Collecting mlx');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { ...running, phase: 'cancelled' }));
    fireEvent.click(within(tile).getByTestId('mu-mude-cancel'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'cancel' }));
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
    expect(tile).toHaveTextContent('Turning on mude…');
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
      "mude isn't available for download yet. Try again later."
    );
    expect(within(tile).queryByTestId('mu-mude-error')).not.toBeInTheDocument();
    expect(within(tile).getByTestId('mu-mude-install')).toBeInTheDocument();
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
