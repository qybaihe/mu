/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The wizard's AI deep analysis: one mu run in the picked directory, print
 * mode (`-p`), answering the analysis prompt as one JSON object — started
 * through the harness launcher the same way a session or a sign-in is
 * (harness.ts, launcherOf, launchCommand), so a checkout, the npm package
 * and the packaged app's own copy all work. The prompt and the reply's
 * parsing are pure (positionProjectProfile.ts); this module only resolves
 * the harness, runs the child and maps its outcome. The wizard marks the
 * result as AI-derived and never silently falls back to it.
 */
import { spawn } from 'node:child_process';
import { getPlatformServices } from '@/common/platform';
import { findHarness, expectedHarness, launcherOf } from '../../../agent/kyrn/harness.ts';
import { launchCommand, endTree } from '../../../agent/kyrn/piRpc.ts';
import { systemProxyEnv } from '../../../agent/kyrn/config/systemProxy.ts';
import { muAgentDir } from '../../../agent/kyrn/naming.ts';
import {
  buildDeepAnalysisPrompt,
  deepAnalysisAsDraft,
  parseDeepAnalysisReply,
  type DeepAnalysis,
  type PositionDraft,
} from '@/common/chat/team/positions/positionProjectProfile';

/** How long the one-shot analysis may run: a cold harness start plus a model answer. */
export const DEEP_ANALYSIS_TIMEOUT_MS = 180_000;

/** How much of the child's output is kept — an answer is small, a runaway is not. */
const OUTPUT_CAP = 256 * 1024;

/** Everything the runner needs injected for tests; the defaults read this process. */
export type DeepAnalysisDeps = {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd: string;
  resourcesPath: string | undefined;
  isPackaged: boolean;
  muAgentDir: string;
};

/** The run's outcome: the draft the AI proposed, or why there is none. */
export type DeepAnalysisResult =
  | { ok: true; draft: PositionDraft; analysis: DeepAnalysis }
  | { ok: false; reason: 'spawn' | 'timeout' | 'exit' | 'unparseable'; detail: string };

const defaultDeps = (): DeepAnalysisDeps => ({
  platform: process.platform,
  env: process.env,
  cwd: process.cwd(),
  resourcesPath: (process as { resourcesPath?: string }).resourcesPath,
  isPackaged: getPlatformServices().paths.isPackaged(),
  muAgentDir: muAgentDir(),
});

/** The harness the deep analysis runs, resolved the way the app's kyrn bridge does. */
export function deepAnalysisLauncher(deps: DeepAnalysisDeps): string {
  const desktopRoot = deps.env.KYRN_DESKTOP_ROOT || deps.cwd;
  const checkout = deps.isPackaged && !deps.env.KYRN_DESKTOP_ROOT ? undefined : desktopRoot;
  const harness = findHarness(checkout) ?? expectedHarness(checkout, deps.resourcesPath);
  return launcherOf(harness, deps.platform);
}

/**
 * Runs the one-shot analysis in `directory` and parses the reply. Failures
 * are answers, not throws — the wizard shows them, and the heuristic result
 * stays what it was.
 */
export function runDeepAnalysis(
  directory: string,
  options: { deps?: Partial<DeepAnalysisDeps>; timeoutMs?: number } = {}
): Promise<DeepAnalysisResult> {
  const deps = { ...defaultDeps(), ...options.deps };
  const timeoutMs = options.timeoutMs ?? DEEP_ANALYSIS_TIMEOUT_MS;
  const start = launchCommand(deepAnalysisLauncher(deps), ['-p', buildDeepAnalysisPrompt()]);
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(start.command, start.args, {
        cwd: directory,
        env: { ...deps.env, ...systemProxyEnv(), ...start.env, MU_AGENT_DIR: deps.muAgentDir },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: deps.platform !== 'win32',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn', detail: error instanceof Error ? error.message : String(error) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const answer = (result: DeepAnalysisResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        endTree(child.pid, 'SIGTERM', deps.platform, {
          group: (leader, signal) => process.kill(-leader, signal),
          taskkill: (taskArgs) => {
            spawn('taskkill', taskArgs, { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
          },
          own: (signal) => child.kill(signal),
        });
      } catch {
        // Gone already; the close event settles it.
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      answer({ ok: false, reason: 'spawn', detail: error.message });
    });
    child.on('close', (code) => {
      if (timedOut) {
        answer({ ok: false, reason: 'timeout', detail: `no answer within ${Math.round(timeoutMs / 1000)}s` });
        return;
      }
      if (code !== 0) {
        answer({ ok: false, reason: 'exit', detail: stderr.slice(-512).trim() || `exit ${code}` });
        return;
      }
      const analysis = parseDeepAnalysisReply(stdout);
      if (!analysis) {
        answer({ ok: false, reason: 'unparseable', detail: stdout.slice(-512).trim() });
        return;
      }
      answer({ ok: true, draft: deepAnalysisAsDraft(analysis, directory), analysis });
    });
  });
}
