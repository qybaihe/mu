/**
 * The update state machine of the main process, driven through electron-updater (mocked): a check finds a version and
 * offers it with its size, nothing downloads until the person chooses 下载, the update is then ready, and 重启并更新
 * hands it to the installer; and when a check, the download or the install fails, the release's installer is offered
 * instead, as on Linux.
 */

import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdatePhase, UpdateReleaseInfo, UpdateState } from '@/common/update/updateTypes';

vi.mock('electron-updater', async () => {
  const { EventEmitter } = await import('node:events');
  const autoUpdater = Object.assign(new EventEmitter(), {
    logger: null as unknown,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    disableWebInstaller: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  });
  return { autoUpdater };
});

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    app: {
      getVersion: vi.fn(() => '0.1.2'),
      getPath: vi.fn(() => os.tmpdir()),
      exit: vi.fn(),
    },
    autoUpdater: new EventEmitter(),
  };
});

vi.mock('electron-log', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/process/services/update/autoUpdateDiagnostics', () => ({
  recordAutoUpdateNativeInstallError: vi.fn(),
  recordAutoUpdateNativeInstallReady: vi.fn(),
  recordAutoUpdateNativeInstallTimeout: vi.fn(),
  recordAutoUpdateQuitAndInstall: vi.fn(),
  recordUpdateState: vi.fn(),
}));

import { app, autoUpdater as nativeAutoUpdater } from 'electron';
import { autoUpdater } from 'electron-updater';
import { AutoUpdaterService } from '@/process/services/update/autoUpdaterService';
import { UpdateService, type UpdateServiceDeps } from '@/process/services/update/updateService';

const updater = vi.mocked(autoUpdater);
const realPlatform = process.platform;
const realArch = process.arch;
const setPlatform = (platform: NodeJS.Platform, arch: NodeJS.Architecture = 'arm64') => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  Object.defineProperty(process, 'arch', { value: arch, configurable: true });
};

// The files of the merged feeds, as the release job writes them: latest-mac.yml gives each zip and disk image its size;
// latest.yml has none for the installers (electron-builder writes no size for NSIS without a differential package).
const macFiles = (version: string) => [
  { url: `mu-${version}-mac-x64.zip`, sha512: 'a', size: 214_523_871 },
  { url: `mu-${version}-mac-x64.dmg`, sha512: 'b', size: 221_839_104 },
  { url: `mu-${version}-mac-arm64.zip`, sha512: 'c', size: 206_117_345 },
  { url: `mu-${version}-mac-arm64.dmg`, sha512: 'd', size: 213_207_011 },
];
const windowsFiles = (version: string, sizes?: [number, number]) => [
  { url: `mu-${version}-win-x64.exe`, sha512: 'e', ...(sizes ? { size: sizes[0] } : {}) },
  { url: `mu-${version}-win-arm64.exe`, sha512: 'f', ...(sizes ? { size: sizes[1] } : {}) },
];

const offer = (version: string, files = process.platform === 'darwin' ? macFiles(version) : windowsFiles(version)) => ({
  isUpdateAvailable: true,
  updateInfo: { version, files },
  versionInfo: { version },
});

const release = (version: string, installer: string | null = `mu-${version}-mac-arm64.dmg`): UpdateReleaseInfo => {
  const assets = installer
    ? [{ name: installer, url: `https://github.com/qybaihe/mu/releases/download/v${version}/${installer}`, size: 1 }]
    : [];
  return {
    tagName: `v${version}`,
    version,
    htmlUrl: `https://github.com/qybaihe/mu/releases/tag/v${version}`,
    prerelease: true,
    assets,
    recommendedAsset: assets[0],
  };
};

const makeService = (overrides: Partial<UpdateServiceDeps> = {}) => {
  const deps = {
    currentVersion: '0.1.2',
    restartUpdater: new AutoUpdaterService(),
    installerReason: 'unpackaged' as const,
    latestRelease: vi.fn(async (): Promise<UpdateReleaseInfo | null> => release('0.1.3')),
    downloadInstaller: vi.fn(async () => '/Users/me/Downloads/mu-0.1.3-mac-arm64.dmg'),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    broadcast: vi.fn<(state: UpdateState) => void>(),
    record: vi.fn(),
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
  return { service: new UpdateService(deps), deps };
};

/** A check that finds 0.1.3, then 下载: the update downloads (Windows: it is ready once downloaded). */
const findAndDownload = async (service: UpdateService) => {
  expect((await service.check()).phase).toBe('found');
  return service.run('download');
};

const phases = (broadcast: { mock: { calls: [UpdateState][] } }): UpdatePhase[] =>
  broadcast.mock.calls.map(([state]) => state.phase).filter((phase, i, all) => phase !== all[i - 1]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  updater.removeAllListeners();
  nativeAutoUpdater.removeAllListeners();
  updater.checkForUpdates.mockReset();
  updater.quitAndInstall.mockReset();
  updater.downloadUpdate.mockReset().mockResolvedValue([]);
  // A Windows install moves the process out of the install folder; this test process stays where it is.
  vi.spyOn(process, 'chdir').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setPlatform(realPlatform, realArch);
});

describe('updates that install on a restart (electron-updater)', () => {
  it('reads the pre-releases of qybaihe/mu, never downloads on its own, and installs a downloaded update on quit', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(null);
    const { service } = makeService();
    await service.check();
    expect(updater.setFeedURL).toHaveBeenCalledWith({ provider: 'github', owner: 'qybaihe', repo: 'mu' });
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    // No channel: a channel would read another feed file and allow downgrades.
    expect('channel' in updater).toBe(false);
  });

  it('macOS: a check offers the update with its size; 下载 downloads it, ready once Squirrel.Mac has it', async () => {
    setPlatform('darwin', 'arm64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42.7, bytesPerSecond: 1, total: 100, transferred: 42 });
      return [];
    });
    const { service, deps } = makeService();
    const beforeInstall = vi.fn(async () => undefined);
    service.setInstallHooks({ beforeInstall });

    // The size of this Mac's zip, the file electron-updater would download; nothing is downloaded yet.
    expect(await service.check()).toMatchObject({
      phase: 'found',
      version: '0.1.3',
      size: 206_117_345,
      checking: false,
    });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();

    expect((await service.run('download')).phase).toBe('downloading');
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(deps.broadcast).toHaveBeenCalledWith(expect.objectContaining({ percent: 42 })));
    // Downloaded, but Squirrel.Mac has not unpacked and checked it yet: not ready.
    expect(service.getState().phase).toBe('downloading');

    nativeAutoUpdater.emit('update-downloaded');
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));
    expect(phases(deps.broadcast)).toEqual(['idle', 'found', 'downloading', 'ready']);

    updater.quitAndInstall.mockImplementation(() => {
      expect(beforeInstall).toHaveBeenCalledTimes(1);
      nativeAutoUpdater.emit('before-quit-for-update');
    });
    const restarted = await service.run('restart');
    expect(restarted.phase).toBe('installing');
    // Not silent: the installer shows its progress and starts mu again.
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(app.exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    // mu may keep running with its windows closed; it exits so the installer can replace it.
    expect(app.exit).toHaveBeenCalledWith(0);
  });

  it('Windows: offered without a size (the feed gives none), ready as soon as the download is done', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    const found = await service.check();
    expect(found).toMatchObject({ phase: 'found', version: '0.1.3' });
    expect(found.size).toBeUndefined();

    await service.run('download');
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));

    updater.quitAndInstall.mockImplementation(() => nativeAutoUpdater.emit('before-quit-for-update'));
    await service.run('restart');
    // The installer replaces the install folder: the process leaves it first.
    expect(process.chdir).toHaveBeenCalledWith(expect.stringContaining('mu-updater-cwd'));
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("takes the size of this system's own file from the feed", async () => {
    const sizeOn = async (platform: NodeJS.Platform, arch: NodeJS.Architecture, files: unknown[]) => {
      setPlatform(platform, arch);
      updater.checkForUpdates.mockResolvedValue(offer('0.1.3', files as ReturnType<typeof macFiles>));
      return (await makeService().service.check()).size;
    };
    expect(await sizeOn('darwin', 'x64', macFiles('0.1.3'))).toBe(214_523_871);
    expect(await sizeOn('darwin', 'arm64', macFiles('0.1.3'))).toBe(206_117_345);
    expect(await sizeOn('win32', 'arm64', windowsFiles('0.1.3', [160_000_000, 150_000_000]))).toBe(150_000_000);
    expect(await sizeOn('win32', 'x64', windowsFiles('0.1.3', [160_000_000, 150_000_000]))).toBe(160_000_000);
    expect(await sizeOn('win32', 'x64', windowsFiles('0.1.3'))).toBeUndefined();
  });

  it('稍后 on a found update hides the notice until the next check and never downloads', async () => {
    setPlatform('darwin', 'arm64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    await service.check();

    expect(await service.run('later')).toMatchObject({ phase: 'found', dismissed: true });
    // The next check offers it again.
    expect(await service.check()).toMatchObject({ phase: 'found', version: '0.1.3', dismissed: false });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('downloads nothing on 下载 without a found update', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.2'));
    const { service } = makeService();
    expect((await service.run('download')).phase).toBe('idle');
    await service.check();
    expect((await service.run('download')).phase).toBe('upToDate');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('a later check leaves a ready update alone, and offers a newer version without downloading it', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service, deps } = makeService();
    await findAndDownload(service);
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));

    // 稍后 after the download: the notice goes, and the update still installs on quit (autoInstallOnAppQuit).
    expect((await service.run('later')).dismissed).toBe(true);
    await service.check();
    expect(service.getState()).toMatchObject({ phase: 'ready', version: '0.1.3', dismissed: true });

    updater.checkForUpdates.mockResolvedValue(offer('0.1.4'));
    expect(await service.check()).toMatchObject({ phase: 'found', version: '0.1.4', dismissed: false });
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(phases(deps.broadcast)).toEqual(['idle', 'found', 'downloading', 'ready', 'found']);
  });

  it('keeps the update in hand when a later check fails, instead of falling back to the installer', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service, deps } = makeService();
    await service.check();

    updater.checkForUpdates.mockRejectedValue(new Error('HttpError: 502 Bad Gateway'));
    deps.latestRelease.mockResolvedValue(release('0.1.4'));
    expect(await service.check()).toMatchObject({ phase: 'found', version: '0.1.3', checking: false });

    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    await findAndDownload(service);
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));
    updater.checkForUpdates.mockRejectedValue(new Error('HttpError: 502 Bad Gateway'));
    expect(await service.check()).toMatchObject({ phase: 'ready', version: '0.1.3', checking: false });
    expect(deps.latestRelease).not.toHaveBeenCalled();
  });

  it.each([
    ['finds the same version', async () => offer('0.1.3')],
    [
      'fails',
      async () => {
        throw new Error('HttpError: 502 Bad Gateway');
      },
    ],
  ])('lets a download the person started go on when a check that began before it %s', async (_, answer) => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    let finishDownload: (() => void) | null = null;
    updater.downloadUpdate.mockImplementation(() => new Promise((resolve) => (finishDownload = () => resolve([]))));
    const { service, deps } = makeService();
    await service.check();

    let answerCheck: (() => void) | null = null;
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise((resolve, reject) => (answerCheck = () => void answer().then(resolve, reject)))
    );
    const checking = service.check();
    await vi.waitFor(() => expect(updater.checkForUpdates).toHaveBeenCalledTimes(2));
    expect((await service.run('download')).phase).toBe('downloading');
    answerCheck?.();
    await checking;
    expect(service.getState().phase).toBe('downloading');
    expect(deps.latestRelease).not.toHaveBeenCalled();

    finishDownload?.();
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
  });

  it('says it is up to date when the feed no longer offers a found version', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    await service.check();
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '0.1.2' } });
    expect(await service.check()).toMatchObject({ phase: 'upToDate', version: undefined, size: undefined });
  });

  it('never offers a version that is not newer than the one running', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.2'));
    const { service } = makeService();
    expect(await service.check()).toMatchObject({ phase: 'upToDate', checking: false });
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
  });

  it('reports up to date, then a failed check in one sentence code', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '0.1.2' } });
    const { service, deps } = makeService();
    expect(await service.check()).toMatchObject({ phase: 'upToDate' });

    updater.checkForUpdates.mockRejectedValue(new Error('net::ERR_INTERNET_DISCONNECTED'));
    deps.latestRelease.mockRejectedValue(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }));
    expect(await service.check()).toMatchObject({ phase: 'failed', error: { code: 'network' } });
  });
});

describe('falling back to the installer', () => {
  it('offers the release installer when the update check fails, then downloads and opens it', async () => {
    setPlatform('darwin', 'arm64');
    updater.checkForUpdates.mockRejectedValue(
      new Error('Cannot find latest-mac.yml in the latest release artifacts (https://github.com/x): HttpError: 404')
    );
    const { service, deps } = makeService();

    expect(await service.check()).toMatchObject({
      phase: 'available',
      version: '0.1.3',
      installerReason: 'autoUpdateFailed',
      error: { code: 'noUpdateInfo' },
      installerName: 'mu-0.1.3-mac-arm64.dmg',
    });
    // The installer downloads only when the person asks for it, too.
    expect(deps.downloadInstaller).not.toHaveBeenCalled();

    expect((await service.run('downloadInstaller')).phase).toBe('downloadingInstaller');
    expect(deps.downloadInstaller).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'mu-0.1.3-mac-arm64.dmg' }),
      expect.any(Function)
    );
    await vi.waitFor(() => expect(service.getState().phase).toBe('installerReady'));
    expect(service.getState().installerPath).toBe('/Users/me/Downloads/mu-0.1.3-mac-arm64.dmg');

    await service.run('openInstaller');
    expect(deps.openPath).toHaveBeenCalledWith('/Users/me/Downloads/mu-0.1.3-mac-arm64.dmg');
  });

  it('says it is up to date when the check fails but GitHub has nothing newer', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockRejectedValue(new Error('HttpError: 503 Service Unavailable'));
    const { service, deps } = makeService();
    deps.latestRelease.mockResolvedValue(release('0.1.2'));
    expect(await service.check()).toMatchObject({ phase: 'upToDate' });
  });

  it('offers the installer when the download fails', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    updater.downloadUpdate.mockRejectedValue(new Error('net::ERR_CONNECTION_RESET'));
    const { service, deps } = makeService();
    await findAndDownload(service);
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({
        phase: 'available',
        installerReason: 'autoUpdateFailed',
        error: { code: 'network' },
      })
    );
    expect(phases(deps.broadcast)).toEqual(['idle', 'found', 'downloading', 'available']);
  });

  it('macOS: offers the installer when Squirrel.Mac refuses the update (an unsigned build)', async () => {
    setPlatform('darwin', 'arm64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    await findAndDownload(service);
    await vi.waitFor(() => expect(updater.downloadUpdate).toHaveBeenCalled());
    nativeAutoUpdater.emit('error', new Error('Code signature at URL file:///x/mu.app did not pass validation'));
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ phase: 'available', error: { code: 'prepareInstallFailed' } })
    );
  });

  it('leads to the release page when GitHub cannot say which installer', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    updater.downloadUpdate.mockRejectedValue(new Error('sha512 checksum mismatch'));
    const { service, deps } = makeService();
    deps.latestRelease.mockRejectedValue(new Error('HttpError: 403 rate limit'));
    await findAndDownload(service);
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ phase: 'available', error: { code: 'downloadFailed' } })
    );
    expect(service.getState().installerName).toBeUndefined();
    await service.run('openReleasePage');
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/qybaihe/mu/releases/tag/v0.1.3');
  });

  it('starts mu again when the installer does not take over after the backend stopped', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    const relaunch = vi.fn();
    service.setInstallHooks({ beforeInstall: vi.fn(async () => undefined), relaunch });
    await findAndDownload(service);
    await vi.waitFor(() => expect(service.getState().phase).toBe('ready'));

    // electron-updater found no installer to run: no before-quit-for-update.
    const restarting = service.run('restart');
    await vi.advanceTimersByTimeAsync(5_000);
    await restarting;
    expect(relaunch).toHaveBeenCalledTimes(1);
    expect(app.exit).not.toHaveBeenCalled();
  });
});

describe('updates that come as an installer (Linux)', () => {
  it('offers the installer, says why, and shows it in its folder when nothing opens it', async () => {
    const { service, deps } = makeService({
      restartUpdater: undefined,
      installerReason: 'linux',
      latestRelease: vi.fn(async () => release('0.1.3', 'mu-0.1.3-linux-amd64.deb')),
      downloadInstaller: vi.fn(async () => '/home/me/Downloads/mu-0.1.3-linux-amd64.deb'),
      openPath: vi.fn(async () => 'No application knows how to open this file'),
    });
    expect(service.getState().method).toBe('installer');
    expect(await service.check()).toMatchObject({
      phase: 'available',
      installerReason: 'linux',
      installerName: 'mu-0.1.3-linux-amd64.deb',
    });
    expect(service.getState().error).toBeUndefined();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(deps.downloadInstaller).not.toHaveBeenCalled();
    // 下载 belongs to the restart way; here the installer is the download.
    expect((await service.run('download')).phase).toBe('available');

    deps.downloadInstaller.mockRejectedValueOnce(new Error('socket hang up'));
    await service.run('downloadInstaller');
    await vi.waitFor(() =>
      expect(service.getState()).toMatchObject({ phase: 'available', error: { code: 'network' } })
    );

    await service.run('downloadInstaller');
    await vi.waitFor(() => expect(service.getState().phase).toBe('installerReady'));
    expect(service.getState().error).toBeUndefined();

    await service.run('openInstaller');
    expect(deps.showItemInFolder).toHaveBeenCalledWith('/home/me/Downloads/mu-0.1.3-linux-amd64.deb');
  });

  it('answers every step, even one that fails', async () => {
    const { service, deps } = makeService({ restartUpdater: undefined });
    deps.openExternal.mockRejectedValue(new Error('no browser'));
    await expect(service.run('openReleasePage')).resolves.toMatchObject({ phase: 'idle' });
    expect(deps.openExternal).toHaveBeenCalledWith('https://github.com/qybaihe/mu/releases');
  });
});

describe('the schedule', () => {
  it('checks a little after the start and then every 6 hours, and downloads nothing', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(offer('0.1.3'));
    const { service } = makeService();
    service.start();
    service.start();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(service.getState().phase).toBe('found');
    expect(updater.downloadUpdate).not.toHaveBeenCalled();
    service.stop();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('tells a ready update that the last one could not be installed on quit', async () => {
    setPlatform('win32', 'x64');
    updater.checkForUpdates.mockResolvedValue(null);
    const { service } = makeService({ consumeInstallerFailure: vi.fn(async () => true) });
    service.start();
    await vi.waitFor(() => expect(service.getState().lastInstallFailed).toBe(true));
    service.stop();
  });
});
