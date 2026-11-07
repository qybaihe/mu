/** The small notice above the sidebar's footer: only while an update asks for something, and gone after 稍后. */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateState } from '@/common/update/updateTypes';

const mocks = vi.hoisted(() => ({
  isElectron: true,
  navigate: vi.fn(),
  getState: vi.fn(),
  run: vi.fn(),
  push: undefined as undefined | ((state: UpdateState) => void),
}));

// t() answers with the key and its values, so the tests can read which sentence is shown.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}(${Object.values(params).join(',')})` : key),
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => mocks.isElectron }));
vi.mock('@/common', () => ({
  ipcBridge: {
    update: {
      getState: { invoke: mocks.getState },
      run: { invoke: mocks.run },
      state: {
        on: (callback: (state: UpdateState) => void) => {
          mocks.push = callback;
          return () => {
            mocks.push = undefined;
          };
        },
      },
    },
  },
}));

import UpdateNotice from '@/renderer/components/settings/UpdateNotice';

const state = (patch: Partial<UpdateState>): UpdateState => ({
  phase: 'idle',
  checking: false,
  method: 'restart',
  currentVersion: '0.1.2',
  dismissed: false,
  lastInstallFailed: false,
  ...patch,
});

const renderNotice = async (current: UpdateState, collapsed = false) => {
  mocks.getState.mockResolvedValue(current);
  const view = render(<UpdateNotice collapsed={collapsed} siderTooltipProps={{ disabled: true }} />);
  await act(async () => undefined);
  return view;
};

beforeEach(() => {
  mocks.isElectron = true;
  mocks.run.mockImplementation(async ({ action }: { action: string }) =>
    state({ phase: 'ready', version: '0.1.3', dismissed: action === 'later' })
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('UpdateNotice', () => {
  // Nothing asks for the person: no check yet, up to date, a failed check.
  it.each(['idle', 'upToDate', 'failed'] as const)('says nothing while the update is %s', async (phase) => {
    await renderNotice(state({ phase, version: '0.1.3', percent: 40, error: { code: 'network' } }));
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument();
  });

  it('offers a found version with its size, and downloads it only on 下载', async () => {
    mocks.run.mockImplementation(async ({ action }: { action: string }) =>
      action === 'download'
        ? state({ phase: 'downloading', version: '0.1.3', percent: 0 })
        : state({ phase: 'found', version: '0.1.3', size: 214_523_871, dismissed: action === 'later' })
    );
    await renderNotice(state({ phase: 'found', version: '0.1.3', size: 214_523_871 }));
    // 214 523 871 bytes are about 205 MB.
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.foundVersionSize(0.1.3,205)');
    expect(mocks.run).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'update.download' }));
    });
    expect(mocks.run).toHaveBeenCalledWith({ action: 'download' });
    // The download the person started shows its progress.
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.downloadingVersion(0.1.3,0%)');
    act(() => mocks.push?.(state({ phase: 'downloading', version: '0.1.3', percent: 42 })));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.downloadingVersion(0.1.3,42%)');
  });

  it('leaves the size out when the update feed does not give it', async () => {
    await renderNotice(state({ phase: 'found', version: '0.1.3' }));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.foundVersion(0.1.3)');
  });

  it('puts a found version off with 稍后, without downloading it', async () => {
    mocks.run.mockImplementation(async ({ action }: { action: string }) =>
      state({ phase: 'found', version: '0.1.3', dismissed: action === 'later' })
    );
    await renderNotice(state({ phase: 'found', version: '0.1.3' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'update.later' }));
    });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith({ action: 'later' });
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument();
  });

  it('offers the restart once the update is ready, and puts it off with 稍后', async () => {
    await renderNotice(state({ phase: 'ready', version: '0.1.3' }));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.readyTitle(0.1.3)');

    fireEvent.click(screen.getByRole('button', { name: 'update.restartToUpdate' }));
    expect(mocks.run).toHaveBeenCalledWith({ action: 'restart' });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'update.later' }));
    });
    expect(mocks.run).toHaveBeenCalledWith({ action: 'later' });
    // The answer says it is put off: the notice goes.
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument();
  });

  it('turns into the restart offer when the main process says the update is ready', async () => {
    await renderNotice(state({ phase: 'downloading', version: '0.1.3', percent: 90 }));
    expect(screen.queryByRole('button', { name: 'update.restartToUpdate' })).not.toBeInTheDocument();
    act(() => mocks.push?.(state({ phase: 'ready', version: '0.1.3' })));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.readyTitle(0.1.3)');
    expect(screen.getByRole('button', { name: 'update.restartToUpdate' })).toBeInTheDocument();
  });

  it('stays away for a version put off before', async () => {
    await renderNotice(state({ phase: 'ready', version: '0.1.3', dismissed: true }));
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument();
  });

  it('says when the last update could not be installed on quit', async () => {
    await renderNotice(state({ phase: 'ready', version: '0.1.3', lastInstallFailed: true }));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.lastInstallFailed');
  });

  it('holds the restart button while the installer takes over', async () => {
    await renderNotice(state({ phase: 'installing', version: '0.1.3' }));
    expect(screen.getByRole('button', { name: /update.preparingInstall/ })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'update.later' })).not.toBeInTheDocument();
  });

  it('on Linux, offers the installer and says why it does not install itself', async () => {
    await renderNotice(
      state({
        phase: 'available',
        method: 'installer',
        version: '0.1.3',
        installerReason: 'linux',
        installerName: 'mu-0.1.3-linux-amd64.deb',
      })
    );
    const notice = screen.getByTestId('update-notice');
    expect(notice).toHaveTextContent('update.availableVersion(0.1.3)');
    expect(notice).toHaveTextContent('update.installerReason.linux');
    fireEvent.click(screen.getByRole('button', { name: 'update.downloadInstaller' }));
    expect(mocks.run).toHaveBeenCalledWith({ action: 'downloadInstaller' });
  });

  it('says in one sentence what went wrong, and leads to the release page without an installer', async () => {
    await renderNotice(
      state({
        phase: 'available',
        version: '0.1.3',
        installerReason: 'autoUpdateFailed',
        error: { code: 'network' },
      })
    );
    const notice = screen.getByTestId('update-notice');
    expect(notice).toHaveTextContent('update.errors.network');
    expect(notice).toHaveTextContent('update.installerReason.autoUpdateFailed');
    fireEvent.click(screen.getByRole('button', { name: 'update.openReleasePage' }));
    expect(mocks.run).toHaveBeenCalledWith({ action: 'openReleasePage' });
  });

  it('shows the installer download and then opens the installer', async () => {
    await renderNotice(state({ phase: 'downloadingInstaller', version: '0.1.3', percent: 42 }));
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.downloadingInstaller(42%)');

    act(() =>
      mocks.push?.(state({ phase: 'installerReady', version: '0.1.3', installerPath: '/Downloads/mu-0.1.3.deb' }))
    );
    expect(screen.getByTestId('update-notice')).toHaveTextContent('update.installerReadyTitle(0.1.3)');
    fireEvent.click(screen.getByRole('button', { name: 'update.openInstaller' }));
    expect(mocks.run).toHaveBeenCalledWith({ action: 'openInstaller' });
  });

  it('in the collapsed sidebar is an icon that leads to 关于', async () => {
    await renderNotice(state({ phase: 'ready', version: '0.1.3' }), true);
    const icon = screen.getByTestId('update-notice');
    expect(icon).toHaveAttribute('aria-label', 'update.readyTitle(0.1.3)');
    fireEvent.click(icon);
    expect(mocks.navigate).toHaveBeenCalledWith('/settings/about');
  });

  it('is not there outside the desktop app', async () => {
    mocks.isElectron = false;
    await renderNotice(state({ phase: 'ready', version: '0.1.3' }));
    expect(screen.queryByTestId('update-notice')).not.toBeInTheDocument();
    expect(mocks.getState).not.toHaveBeenCalled();
  });
});
