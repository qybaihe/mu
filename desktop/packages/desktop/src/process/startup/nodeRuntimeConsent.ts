import fs from 'node:fs';
import path from 'node:path';

/**
 * The Node.js runtime that the bundled backend keeps for the agents and tools that run on Node (npx
 * agents, MCP servers). Nothing is downloaded without the person's consent, and this is the large first-start
 * download:
 *
 * - A packaged app ships the runtime in `resources/bundled-backend/<platform>-<arch>/managed-resources/` (prepared
 *   when the app is built) and starts the backend with `--managed-resources-mode bundled`, which copies it from there
 *   and never downloads. Nothing to ask.
 * - An unpackaged build starts the backend in its default download mode, which fetches the archive from nodejs.org
 *   as soon as it starts on a data folder without `runtime/node/node-v<version>-<platform>`. The person is asked
 *   first. "Later" starts the backend in bundled mode instead, where the missing runtime is reported and nothing is
 *   fetched.
 */

/** The runtime the backend (v0.2.2) installs: `MANAGED_NODE_VERSION` in the backend's runtime crate (`node_runtime/managed.rs`). */
export const MANAGED_NODE_VERSION = '24.11.0';

/** The archive the backend fetches on each platform, with its size on nodejs.org in bytes (checked 2026-09-23). */
const ARCHIVES: Readonly<Record<string, { folder: string; bytes: number }>> = {
  'darwin-arm64': { folder: 'darwin-arm64', bytes: 51_168_984 },
  'darwin-x64': { folder: 'darwin-x64', bytes: 52_344_343 },
  'linux-arm64': { folder: 'linux-arm64', bytes: 58_578_283 },
  'linux-x64': { folder: 'linux-x64', bytes: 58_899_117 },
  'win32-arm64': { folder: 'win-arm64', bytes: 32_760_976 },
  'win32-x64': { folder: 'win-x64', bytes: 36_356_854 },
};

export type ManagedNodeRuntime = {
  version: string;
  /** Where the backend keeps it: `<data>/runtime/node/node-v<version>-<platform>`. */
  dir: string;
  /** The archive's size in bytes. */
  bytes: number;
  url: string;
};

/** The runtime the backend installs on this platform, or undefined on a platform it does not manage. */
export function managedNodeRuntime(
  dataDir: string,
  platform: NodeJS.Platform,
  arch: string
): ManagedNodeRuntime | undefined {
  const archive = ARCHIVES[`${platform}-${arch}`];
  if (!archive) return undefined;
  const name = `node-v${MANAGED_NODE_VERSION}-${archive.folder}`;
  return {
    version: MANAGED_NODE_VERSION,
    dir: path.join(dataDir, 'runtime', 'node', name),
    bytes: archive.bytes,
    url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${name}.${platform === 'win32' ? 'zip' : 'tar.gz'}`,
  };
}

/** Whether the runtime's `node` is in place. The backend checks the rest when it starts. */
export function hasManagedNodeRuntime(
  runtime: ManagedNodeRuntime,
  platform: NodeJS.Platform,
  exists: (file: string) => boolean = fs.existsSync
): boolean {
  return exists(path.join(runtime.dir, platform === 'win32' ? 'node.exe' : path.join('bin', 'node')));
}

/** The person's answer: let the backend fetch the runtime now, or start without it. */
export type NodeRuntimeChoice = 'download' | 'later';

/**
 * How the backend starts: `ready` when there is nothing to fetch or ask about, `download` as it always did (it fetches
 * the runtime), `later` in bundled mode (it fetches nothing).
 */
export type NodeRuntimePlan = 'ready' | NodeRuntimeChoice;

export async function planNodeRuntime(options: {
  isPackaged: boolean;
  isE2E: boolean;
  /** `MU_NODE_RUNTIME`: `download` or `later` answers without a dialog (scripts and tests); `ask` asks even there. */
  preset: string | undefined;
  /** Undefined on a platform the backend does not manage: it fails there without downloading. */
  runtime: ManagedNodeRuntime | undefined;
  installed: boolean;
  ask: (runtime: ManagedNodeRuntime) => Promise<NodeRuntimeChoice>;
}): Promise<NodeRuntimePlan> {
  if (options.isPackaged || !options.runtime || options.installed) return 'ready';
  if (options.preset === 'download' || options.preset === 'later') return options.preset;
  // An automated run cannot answer a dialog, and must not download unasked either.
  if (options.isE2E && options.preset !== 'ask') return 'later';
  return options.ask(options.runtime);
}

/** A size in whole megabytes (10^6 bytes), at least 1. */
export function megabytes(bytes: number): number {
  return Math.max(1, Math.round(bytes / 1_000_000));
}
