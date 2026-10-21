export interface ElectronBridgeAPI {
  emit: (name: string, data: unknown) => Promise<unknown> | void;
  on: (callback: (event: { value: string }) => void) => void;
  // 获取拖拽文件/目录的绝对路径 / Get absolute path for dragged file/directory
  getPathForFile?: (file: File) => string;
  recoverCorruptedDatabase?: () => Promise<void>;
  /** Opens the folder the logs are written to, in the file manager. Needs no backend: it is what a failed start lacks. */
  openLogFolder?: () => Promise<void>;
}

export type BackendStartupFailureReason =
  | 'backend_incompatible_runtime'
  | 'backend_incomplete_installation'
  | 'backend_package_architecture_mismatch'
  | 'backend_data_migration_failed'
  // The local database was created by a newer version of the app (downgrade).
  // The data is intact; the fix is updating the app, not reinstalling or
  // inspecting migrations (Sentry ELECTRON-31Z).
  | 'backend_database_newer_than_app'
  | 'backend_local_data_repair_failed'
  | 'backend_recoverable_database_corruption'
  | 'backend_transient_concurrent_startup'
  | 'backend_startup_directory_unavailable'
  // Backend process spawned and was observed listening but /health did not pass
  // within the timeout, while the process stayed alive (kept pending). Recoverable
  // "slow startup" — must NOT be surfaced as an "incomplete installation".
  | 'backend_startup_pending_slow'
  // Backend process spawned and was observed listening but then exited before
  // becoming ready (either within the health window or after the pending timeout).
  // Honest startup failure — surfaced without reinstall/antivirus guidance.
  | 'backend_startup_exited'
  // Backend process spawned but never reported its listening port within the
  // port-report window (stage `listen_timeout`). The process has been killed,
  // so this is a fatal-but-honest "startup timed out" — never an "incomplete
  // installation" (Sentry 136646113).
  | 'backend_startup_port_report_timeout'
  | 'backend_startup_failed';

export type BackendIncompleteInstallationKind = 'missing_backend_binary' | 'missing_directory_resources';
export type BackendLocalDataIssueKind = 'agent_metadata_invalid_utf8' | 'assistant_storage_bootstrap_failed';
export type BackendStartupDirectoryIssueKind = 'missing_or_unavailable_directory' | 'permission_denied';

export interface BackendStartupFailureInfo {
  incompleteInstallationKind?: BackendIncompleteInstallationKind;
  localDataIssueKind?: BackendLocalDataIssueKind;
  startupDirectoryIssueKind?: BackendStartupDirectoryIssueKind;
  missingBackendBinary?: boolean;
  missingBundledBackendDir?: boolean;
  missingHubDir?: boolean;
  missingPwaDir?: boolean;
  reason: BackendStartupFailureReason;
  backendBoundaryCode?: string;
  backendBoundaryStage?: string;
  runtime?: 'glibc';
  requiredVersions?: string[];
  missingResources?: string[];
  missingRuntimeDir?: boolean;
  packageArch?: string;
  deviceArch?: string;
  expectedDownloadArch?: string;
  isRosettaTranslated?: boolean;
  /** Currently installed app version, stamped by the main process when a
   * startup failure is recorded. Lets dialogs reference the user's version
   * (e.g. the downgrade dialog: "data needs something newer than vX.Y.Z"). */
  appVersion?: string;
}

declare global {
  interface Window {
    electronAPI?: ElectronBridgeAPI;
    __initialLanguage?: string | null;
    __muE2ETest?: boolean;
    __backendStartupFailed?: boolean;
    __backendStartupFailure?: BackendStartupFailureInfo | null;
    /** The person put the Node.js runtime download off at this start: see common/adapter/nodeRuntimeDeferral.ts. */
    __nodeRuntimeDeferred?: boolean;
    __backendStartupBridge?: {
      getState: () => BackendStartupFailureInfo | null;
      subscribe: (callback: (state: BackendStartupFailureInfo | null) => void) => () => void;
    };
  }
}
