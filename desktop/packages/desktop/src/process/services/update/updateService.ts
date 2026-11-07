import type {
  GitHubReleaseAsset,
  InstallerReason,
  UpdateAction,
  UpdatePhase,
  UpdateReleaseInfo,
  UpdateState,
} from '@/common/update/updateTypes';
import { classifyUpdateError, updateErrorDetail, type UpdateErrorInfo } from '@/common/update/updateErrors';
import { isNewerVersion, MU_RELEASES_URL } from './githubReleases';

/** A check a little after the start, once mu has settled... */
export const FIRST_CHECK_DELAY_MS = 30_000;
/** ...and then every 6 hours. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

/** A newer version the update feed offers, and how many bytes its download is, when the feed says. */
export type RestartUpdate = { version: string; size?: number };

/** The way an update installs itself on a restart: electron-updater, on macOS and Windows (autoUpdaterService.ts). */
export interface RestartUpdater {
  /** The newer version the update feed offers, or null. Downloads nothing. Throws when the check fails. */
  check(): Promise<RestartUpdate | null>;
  /** Downloads the version the last check found; resolves once a restart installs it. */
  download(onProgress: (percent: number) => void): Promise<void>;
  /** Throws when the downloaded update cannot be installed now. */
  prepareInstall(): Promise<void>;
  /** Quits mu and installs the update; resolves once the installer has taken over. */
  quitAndInstall(): Promise<void>;
}

type Logger = {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
};

export interface UpdateServiceDeps {
  currentVersion: string;
  /** Present where an update installs on a restart; without it every update comes as an installer. */
  restartUpdater?: RestartUpdater;
  /** Why this system's updates come as installers, when there is no restartUpdater. */
  installerReason: Exclude<InstallerReason, 'autoUpdateFailed'>;
  /** The newest release of github.com/qybaihe/mu, from GitHub's API. */
  latestRelease: () => Promise<UpdateReleaseInfo | null>;
  /** Downloads an installer into the Downloads folder and answers with its path. */
  downloadInstaller: (asset: GitHubReleaseAsset, onProgress: (percent: number) => void) => Promise<string>;
  /** Opens a file with its system application: an empty string when it did, else why not. */
  openPath: (filePath: string) => Promise<string>;
  showItemInFolder: (filePath: string) => void;
  openExternal: (url: string) => Promise<void>;
  /** Sends each new state to the app's windows. */
  broadcast: (state: UpdateState) => void;
  /** Keeps each new phase for diagnostics. */
  record?: (state: UpdateState) => void;
  /** Windows: whether the installer left word that the last update could not be installed on quit (and forgets it). */
  consumeInstallerFailure?: () => Promise<boolean>;
  log: Logger;
}

type InstallHooks = {
  /** Runs before the installer takes over: mu's backend must not hold the files the installer replaces. */
  beforeInstall?: () => Promise<void>;
  /** Starts mu again, when the installer did not take over after beforeInstall ran. */
  relaunch?: () => void;
};

const BUSY_PHASES: ReadonlySet<UpdatePhase> = new Set(['downloading', 'installing', 'downloadingInstaller']);
/** An update of the restart way on offer or under way: a failed check leaves it as it is. */
const IN_HAND_PHASES: ReadonlySet<UpdatePhase> = new Set(['found', 'downloading', 'ready', 'installing']);
/** Phases that hold nothing newer: a check may replace them with its answer. */
const EMPTY_PHASES: ReadonlySet<UpdatePhase> = new Set(['idle', 'upToDate', 'failed']);

/**
 * The update state machine of the main process, behind the notice in the sidebar and the update row of 关于 (About).
 * Nothing downloads until the person asks for it.
 *
 * With a restart updater (macOS, Windows): a check that finds a newer version offers it (`found`, with its size);
 * 下载 downloads it, and once it is `ready`, 重启并更新 installs it, and so does the next quit (稍后 only hides the
 * notice). 稍后 on a `found` version hides the notice until the next check and downloads nothing. When a check, the
 * download or the install fails, mu falls back to the release's installer (`available`, reason `autoUpdateFailed`),
 * which the person downloads and opens, as on Linux, where every update comes that way.
 */
export class UpdateService {
  private readonly deps: UpdateServiceDeps;
  private state: UpdateState;
  private hooks: InstallHooks = {};
  /** The release behind an `available` update: its installer and its page. */
  private release: UpdateReleaseInfo | null = null;
  private runningCheck: Promise<UpdateState> | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private started = false;

  constructor(deps: UpdateServiceDeps) {
    this.deps = deps;
    this.state = {
      phase: 'idle',
      checking: false,
      method: deps.restartUpdater ? 'restart' : 'installer',
      currentVersion: deps.currentVersion,
      dismissed: false,
      lastInstallFailed: false,
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  setInstallHooks(hooks: InstallHooks): void {
    this.hooks = hooks;
  }

  /** Checks a little after the start and then every 6 hours. Only the first call counts. */
  start(options: { firstCheckDelayMs?: number; intervalMs?: number } = {}): void {
    if (this.started) return;
    this.started = true;
    void this.readInstallerFailure();
    this.timers.push(
      setTimeout(() => void this.check(), options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS),
      setInterval(() => void this.check(), options.intervalMs ?? CHECK_INTERVAL_MS)
    );
  }

  stop(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.started = false;
  }

  /**
   * One step the person takes. Answers with the state after it, never with an error (the renderer waits for the
   * answer); downloads go on in the background.
   */
  async run(action: UpdateAction): Promise<UpdateState> {
    try {
      switch (action) {
        case 'check':
          return await this.check();
        case 'download':
          this.startDownload();
          break;
        case 'restart':
          return await this.restart();
        case 'later':
          this.set({ dismissed: true });
          break;
        case 'downloadInstaller':
          this.startInstallerDownload();
          break;
        case 'openInstaller':
          await this.openInstaller();
          break;
        case 'showInstaller':
          if (this.state.installerPath) this.deps.showItemInFolder(this.state.installerPath);
          break;
        case 'openReleasePage':
          await this.deps.openExternal(this.release?.htmlUrl ?? MU_RELEASES_URL);
          break;
      }
    } catch (error) {
      this.deps.log.warn(`[update] "${action}" failed`, updateErrorDetail(error));
    }
    return this.state;
  }

  /** Looks for a newer version and answers once the check is done. A check never downloads. */
  check(): Promise<UpdateState> {
    if (this.runningCheck) return this.runningCheck;
    if (BUSY_PHASES.has(this.state.phase)) return Promise.resolve(this.state);
    this.set({ checking: true });
    this.runningCheck = this.runCheck()
      .catch((error: unknown) => this.deps.log.warn('[update] The check stopped', updateErrorDetail(error)))
      .then(() => {
        this.runningCheck = null;
        this.set({ checking: false });
        return this.state;
      });
    return this.runningCheck;
  }

  private async runCheck(): Promise<void> {
    const updater = this.deps.restartUpdater;
    if (!updater) {
      await this.checkReleases();
      return;
    }
    let found: RestartUpdate | null;
    try {
      found = await updater.check();
    } catch (error) {
      // An update on offer or under way stays as it is: the last check that worked found it, a download the person
      // started goes on, and a downloaded update still installs on a restart or the next quit.
      if (IN_HAND_PHASES.has(this.state.phase)) {
        this.deps.log.warn('[update] The update check failed; keeping the update in hand', updateErrorDetail(error));
        return;
      }
      this.deps.log.warn(
        '[update] The update check failed; asking GitHub for the newest release',
        updateErrorDetail(error)
      );
      await this.checkReleases(classifyUpdateError(error, 'checkFailed'));
      return;
    }
    if (found) this.offerDownload(found);
    else this.foundNothing();
  }

  /** Asks GitHub's API for the newest release: every check where updates come as installers, else the fallback. */
  private async checkReleases(restartError?: UpdateErrorInfo): Promise<void> {
    let release: UpdateReleaseInfo | null;
    try {
      release = await this.deps.latestRelease();
    } catch (error) {
      this.deps.log.warn('[update] Could not look up the newest release', updateErrorDetail(error));
      if (EMPTY_PHASES.has(this.state.phase))
        this.set({ phase: 'failed', error: classifyUpdateError(error, 'checkFailed') });
      return;
    }
    if (!release || !isNewerVersion(release.version, this.state.currentVersion)) {
      this.foundNothing();
      return;
    }
    this.offerInstaller(release, restartError);
  }

  private foundNothing(): void {
    const { phase } = this.state;
    if (EMPTY_PHASES.has(phase) || phase === 'found' || phase === 'available') {
      this.release = null;
      this.set({
        phase: 'upToDate',
        version: undefined,
        size: undefined,
        error: undefined,
        installerReason: undefined,
        percent: undefined,
      });
    }
  }

  /** A newer version the restart updater can download: offered, not downloaded. */
  private offerDownload({ version, size }: RestartUpdate): void {
    const { phase, version: known } = this.state;
    // A download or an install under way goes on (a check that began before 下载 can answer after it).
    if (phase === 'downloading' || phase === 'installing') return;
    // Already downloaded, or its installer is being fetched or waiting to be opened: nothing new to offer.
    if (known === version && (phase === 'ready' || phase === 'installerReady' || phase === 'downloadingInstaller'))
      return;
    this.release = null;
    this.set({
      phase: 'found',
      version,
      size,
      percent: undefined,
      error: undefined,
      installerReason: undefined,
      installerName: undefined,
      installerPath: undefined,
      // 稍后 on a found version lasts until the next check: each check offers it again.
      dismissed: false,
    });
  }

  /** 下载: the person asks for the update the last check found. */
  private startDownload(): void {
    const updater = this.deps.restartUpdater;
    const { phase, version } = this.state;
    if (!updater || phase !== 'found' || !version) return;
    this.set({ phase: 'downloading', percent: 0, dismissed: false });
    void updater
      .download((percent) => this.progress(percent))
      .then(() => {
        this.deps.log.info('[update] Ready to install', version);
        this.set({ phase: 'ready', percent: undefined, dismissed: false });
      })
      .catch((error: unknown) => {
        this.deps.log.warn('[update] The download failed', updateErrorDetail(error));
        return this.fallBackToInstaller(version, classifyUpdateError(error, 'downloadFailed'));
      });
  }

  /** The restart way failed: offer the release's installer instead, and say why. */
  private async fallBackToInstaller(version: string, error: UpdateErrorInfo): Promise<void> {
    let release: UpdateReleaseInfo | null = null;
    try {
      release = await this.deps.latestRelease();
    } catch (lookupError) {
      this.deps.log.warn('[update] Could not look up the release for its installer', updateErrorDetail(lookupError));
    }
    const offered =
      release && isNewerVersion(release.version, this.state.currentVersion)
        ? release
        : // Without GitHub's answer the notice still leads to the release page.
          {
            tagName: `v${version}`,
            version,
            htmlUrl: `${MU_RELEASES_URL}/tag/v${version}`,
            prerelease: true,
            assets: [],
          };
    this.offerInstaller(offered, error);
  }

  private offerInstaller(release: UpdateReleaseInfo, restartError?: UpdateErrorInfo): void {
    const { phase, version: known, dismissed } = this.state;
    if (known === release.version && (phase === 'downloadingInstaller' || phase === 'installerReady')) return;
    this.release = release;
    this.set({
      phase: 'available',
      version: release.version,
      size: undefined,
      percent: undefined,
      error: restartError,
      installerReason: restartError ? 'autoUpdateFailed' : this.deps.installerReason,
      installerName: release.recommendedAsset?.name,
      installerPath: undefined,
      dismissed: known === release.version && dismissed,
    });
  }

  private startInstallerDownload(): void {
    const asset = this.release?.recommendedAsset;
    if (this.state.phase !== 'available' || !asset) return;
    this.set({ phase: 'downloadingInstaller', percent: 0 });
    void this.deps
      .downloadInstaller(asset, (percent) => this.progress(percent))
      .then((installerPath) => {
        this.deps.log.info('[update] The installer is downloaded', installerPath);
        this.set({ phase: 'installerReady', installerPath, percent: undefined, error: undefined });
      })
      .catch((error: unknown) => {
        this.deps.log.warn('[update] The installer download failed', updateErrorDetail(error));
        this.set({ phase: 'available', percent: undefined, error: classifyUpdateError(error, 'downloadFailed') });
      });
  }

  private async openInstaller(): Promise<void> {
    const { installerPath } = this.state;
    if (this.state.phase !== 'installerReady' || !installerPath) return;
    const problem = await this.deps.openPath(installerPath);
    if (problem) {
      // Nothing opens this kind of file here: show it in its folder instead.
      this.deps.log.warn('[update] Could not open the installer', problem);
      this.deps.showItemInFolder(installerPath);
    }
  }

  private async restart(): Promise<UpdateState> {
    const updater = this.deps.restartUpdater;
    const { phase, version } = this.state;
    if (!updater || phase !== 'ready' || !version) return this.state;
    this.set({ phase: 'installing' });
    try {
      await updater.prepareInstall();
    } catch (error) {
      this.deps.log.warn('[update] The update cannot be installed', updateErrorDetail(error));
      await this.fallBackToInstaller(version, classifyUpdateError(error, 'prepareInstallFailed'));
      return this.state;
    }
    try {
      await this.hooks.beforeInstall?.();
    } catch (error) {
      this.deps.log.warn('[update] The cleanup before the install failed; installing anyway', updateErrorDetail(error));
    }
    try {
      await updater.quitAndInstall();
    } catch (error) {
      this.deps.log.warn('[update] The installer did not take over', updateErrorDetail(error));
      if (this.hooks.relaunch) {
        // mu's backend has stopped for the installer: start mu again rather than leave it without one. The update
        // is still downloaded, so the next check offers it again, and a quit installs it.
        this.hooks.relaunch();
      } else {
        await this.fallBackToInstaller(version, classifyUpdateError(error, 'prepareInstallFailed'));
      }
    }
    return this.state;
  }

  private progress(percent: number): void {
    const rounded = Math.max(0, Math.min(100, Math.floor(percent)));
    if (rounded !== this.state.percent) this.set({ percent: rounded });
  }

  private async readInstallerFailure(): Promise<void> {
    try {
      if (await this.deps.consumeInstallerFailure?.()) this.set({ lastInstallFailed: true });
    } catch (error) {
      this.deps.log.warn('[update] Could not read the installer failure marker', updateErrorDetail(error));
    }
  }

  private set(patch: Partial<UpdateState>): void {
    const previous = this.state;
    this.state = { ...previous, ...patch };
    if (this.state.phase !== previous.phase) this.deps.record?.(this.state);
    this.deps.broadcast(this.state);
  }
}
