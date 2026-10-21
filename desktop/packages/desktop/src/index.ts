/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// configureChromium sets app name (dev isolation) and Chromium flags — must run before
// ANY module that calls app.getPath('userData'), because Electron caches the path on first call.
import './process/utils/configureChromium';
import { installGpuCrashHandler } from './process/utils/gpuRecovery';
import { describeUncaughtError } from './process/utils/describeUncaughtError';
import type { UncaughtErrorDiagnostics } from './process/utils/describeUncaughtError';
import { createRendererRecoveryPolicy } from './process/utils/rendererRecovery';
import './process/utils/configureConsoleLog';
import { app, BrowserWindow, ipcMain, nativeImage, powerMonitor, session, shell } from 'electron';
import fixPath from 'fix-path';
import * as fs from 'fs';
import * as path from 'path';
import { initMainAdapterWithWindow } from './common/adapter/main';
import { ipcBridge } from './common';
import { initializeProcess } from './process';
import { startBackendOrExit } from './process/startup/backendStartup';
import { planStartupNodeRuntime } from './process/startup/nodeRuntimeStartup';
import { assertStartupArchitectureCompatible } from './process/startup/architectureCompatibility';
import { classifyBackendStartupFailure } from './process/startup/backendStartupFailure';
import { installQuitCleanup } from './process/startup/quitCleanup';
import { shouldRegisterBackendStartup } from './process/startup/singleInstanceGating';
import { ProcessConfig } from './process/utils/initStorage';
import type { BackendStartupFailureInfo } from './common/types/platform/electron';
import { registerWindowMaximizeListeners } from '@process/bridge';
import { BackendLifecycleManager } from '@mu/web-host';
import { resolveBinaryPath } from '@process/backend';
import { wasLaunchedAtLogin } from '@process/bridge/applicationBridge';
import { applyStartupAppLanguage, onAppLanguageApplied } from '@process/services/i18n';
import { setApplicationMenuWindow, setupApplicationMenu } from './process/utils/appMenu';
import { getUpdateService } from './process/services/update';
import { initializeZoomFactor, setupZoomForWindow } from './process/utils/zoom';
import {
  followSystemAppearance,
  initializeWindowAppearance,
  windowBackgroundColor,
} from './process/utils/windowBackground';
import { hydrateWindowsProcessPath } from './process/startup/windowsPath';
import { registerWindowsAppUserModelId } from './process/startup/windowsAppUserModelId';
import {
  MIN_WINDOW_WIDTH,
  MIN_WINDOW_HEIGHT,
  attachWindowBoundsPersistence,
  loadSavedWindowBounds,
  resolveInitialBounds,
} from './process/utils/windowBounds';
import {
  clearPendingDeepLinkUrl,
  getPendingDeepLinkUrl,
  handleDeepLinkUrl,
  PROTOCOL_SCHEME,
} from './process/utils/deepLink';
import {
  bindMainWindowReferences,
  showAndFocusMainWindow,
  showOrCreateMainWindow,
} from './process/utils/mainWindowLifecycle';
import {
  createOrUpdateTray,
  destroyTray,
  getCloseToTrayEnabled,
  getIsQuitting,
  refreshTrayMenu,
  setCloseToTrayEnabled,
  setIsQuitting,
} from './process/utils/tray';
import { readCloseToTraySetting } from './process/utils/closeToTraySetting';
// @ts-expect-error - electron-squirrel-startup doesn't have types
import electronSquirrelStartup from 'electron-squirrel-startup';
import { BACKEND_INTERNAL_HEADER } from '@/common/platform/backendNames';

// ============ Single Instance Lock ============
// Acquire lock early so the second instance quits before doing unnecessary work.
// When a second instance starts (e.g. from protocol URL), it sends its data
// to the first instance via second-instance event, then quits.
const isE2ETestMode = process.env.MU_E2E_TEST === '1';
const skipSingleInstanceLock = isE2ETestMode || process.env.MU_MULTI_INSTANCE === '1';
const deepLinkFromArgv = process.argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
const gotTheLock = skipSingleInstanceLock ? true : app.requestSingleInstanceLock({ deepLinkUrl: deepLinkFromArgv });
if (!gotTheLock) {
  console.warn('[mu] Another instance is already running; current process will exit.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
    // Prefer additionalData (reliable on all platforms), fallback to argv scan
    const deepLinkUrl =
      (additionalData as { deepLinkUrl?: string })?.deepLinkUrl ||
      argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
    if (deepLinkUrl) {
      handleDeepLinkUrl(deepLinkUrl);
    }
    // Skip window creation if app hasn't finished initializing
    if (!appReadyDone) return;

    if (app.isReady()) {
      showOrCreateMainWindow({
        mainWindow,
        createWindow: () => {
          console.log('[mu] second-instance received with no active main window, recreating main window');
          createWindow();
        },
      });
    }
  });
}

// Align GUI-launched PATH with what local CLIs expect on each desktop OS.
if (process.platform === 'darwin' || process.platform === 'linux') {
  fixPath();

  // Supplement nvm paths that fix-path might miss (nvm is often only in .zshrc, not .zshenv)
  const nvmDir = process.env.NVM_DIR || path.join(process.env.HOME || '', '.nvm');
  const nvmVersionsDir = path.join(nvmDir, 'versions', 'node');
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir);
      const nvmPaths = versions.map((v) => path.join(nvmVersionsDir, v, 'bin')).filter((p) => fs.existsSync(p));
      if (nvmPaths.length > 0) {
        const currentPath = process.env.PATH || '';
        const missingPaths = nvmPaths.filter((p) => !currentPath.includes(p));
        if (missingPaths.length > 0) {
          process.env.PATH = [...missingPaths, currentPath].join(path.delimiter);
        }
      }
    } catch {
      // Ignore errors when reading nvm directory
    }
  }
} else if (process.platform === 'win32') {
  hydrateWindowsProcessPath();
  registerWindowsAppUserModelId({ app });
}

// Handle Squirrel startup events (Windows installer)
if (electronSquirrelStartup) {
  app.quit();
}

// Global error handlers for main process
// The handlers prevent Electron's default error dialog. Both swallow the failure and keep the process alive;
// they only log allow-listed attribution first, because an error such as `read ECONNRESET` otherwise carries
// nothing but Node-internal frames (TCP.onStreamRead) and cannot be traced back to a subsystem.
process.on('uncaughtException', (error, origin) => {
  logUncaught(describeUncaughtError(error, origin));
});

process.on('unhandledRejection', (reason, _promise) => {
  logUncaught(describeUncaughtError(reason, 'unhandledRejection'));
});

function logUncaught(diagnostics: UncaughtErrorDiagnostics): void {
  try {
    console.error(`[mu] ${diagnostics.origin}:`, diagnostics);
  } catch {
    // Logging must never escalate a swallowed error into a fatal one: a throw inside an
    // uncaughtException listener terminates the process, and the log transport itself can
    // fail (e.g. ENOSPC while appending to the daily log file).
  }
}

const hasCommand = (cmd: string) => process.argv.includes(cmd);

const isVersionMode = hasCommand('--version') || hasCommand('-v');

// Guard against premature window creation (e.g. macOS 'activate' firing during init).
// The activate event fires on first launch before handleAppReady finishes initializeProcess(),
// causing the renderer to load and compete with initStorage on the serial configFile queue,
// which blocks startup for 100-265 seconds.
let appReadyDone = false;

let mainWindow: BrowserWindow;
const backendManager = new BackendLifecycleManager(
  {
    version: app.getVersion(),
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
  },
  resolveBinaryPath
);
let disposeCronResumeListener: (() => void) | null = null;

// Flag tracking whether the backend subprocess started successfully. Read by
// the deferred runBackendMigrations trigger in createWindow().
let backendStartedOk = false;
let backendStartupFailed = false;
let backendStartupFailureInfo: BackendStartupFailureInfo | null = null;
let rendererInitialLanguage: string | null = null;
let backendMigrationsScheduled = false;
// The person put the Node.js runtime download off at this start: the backend runs without it (see
// process/startup/nodeRuntimeConsent.ts), and the renderer says so where it is needed.
let nodeRuntimeDeferred = false;

ipcMain.on('get-backend-port', (event) => {
  event.returnValue = backendManager.port;
});

ipcMain.on('get-initial-language', (event) => {
  event.returnValue = rendererInitialLanguage;
});

ipcMain.on('get-backend-startup-failed', (event) => {
  event.returnValue = backendStartupFailed;
});

ipcMain.on('get-backend-startup-failure', (event) => {
  event.returnValue = backendStartupFailureInfo;
});

ipcMain.on('get-node-runtime-deferred', (event) => {
  event.returnValue = nodeRuntimeDeferred;
});

ipcMain.handle('backend:recover-corrupted-database', async () => {
  const { recoverCorruptedDatabaseAfterUserConfirmation } = await import('./process/startup/recoverCorruptedDatabase');

  await recoverCorruptedDatabaseAfterUserConfirmation({
    getFailure: () => backendStartupFailureInfo,
    stopBackend: () => backendManager.stop(),
    startBackendWithRecovery: async () => {
      try {
        const { getDataPath } = await import('./process/utils/utils');
        const { getSystemDir } = await import('./process/utils/initStorage');
        const sysDir = getSystemDir();
        return await backendManager.start(
          getDataPath(),
          sysDir.logDir,
          {
            cacheDir: sysDir.cacheDir,
            workDir: sysDir.workDir,
            logDir: sysDir.logDir,
          },
          {
            allowPendingOnHealthTimeout: false,
            onHealthTimeout: (error) => {
              markBackendStartupFailed(error);
            },
            onPendingExit: (error) => {
              markBackendStartupFailed(error);
            },
            onReady: (backendPort) => {
              markBackendReady(backendPort, 'backendManager.recoverCorruptedDatabase.lateReady');
            },
          },
          undefined,
          { recoverCorruptedDatabase: true }
        );
      } catch (error) {
        markBackendStartupFailed(error);
        throw error;
      }
    },
    markReady: markBackendReady,
    reloadMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reload();
      }
    },
    logInfo: console.info,
    logWarn: console.warn,
  });
});

// The startup-failure dialogs' "open the log folder". Through the main process: the backend, and with it the
// shell bridge the rest of the app uses, may be what failed to start.
ipcMain.handle('backend:open-log-folder', async () => {
  const { getSystemDir } = await import('./process/utils/initStorage');
  const failure = await shell.openPath(getSystemDir().logDir);
  if (failure) throw new Error(failure);
});

// Push the latest backend startup state to the renderer so it can either show
// the "starting" view, switch to the honest-failure view, or return to the App.
// The renderer only reads window.__backendStartupFailure once at preload; this
// channel delivers subsequent ready/exit transitions.
function broadcastBackendStartupState(state: BackendStartupFailureInfo | null): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('backend-startup-state', state);
  }
}

function markBackendStartupFailed(error: unknown): void {
  backendStartupFailed = true;
  // Stamp the currently installed app version so failure dialogs (notably the
  // downgrade "update the app" dialog) can tell the user which version they are
  // on now — i.e. that they need something newer than this.
  backendStartupFailureInfo = { ...classifyBackendStartupFailure(error), appVersion: app.getVersion() };
  (globalThis as typeof globalThis & { __backendStartupFailed?: boolean }).__backendStartupFailed = true;
  broadcastBackendStartupState(backendStartupFailureInfo);
}

function registerCronResumeBridge(backendPort: number): void {
  disposeCronResumeListener?.();

  const onResume = () => {
    void fetch(`http://127.0.0.1:${backendPort}/api/cron/internal/system-resume`, {
      method: 'POST',
      headers: {
        [BACKEND_INTERNAL_HEADER]: '1',
      },
    }).catch((error) => {
      console.error('[mu] Failed to notify backend about system resume:', error);
    });
  };

  powerMonitor.on('resume', onResume);
  disposeCronResumeListener = () => {
    powerMonitor.removeListener('resume', onResume);
  };
}

/**
 * Run one-shot backend migrations after the renderer has loaded. Some steps
 * (ConfigStorage.get, ipcBridge.listProviders) route through the renderer via
 * BroadcastChannel, so invoking them before the renderer exists deadlocks the
 * main process. Called from did-finish-load.
 */
const scheduleBackendMigrations = (): void => {
  if (backendMigrationsScheduled || !backendStartedOk) return;
  backendMigrationsScheduled = true;
  void (async () => {
    try {
      const { runBackendMigrations } = await import('./process/utils/runBackendMigrations');
      await runBackendMigrations(ProcessConfig);
      console.info('[mu] runBackendMigrations completed');
    } catch (error) {
      console.error('[mu] Backend migration hook threw:', error);
    }
  })();
};

function exposeBackendPort(backendPort: number): void {
  // Expose the backend port to main-process callers of httpBridge (e.g. the
  // one-shot assistant migration hook below). Must land BEFORE any
  // ipcBridge.* invoke from the main process — the renderer side reads
  // window.__backendPort via preload, but main has no `window`.
  (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort = backendPort;
}

function markBackendReady(backendPort: number, source: string): void {
  if (backendStartedOk) return;
  console.log(`[mu] ${source} ready (port=${backendPort})`);
  exposeBackendPort(backendPort);
  registerCronResumeBridge(backendPort);
  backendStartedOk = true;
  backendStartupFailed = false;
  backendStartupFailureInfo = null;
  (globalThis as typeof globalThis & { __backendStartupFailed?: boolean }).__backendStartupFailed = false;
  // Backend is ready: tell the renderer to drop any "starting" view and show the App.
  broadcastBackendStartupState(null);
  scheduleBackendMigrations();
}

function resolveDebugBackendStartupFailure(): BackendStartupFailureInfo | null {
  const reason = process.env.MU_DEBUG_BACKEND_STARTUP_FAILURE as BackendStartupFailureInfo['reason'] | undefined;
  if (!reason) {
    return null;
  }
  if (app.isPackaged && !isE2ETestMode) {
    console.warn('[mu] Ignoring MU_DEBUG_BACKEND_STARTUP_FAILURE outside desktop dev/e2e mode.');
    return null;
  }

  if (reason === 'backend_incompatible_runtime') {
    return { reason, runtime: 'glibc', requiredVersions: ['2.28'] };
  }
  if (reason === 'backend_package_architecture_mismatch') {
    return {
      reason,
      deviceArch: process.arch === 'arm64' ? 'arm64' : 'x64',
      expectedDownloadArch: process.arch === 'arm64' ? 'arm64' : 'x64',
      packageArch: process.arch === 'arm64' ? 'x64' : 'arm64',
    };
  }
  if (reason === 'backend_startup_failed') {
    return {
      reason,
      backendBoundaryCode: 'E2E_DEBUG_BACKEND_STARTUP_FAILURE',
      backendBoundaryStage: 'debug_injection',
    };
  }
  if (reason === 'backend_incomplete_installation') {
    return {
      reason,
      incompleteInstallationKind: 'missing_directory_resources',
      missingRuntimeDir: true,
      missingResources: ['managed node runtime', 'ACP adapters'],
    };
  }
  if (reason === 'backend_startup_pending_slow') {
    return { reason };
  }
  if (reason === 'backend_startup_exited') {
    return { reason };
  }
  if (reason === 'backend_startup_port_report_timeout') {
    return { reason };
  }

  console.warn(`[mu] Ignoring unknown MU_DEBUG_BACKEND_STARTUP_FAILURE value: ${reason}`);
  return null;
}

function applyDebugBackendStartupFailure(failure: BackendStartupFailureInfo): void {
  backendStartupFailed = true;
  backendStartupFailureInfo = failure;
  (globalThis as typeof globalThis & { __backendStartupFailed?: boolean }).__backendStartupFailed = true;
}

const createWindow = ({ showOnReady = true }: { showOnReady?: boolean } = {}): void => {
  console.log('[mu] Creating main window...');
  const { x: windowX, y: windowY, width: windowWidth, height: windowHeight } = resolveInitialBounds();

  // Get app icon for development mode (Windows/Linux need icon in BrowserWindow)
  // In production, icons are set via forge.config.ts packagerConfig
  let devIcon: Electron.NativeImage | undefined;
  if (!app.isPackaged) {
    try {
      // Windows: app.ico (no dev version), Linux: app_dev.png (with padding)
      const iconFile = process.platform === 'win32' ? 'app.ico' : 'app_dev.png';
      const iconPath = path.join(process.cwd(), 'resources', iconFile);
      if (fs.existsSync(iconPath)) {
        devIcon = nativeImage.createFromPath(iconPath);
        if (devIcon.isEmpty()) devIcon = undefined;
      }
    } catch {
      // Ignore icon loading errors in development
    }
  }

  // Create the browser window.
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    ...(windowX !== undefined && windowY !== undefined ? { x: windowX, y: windowY } : {}),
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: false, // Hide until CSS is loaded to prevent FOUC
    // The theme in effect (the system's appearance until one is chosen): no white flash in dark mode, on a reload too.
    backgroundColor: windowBackgroundColor(),
    autoHideMenuBar: true,
    // Set icon for Windows/Linux in development mode
    ...(devIcon && process.platform !== 'darwin' ? { icon: devIcon } : {}),
    // Custom titlebar configuration / 自定义标题栏配置
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hidden',
          // Align traffic-light vertical center with the titlebar button centers.
          // Titlebar is 45px; buttons are 36px flex-centered → button center y≈22.5.
          // Empirically y=13 places the traffic lights on the same horizontal line
          // as the sidebar / back / forward icons.
          // NOTE: requires a full app restart to take effect (BrowserWindow option).
          trafficLightPosition: { x: 10, y: 13 },
        }
      : { frame: false }),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      webviewTag: true, // 启用 webview 标签用于 HTML 预览 / Enable webview tag for HTML preview
    },
  });
  console.log(`[mu] Main window created (id=${mainWindow.id})`);

  // Show window after content is ready to prevent FOUC (Flash of Unstyled Content)
  // Use 'ready-to-show' which fires when renderer has painted first frame,
  // combined with 'did-finish-load' as belt-and-suspenders approach.
  if (showOnReady) {
    const showWindow = () => {
      if (!mainWindow.isDestroyed() && !mainWindow.isVisible()) {
        console.log('[mu] Showing main window');
        mainWindow.show();
        mainWindow.focus();
      }
    };
    mainWindow.once('ready-to-show', () => {
      console.log('[mu] Window ready-to-show');
      showWindow();
    });
    // Belt-and-suspenders: also show on did-finish-load in case ready-to-show already fired
    mainWindow.webContents.once('did-finish-load', () => {
      console.log('[mu] Renderer did-finish-load');
      showWindow();
      scheduleBackendMigrations();
    });
    // Fallback: show window after 5s even if events don't fire (e.g. loadURL failure)
    setTimeout(showWindow, 5000);
  } else if (process.platform === 'darwin' && app.dock) {
    void app.dock.hide();
  }

  initMainAdapterWithWindow(mainWindow);
  bindMainWindowReferences(mainWindow);

  setupApplicationMenu();

  setupZoomForWindow(mainWindow);
  registerWindowMaximizeListeners(mainWindow);
  attachWindowBoundsPersistence(mainWindow, (bounds) => ProcessConfig.set('window.bounds', bounds));

  // Load the renderer: dev server URL in development, built HTML file in production
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  const fallbackFile = path.join(__dirname, '../renderer/index.html');

  if (!app.isPackaged && rendererUrl) {
    console.log(`[mu] Loading renderer URL: ${rendererUrl}`);
    mainWindow.loadURL(rendererUrl).catch((error) => {
      console.error('[mu] loadURL failed, falling back to file:', error.message || error);
      mainWindow.loadFile(fallbackFile).catch((e2) => {
        console.error('[mu] loadFile fallback also failed:', e2.message || e2);
      });
    });
  } else {
    console.log(`[mu] Loading renderer file: ${fallbackFile}`);
    mainWindow.loadFile(fallbackFile).catch((error) => {
      console.error('[mu] loadFile failed:', error.message || error);
    });
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error('[mu] did-fail-load:', { errorCode, errorDescription, validatedURL, isMainFrame });
  });

  // Recovery policy for renderer crashes: reload with backoff for ordinary
  // crashes, escalate to a throttled app relaunch when the renderer cannot
  // launch at all (e.g. app files replaced by an update while running).
  // An unconditional immediate reload here caused a ~50/s crash storm on
  // `launch-failed`.
  const rendererRecovery = createRendererRecoveryPolicy();

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[mu] render-process-gone:', details);
    if (mainWindow.isDestroyed()) return;

    const action = rendererRecovery.onCrash(details.reason);

    if (action.kind === 'relaunch') {
      console.warn(`[mu] renderer cannot be recovered in-place (reason=${details.reason}); relaunching app`);
      app.relaunch();
      app.exit(0);
      return;
    }

    if (action.kind === 'give-up') {
      console.error(`[mu] renderer recovery exhausted (reason=${details.reason}); not retrying`);
      return;
    }

    // The isDestroyed() guard in adapter/main.ts prevents further sends
    // to the dead webContents while the reload is in progress.
    const reload = () => {
      if (mainWindow.isDestroyed()) return;
      console.log('[mu] Attempting to recover from renderer crash by reloading...');

      if (!app.isPackaged && rendererUrl) {
        mainWindow.loadURL(rendererUrl).catch((error) => {
          console.error('[mu] Recovery loadURL failed:', error.message || error);
        });
      } else {
        mainWindow.loadFile(fallbackFile).catch((error) => {
          console.error('[mu] Recovery loadFile failed:', error.message || error);
        });
      }
    };

    if (action.delayMs === 0) {
      reload();
    } else {
      setTimeout(reload, action.delayMs);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[mu] Renderer became unresponsive');
  });

  mainWindow.on('closed', () => {
    console.log('[mu] Main window closed');
  });

  // DevTools is no longer auto-opened at startup.
  // Use the DevTools toggle in Settings > System (dev mode only) to open it.

  // Listen to DevTools state changes and notify Renderer
  mainWindow.webContents.on('devtools-opened', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: true });
  });

  mainWindow.webContents.on('devtools-closed', () => {
    ipcBridge.application.devToolsStateChanged.emit({ isOpen: false });
  });

  // 关闭拦截：当启用"关闭到托盘"时，隐藏窗口而非关闭
  // Close interception: hide window instead of closing when "close to tray" is enabled
  mainWindow.on('close', (event) => {
    if (mainWindow.isDestroyed()) return;
    if (getCloseToTrayEnabled() && !getIsQuitting()) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
};

const handleAppReady = async (): Promise<void> => {
  const t0 = performance.now();
  const mark = (label: string) => console.log(`[mu:ready] ${label} +${Math.round(performance.now() - t0)}ms`);
  mark('start');

  // React DevTools comes from the Chrome Web Store (about 670 KB): only when asked for with MU_DEVTOOLS=1, since
  // nothing is downloaded without the person's consent.
  if (!app.isPackaged && process.env.MU_DEVTOOLS === '1') {
    try {
      const { default: installExtension, REACT_DEVELOPER_TOOLS } = await import('electron-devtools-installer');
      await installExtension(REACT_DEVELOPER_TOOLS);
      console.log('[DevTools] React Developer Tools installed');
    } catch (e) {
      console.warn('[DevTools] Failed to install React DevTools:', e);
    }
  }

  // CLI mode: print app version and exit immediately (used by CI smoke tests)
  if (isVersionMode) {
    console.log(app.getVersion());
    app.exit(0);
    return;
  }

  // Set dock icon in development mode on macOS
  // In production, the icon is set via forge.config.ts packagerConfig.icon
  if (process.platform === 'darwin' && !app.isPackaged && app.dock) {
    try {
      const iconPath = path.join(process.cwd(), 'resources', 'app_dev.png');
      if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath);
        if (!icon.isEmpty()) {
          app.dock.setIcon(icon);
        }
      }
    } catch {
      // Ignore dock icon errors in development
    }
  }

  // Allow the renderer's Local Font Access queries (window.queryLocalFonts),
  // used by the appearance font picker to enumerate installed fonts. Electron 37
  // surfaces the 'local-fonts' permission as 'unknown' and denies it when no
  // request handler is installed. Grant it here; other permissions are granted
  // too so installing this handler preserves Electron's default-grant behaviour
  // and regresses no capability the app already relies on. Runs once, before any
  // window is created.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });

  try {
    await initializeProcess();
    rendererInitialLanguage = ProcessConfig.getSync('language') ?? null;
    mark('initializeProcess');
  } catch (error) {
    console.error('Failed to initialize process:', error);
    app.exit(1);
    return;
  }

  /**
   * 启动单目标 CDP 通道，并把端口/口令写进自己的 env。
   *
   * ⚠️ 必须在 startBackendOrExit() 之前 —— 这是硬顺序，不是风格问题。
   *
   * 两个值靠进程继承链传给 Agent：aioncore 是本进程的子进程，内置浏览器 MCP 又是
   * aioncore 的子进程，所以不用落库、不用写配置。但继承是「spawn 那一刻的快照」：
   * backend-launcher 用 `{ ...process.env }` spawn aioncore，此后我们再改 process.env
   * 对已经起来的 aioncore 毫无影响。一旦这段挪到 backend 启动之后，aioncore 继承到的
   * 口令就是 undefined，浏览器 MCP 读不到凭证直接 exit(1)，「Agent 可控」这条链就断在
   * 最后一环 —— 而手动浏览、标签、前进后退全都正常，故障看起来跟浏览器无关，极难排查。
   *
   * 这里只起一个 node http/ws 服务，不碰 Electron 的 app.ready 相关能力，
   * 附加目标是后续渲染进程通过 IPC 报上来的，所以放在这个位置是安全的。
   *
   * Start the single-target CDP bridge and publish port/token into our own env.
   *
   * ⚠️ MUST run before startBackendOrExit(). This ordering is a hard requirement, not
   * style. Both values reach the agent by process inheritance (aioncore is our child; the
   * in-app browser MCP is aioncore's child), so neither is persisted. But inheritance is a
   * snapshot taken at spawn time: backend-launcher spawns aioncore with
   * `{ ...process.env }`, and any later mutation of our process.env is invisible to the
   * already-running aioncore. Move this block after backend startup and aioncore inherits
   * an undefined token, so the browser MCP exits(1) for want of credentials and agent
   * control silently breaks at the last hop — while manual browsing, tabs and history all
   * keep working, making the failure look unrelated to the browser and very hard to trace.
   *
   * Safe this early: it only starts a node http/ws server and touches no app.ready-gated
   * Electron API. The attach target arrives later over IPC from the renderer.
   */
  const { cdpStartupEnabled, setActiveCdpPort } = await import('./process/utils/configureChromium');
  if (cdpStartupEnabled) {
    try {
      const { startCdpBridge } = await import('./process/resources/builtinMcp/cdpBridge');
      const { setCdpBridgeHandle } = await import('./process/utils/cdpBridgeRegistry');
      const bridge = await startCdpBridge();
      setCdpBridgeHandle(bridge);
      /**
       * 回填真实端口，让设置页显示的是「连得上的地址」。
       * 以前这里显示的是 9230 段那个预留号，而通道走 listen(0) —— 用户照着复制的
       * MCP 配置根本连不上。
       *
       * Backfill the real port so the settings page shows a reachable address. It used to
       * display the reserved 9230-range number while the bridge listened on listen(0), so
       * any MCP config the user copied from there could never connect.
       */
      setActiveCdpPort(bridge.port);
      process.env.MU_CDP_ACTIVE_PORT = String(bridge.port);
      process.env.MU_CDP_BRIDGE_TOKEN = bridge.token;
      console.log(`[CDP] Single-target bridge listening on 127.0.0.1:${bridge.port} (token required)`);
      app.once('will-quit', () => {
        void bridge.close();
        setCdpBridgeHandle(null);
        setActiveCdpPort(null);
      });
      mark('cdpBridge');
    } catch (error) {
      /**
       * 通道起不来就不设 env。MCP 读不到端口/口令会自行退出（见 browserServer.ts），
       * 绝不会退回去自己开一个独立 Chrome —— 那正是我们要消灭的行为。
       *
       * If the bridge fails to start we leave the env unset. The MCP exits when it cannot
       * read port/token (see browserServer.ts) and never falls back to spawning its own
       * separate Chrome — the exact behaviour we are eliminating.
       */
      console.error('[CDP] Failed to start single-target bridge; agent browser control stays off.', error);
    }
  }

  const debugBackendStartupFailure = resolveDebugBackendStartupFailure();
  if (debugBackendStartupFailure) {
    applyDebugBackendStartupFailure(debugBackendStartupFailure);
    mark(`debugBackendStartupFailure:${debugBackendStartupFailure.reason}`);
  } else {
    // Nothing is downloaded without the person's consent: an unpackaged build asks before its backend fetches the
    // Node.js runtime (a packaged one ships it). "Later", or a question that could not be asked, keeps every start
    // of this session, crash restarts included, from downloading it.
    try {
      const { getDataPath } = await import('./process/utils/utils');
      const nodeRuntimePlan = await planStartupNodeRuntime({
        dataDir: getDataPath(),
        isPackaged: app.isPackaged,
        systemLocale: app.getLocale(),
      });
      if (nodeRuntimePlan === 'later') nodeRuntimeDeferred = true;
      mark(`nodeRuntime:${nodeRuntimePlan}`);
    } catch (error) {
      console.error('[mu] Could not ask about the Node.js runtime; starting without downloading it:', error);
      nodeRuntimeDeferred = true;
    }
    if (nodeRuntimeDeferred) backendManager.preferBundledManagedResources();

    // Start aioncore only after initializeProcess(). initStorage may open
    // the legacy Electron SQLite catalog for a one-shot v26 migration and must
    // close it before the backend touches the same file.
    const backendStartup = await startBackendOrExit({
      startBackend: async () => {
        assertStartupArchitectureCompatible({
          arch: process.arch,
          isPackaged: app.isPackaged,
          platform: process.platform,
        });
        const { getDataPath } = await import('./process/utils/utils');
        const { getSystemDir } = await import('./process/utils/initStorage');
        const sysDir = getSystemDir();
        return backendManager.start(
          getDataPath(),
          sysDir.logDir,
          {
            cacheDir: sysDir.cacheDir,
            workDir: sysDir.workDir,
            logDir: sysDir.logDir,
          },
          {
            allowPendingOnHealthTimeout: true,
            onHealthTimeout: (error) => {
              markBackendStartupFailed(error);
            },
            onPendingExit: (error) => {
              markBackendStartupFailed(error);
            },
            onReady: (backendPort) => {
              markBackendReady(backendPort, 'backendManager.lateReady');
            },
          }
        );
      },
      onStarted: (backendPort) => {
        exposeBackendPort(backendPort);
        if (backendManager.status === 'running') {
          markBackendReady(backendPort, 'backendManager.start');
          return;
        }
        mark(`backendManager.start pending health (port=${backendPort})`);
      },
      captureFailure: (error) => {
        markBackendStartupFailed(error);
      },
      exitApp: (code) => app.exit(code),
      exitOnFailure: false,
      logError: console.error,
    });
    void backendStartup;
  }

  // One-shot backend migrations are deferred until after the renderer finishes
  // loading. Some migration steps (ConfigStorage.get, ipcBridge.listProviders)
  // route through the renderer via BroadcastChannel; running them here would
  // deadlock because the renderer does not exist yet. See scheduleBackendMigrations().

  try {
    initializeZoomFactor(await ProcessConfig.get('ui.zoomFactor'));
    mark('initializeZoomFactor');
  } catch (error) {
    console.error('[mu] Failed to restore zoom factor:', error);
    initializeZoomFactor(undefined);
  }

  try {
    loadSavedWindowBounds(await ProcessConfig.get('window.bounds'));
    mark('restoreWindowBounds');
  } catch (error) {
    console.error('[mu] Failed to restore window bounds:', error);
    loadSavedWindowBounds(undefined);
  }

  try {
    initializeWindowAppearance(await ProcessConfig.get('window.appearance'));
  } catch (error) {
    console.error('[mu] Failed to restore the window appearance:', error);
    initializeWindowAppearance(undefined);
  }
  followSystemAppearance();

  {
    // 初始化关闭到托盘设置 / Initialize close-to-tray setting
    if (isE2ETestMode) {
      setCloseToTrayEnabled(false);
      destroyTray();
    } else {
      try {
        const savedCloseToTray = await readCloseToTraySetting();
        setCloseToTrayEnabled(savedCloseToTray);
        if (getCloseToTrayEnabled()) {
          createOrUpdateTray();
        }
      } catch {
        // Ignore storage read errors, default to false
      }
    }

    const showMainWindowOnReady = !(wasLaunchedAtLogin() && getCloseToTrayEnabled());

    // The menu's 新会话, 设置… and update check bring the window forward first (a new one after ⌘W on a Mac).
    setApplicationMenuWindow(() => showOrCreateMainWindow({ mainWindow, createWindow }));
    createWindow({ showOnReady: showMainWindowOnReady });
    appReadyDone = true;
    mark('createWindow');

    // mu updates itself from the releases of github.com/qybaihe/mu (process/services/update): a check a little after
    // the start and then every 6 hours, besides the one on 关于 (About). A build run from its sources and automated
    // runs (CI, E2E, MU_DISABLE_AUTO_UPDATE=1) check only when asked.
    const updates = getUpdateService();
    updates.setInstallHooks({
      beforeInstall: async () => {
        // The installer quits mu: its windows must close, not hide in the tray, and the backend must let go of the
        // files the installer replaces.
        setIsQuitting(true);
        await backendManager.stop();
      },
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
    });
    const isCiRuntime = process.env.CI === 'true' || process.env.CI === '1' || process.env.GITHUB_ACTIONS === 'true';
    if (app.isPackaged && !isE2ETestMode && !isCiRuntime && process.env.MU_DISABLE_AUTO_UPDATE !== '1') {
      updates.start();
    }

    // The application menu and the tray keep built text: rebuild both whenever the main process switches language
    // (at startup just below, and whenever the renderer changes the app language).
    onAppLanguageApplied((language) => {
      // A reloaded window's first paint uses this hint when the backend is not answering.
      rendererInitialLanguage = language;
      setupApplicationMenu();
      void refreshTrayMenu();
    });

    // Start in the saved app language (the renderer saves it in the backend), else the system language. Not awaited:
    // the rest of startup (deep links, WebUI restore) must not wait on the backend; the listener above rebuilds the
    // menus once it is done.
    void applyStartupAppLanguage(app.getLocale()).catch((error) =>
      console.error('[index] Failed to initialize i18n language:', error)
    );

    // Flush pending deep-link URL (received before window was ready)
    const pendingUrl = getPendingDeepLinkUrl();
    if (pendingUrl) {
      clearPendingDeepLinkUrl();
      mainWindow.webContents.once('did-finish-load', () => {
        handleDeepLinkUrl(pendingUrl);
      });
    }
  }
};

// ============ Protocol Registration ============
// Register mu:// as the default protocol client. An automated run (E2E) leaves the machine's mu:// links with the
// app the person uses: the registration is system-wide and outlives the run.
if (!isE2ETestMode) {
  if (process.defaultApp) {
    // Dev mode: need to pass execPath explicitly
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
  }
}

// macOS: handle mu:// URLs via the open-url event
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLinkUrl(url);
  if (!app.isReady()) {
    return;
  }
  // Focus existing window so user sees the result
  showOrCreateMainWindow({ mainWindow, createWindow });
});

// 监听 GPU 子进程崩溃，连续多次后下次启动自动关闭硬件加速（参见 ELECTRON-9A / ELECTRON-9D）。
installGpuCrashHandler();

// Register the backend startup flow only when this process owns the single
// instance lock. A lock-losing instance must NOT spawn a competing aioncore
// backend — doing so races the first instance's aioncore over the same data
// directory and produced the "local data repair failed" false alarm
// (Sentry 135525166). Gating here (rather than at the top-level second-instance
// block) keeps it after handleAppReady is declared.
if (shouldRegisterBackendStartup(gotTheLock)) {
  void app
    .whenReady()
    .then(handleAppReady)
    .catch((error) => {
      // App initialization failed
      console.error('[mu] App initialization failed:', error);
      app.quit();
    });
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  // 当关闭到托盘启用时，不退出应用 / Don't quit when close-to-tray is enabled
  if (getCloseToTrayEnabled()) {
    return;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  // Skip if handleAppReady hasn't finished — it will create the window itself.
  if (!appReadyDone) return;
  if (app.isReady()) {
    if (mainWindow && !mainWindow.isDestroyed()) {
      // 从托盘恢复隐藏的窗口 / Restore hidden window from tray
      showAndFocusMainWindow(mainWindow);
      if (process.platform === 'darwin' && app.dock) {
        void app.dock.show();
      }
    } else {
      createWindow();
    }
  }
});

installQuitCleanup({
  onBeforeQuit: (handler) => app.on('before-quit', (event) => handler(event)),
  quitApp: () => app.quit(),
  setIsQuitting,
  // The desktop shell has no server to keep alive past a quit.
  markExplicitQuit: () => {},
  destroyTray,
  disposeCronResumeListener: () => {
    disposeCronResumeListener?.();
    disposeCronResumeListener = null;
  },
  // Stop aioncore subprocess — backend shutdown kills all agent children
  // transitively (no separate frontend workerTaskManager remains).
  stopBackend: () => backendManager.stop(),
  logInfo: console.log,
  logWarn: console.warn,
  logError: console.error,
});

app.on('will-quit', () => {
  console.log('[mu] will-quit — all cleanup should be complete');
});

app.on('quit', (_event, exitCode) => {
  console.log(`[mu] quit (exitCode=${exitCode})`);
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
