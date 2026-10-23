import React from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { MudeState, MudeStatus, MudeTask } from '@/common/kyrn/mude';
import type { Result } from '@/common/kyrn/types';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import MudePanel from '@/renderer/pages/settings/KyrnSettings/sections/MudePanel';

const bridge = vi.hoisted(() => ({ mudeState: vi.fn(), mudeRun: vi.fn() }));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: {
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

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en-US',
    resources: { 'en-US': { translation: { common: enCommon, mu: enMu } } },
    interpolation: { escapeValue: false },
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const GB = 1024 ** 3;
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
  pid: 4242,
  memoryBytes: 3.6 * GB,
  enabled: true,
  fallback: ['jev'],
};

const ok = (data: MudeState): Result<MudeState> => ({ ok: true, data });
const state = (status?: MudeStatus, task?: MudeTask): Result<MudeState> =>
  ok({ available: true, ...(status ? { status } : {}), ...(task ? { task } : {}) });

function panel(props: Partial<React.ComponentProps<typeof MudePanel>> = {}) {
  render(
    <I18nextProvider i18n={i18n}>
      <MudePanel unsaved={false} {...props} />
    </I18nextProvider>
  );
  return screen.findByTestId('mu-mude');
}

describe('mude on the judges page', () => {
  it('shows nothing where the app does not offer mude', async () => {
    bridge.mudeState.mockResolvedValue(ok({ available: false }));
    render(
      <I18nextProvider i18n={i18n}>
        <MudePanel unsaved={false} />
      </I18nextProvider>
    );
    await waitFor(() => expect(bridge.mudeState).toHaveBeenCalled());
    expect(screen.queryByTestId('mu-mude')).not.toBeInTheDocument();
  });

  it('installs only after the consent, which says what it takes and offers "Only local"', async () => {
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED));
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('Not installed.'));
    expect(within(view).queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(within(view).getByTestId('mu-mude-install'));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Install mude?');
    expect(dialog).toHaveTextContent('about 1.8 GB');
    expect(dialog).toHaveTextContent('about 1.0 GB');
    expect(dialog).toHaveTextContent('about 4 GB of memory');
    expect(dialog).toHaveTextContent('Apple silicon and macOS 14 or later');
    const only = within(dialog).getByRole('checkbox');
    expect(only).not.toBeChecked();
    // Off, the judge behind mude (Jev by default) is named, and that what it reads leaves this Mac.
    expect(dialog).toHaveTextContent('go to Jev in the cloud');
    expect(dialog).toHaveTextContent('leaves this Mac');
    fireEvent.click(only);
    expect(dialog).toHaveTextContent('nothing goes to the cloud');
    expect(bridge.mudeRun).not.toHaveBeenCalled();

    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { id: 1, command: 'install', phase: 'running', log: [] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download and install' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install', localOnly: true }));
  });

  it('installs with the judges behind mude when "Only local" is left off', async () => {
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED));
    const view = await panel();
    fireEvent.click(await within(view).findByTestId('mu-mude-install'));
    const dialog = await screen.findByRole('dialog');
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { id: 2, command: 'install', phase: 'running', log: [] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Download and install' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'install', localOnly: false }));
  });

  it('follows an install: the step, the download, the Python log, and a Cancel', async () => {
    const task: MudeTask = {
      id: 3,
      command: 'install',
      phase: 'running',
      step: 'download',
      message: 'Downloading mude from Hugging Face.',
      download: { file: 'model.safetensors', done: 0.9 * GB, total: 1.8 * GB, checking: false },
      log: ['Collecting torch', 'Collecting transformers'],
    };
    bridge.mudeState.mockResolvedValue(state(NOT_INSTALLED, task));
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('Downloading mude from Hugging Face.'));
    const download = within(view).getByTestId('mu-mude-download');
    expect(download).toHaveTextContent('0.9 of 1.8 GB');
    expect(download).toHaveTextContent('50%');
    expect(within(view).getByTestId('mu-mude-log')).toHaveTextContent('Collecting transformers');
    expect(within(view).queryByTestId('mu-mude-install')).not.toBeInTheDocument();

    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { ...task, phase: 'cancelled' }));
    fireEvent.click(within(view).getByTestId('mu-mude-cancel'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'cancel' }));
    await waitFor(() => expect(view).toHaveTextContent("What's downloaded is kept"));
  });

  it('when it is running and the judge: its address and memory, the switches, and what "Only local" means', async () => {
    bridge.mudeState.mockResolvedValue(state(RUNNING));
    const changed = vi.fn();
    const view = await panel({ onSettingsChanged: changed });
    await waitFor(() => expect(view).toHaveTextContent('Running on 127.0.0.1:8790 · 3.6 GB'));
    expect(view).toHaveTextContent('about 4 GB of memory');
    expect(view).toHaveTextContent('including ones in the terminal');
    const use = within(within(view).getByTestId('mu-mude-use')).getByRole('switch');
    const only = within(within(view).getByTestId('mu-mude-local-only')).getByRole('switch');
    expect(use).toBeChecked();
    expect(only).not.toBeChecked();
    const help = within(view).getByTestId('mu-mude-local-only-help');
    expect(help).toHaveTextContent('go to Jev in the cloud');
    expect(help).toHaveTextContent('screening tool descriptions');

    // Turning "Only local" on runs `enable --local-only`; once it ended, the settings are read again.
    bridge.mudeRun.mockResolvedValue(state(RUNNING, { id: 10, command: 'enable', phase: 'running', log: [] }));
    bridge.mudeState.mockResolvedValue(
      state({ ...RUNNING, localOnly: true }, { id: 10, command: 'enable', phase: 'done', log: [] })
    );
    fireEvent.click(only);
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'enable', localOnly: true }));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1), { timeout: 3000 });
    expect(recheck.recheckMu).toHaveBeenCalled();
    await waitFor(() => expect(help).toHaveTextContent('nothing goes to the cloud'));

    bridge.mudeRun.mockResolvedValue(state(RUNNING));
    fireEvent.click(within(view).getByTestId('mu-mude-open'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'open' }));
    // While a command runs, only its progress is offered.
    bridge.mudeRun.mockResolvedValue(state(RUNNING, { id: 11, command: 'stop', phase: 'running', log: [] }));
    fireEvent.click(within(view).getByTestId('mu-mude-stop'));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'stop' }));
    await waitFor(() => expect(view).toHaveTextContent('Stopping mude…'));
    expect(within(view).queryByTestId('mu-mude-open')).not.toBeInTheDocument();
  });

  it('turns mude off with its switch', async () => {
    bridge.mudeState.mockResolvedValue(state(RUNNING));
    const view = await panel();
    const use = within(await within(view).findByTestId('mu-mude-use')).getByRole('switch');
    bridge.mudeRun.mockResolvedValue(state(RUNNING, { id: 20, command: 'disable', phase: 'running', log: [] }));
    fireEvent.click(use);
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'disable' }));
  });

  it('asks before it uninstalls', async () => {
    bridge.mudeState.mockResolvedValue(state({ ...RUNNING, running: false, ready: false }));
    const view = await panel();
    await waitFor(() => expect(view).toHaveTextContent('Stopped'));
    expect(within(view).getByTestId('mu-mude-start')).toBeInTheDocument();
    fireEvent.click(within(view).getByTestId('mu-mude-uninstall'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('about 2.8 GB');
    expect(bridge.mudeRun).not.toHaveBeenCalled();
    bridge.mudeRun.mockResolvedValue(state(NOT_INSTALLED, { id: 21, command: 'uninstall', phase: 'running', log: [] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }));
    await waitFor(() => expect(bridge.mudeRun).toHaveBeenCalledWith({ action: 'uninstall' }));
  });

  it('waits for unsaved changes before it changes mu.json', async () => {
    bridge.mudeState.mockResolvedValue(state(RUNNING));
    const view = await panel({ unsaved: true });
    await waitFor(() => expect(within(view).getByTestId('mu-mude-unsaved')).toBeInTheDocument());
    expect(within(within(view).getByTestId('mu-mude-use')).getByRole('switch')).toBeDisabled();
    expect(within(within(view).getByTestId('mu-mude-local-only')).getByRole('switch')).toBeDisabled();
    expect(within(view).getByTestId('mu-mude-uninstall')).toBeDisabled();
    // Starting and stopping the server leave mu.json alone.
    expect(within(view).getByTestId('mu-mude-stop')).not.toBeDisabled();
  });

  it('says plainly when the model cannot be downloaded yet', async () => {
    bridge.mudeState.mockResolvedValue(
      state(NOT_INSTALLED, {
        id: 30,
        command: 'install',
        phase: 'failed',
        log: [],
        error: { message: 'Hugging Face refused the download (401).', kind: 'access' },
      })
    );
    const view = await panel();
    await waitFor(() =>
      expect(within(view).getByTestId('mu-mude-failed')).toHaveTextContent(
        "mude isn't available for download yet. Try again later."
      )
    );
    expect(within(view).queryByTestId('mu-mude-error')).not.toBeInTheDocument();
    // Installing again is offered.
    expect(within(view).getByTestId('mu-mude-install')).toBeInTheDocument();
  });

  it('shows another failure with the command’s own words', async () => {
    bridge.mudeState.mockResolvedValue(
      state(RUNNING, {
        id: 31,
        command: 'start',
        phase: 'failed',
        log: [],
        error: { message: 'Port 8790 is already in use.' },
      })
    );
    const view = await panel();
    await waitFor(() => expect(within(view).getByTestId('mu-mude-failed')).toHaveTextContent("Couldn't start mude."));
    expect(within(view).getByTestId('mu-mude-error')).toHaveTextContent('Port 8790 is already in use.');
  });

  it('on a Mac that cannot run it: why, and no buttons', async () => {
    bridge.mudeState.mockResolvedValue(
      state({
        ...NOT_INSTALLED,
        supported: false,
        problems: ['mude needs a Mac with Apple silicon.', 'mude needs macOS 14 or later.'],
      })
    );
    const view = await panel();
    const why = await within(view).findByTestId('mu-mude-unsupported');
    expect(why).toHaveTextContent("mude can't run on this Mac:");
    expect(why).toHaveTextContent('mude needs a Mac with Apple silicon.');
    expect(why).toHaveTextContent('mude needs macOS 14 or later.');
    expect(within(view).queryAllByRole('button')).toHaveLength(0);
    expect(within(view).queryByRole('switch')).not.toBeInTheDocument();
  });

  it('says why the status could not be read', async () => {
    bridge.mudeState.mockResolvedValue(ok({ available: true, problem: 'Unknown judge command: mude' }));
    const view = await panel();
    await waitFor(() =>
      expect(within(view).getByTestId('mu-mude-problem')).toHaveTextContent(
        "Couldn't get mude's status: Unknown judge command: mude"
      )
    );
  });
});
