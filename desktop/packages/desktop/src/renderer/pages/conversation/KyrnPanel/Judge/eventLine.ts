import type { TFunction } from 'i18next';
import { runEnding, type BrowserRunState, type BrowserRunStatus } from '@/common/kyrn/browserRun';
import { parseCoded, parseParams, type CodeParams, type Coded } from '@/common/kyrn/hive';
import { formatDuration, formatNumber } from '@/renderer/services/i18n/format';
import { checkpointOffWords, readCheckpointParams } from '@/renderer/pages/conversation/Messages/acp/muNotice';
import { reasonLine, reasonText, statusKey } from '@/renderer/pages/conversation/Preview/browser/muBrowser/format';
import { record, str } from '../activity';

/**
 * What a runtime event says, in a line or a few, in the app language: the summary above its raw payload in the list
 * under the judge's cards. The harness writes each sentence in English with a stable code and params beside it; these
 * say the same by code, at render time, so stored events follow a later language switch. A code that is missing
 * (older sessions), unknown, or whose params do not fit falls back to the English as written. Commands, paths, URLs,
 * messages, server names, search sources and model text are data and are passed through as they are.
 */

const KEY = 'common.kyrn.eventLine';

const whole = (params: CodeParams, name: string): number | undefined => {
  const value = params[name];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
};
const data = (params: CodeParams, name: string): string | undefined => {
  const value = params[name];
  return typeof value === 'string' && value ? value : undefined;
};
const lines = (...values: Array<string | undefined>): string[] => values.filter((value): value is string => !!value);

// ── progress ────────────────────────────────────────────────────────────────

const PROGRESS_STEPS = new Set(['frame', 'lessons', 'skills', 'capabilities', 'goal_check']);

/** The step being worked out before a turn ("choosing skills"); a permission review names what Jev looks at. */
function progressStep(t: TFunction, coded: Coded | undefined): string | undefined {
  if (!coded) return undefined;
  if (PROGRESS_STEPS.has(coded.code)) return t(`${KEY}.progress.${coded.code}`);
  if (coded.code !== 'permission_review') return undefined;
  const summary = data(coded.params, 'summary');
  return summary ? t(`${KEY}.progress.permissionReview`, { summary }) : undefined;
}

// ── goal.state ──────────────────────────────────────────────────────────────

/** The longest time allowance said as a duration: its seconds stay a safe integer. */
const MAX_MINUTES = Math.floor(Number.MAX_SAFE_INTEGER / 60);

/** Why a goal paused, by its `reasonCode`. */
function goalReason(
  t: TFunction,
  code: string,
  params: CodeParams,
  language: string | null | undefined
): string | undefined {
  const reason = `${KEY}.goal.reason`;
  switch (code) {
    case 'interrupted':
      return t(`${reason}.interrupted`);
    case 'model_call_failed':
      return t(`${reason}.modelCallFailed`);
    case 'needs_user': {
      // The checking model's own words, when it gave some.
      const detail = data(params, 'detail');
      return detail ? t(`${reason}.needsUserDetail`, { detail }) : t(`${reason}.needsUser`);
    }
    case 'unjudged':
      return t(`${reason}.unjudged`);
    case 'idle': {
      const count = whole(params, 'runs');
      return count === undefined ? undefined : t(`${reason}.idle`, { count });
    }
    case 'no_progress': {
      const count = whole(params, 'runs');
      if (count === undefined) return undefined;
      const detail = data(params, 'detail');
      return detail ? t(`${reason}.noProgressDetail`, { count, detail }) : t(`${reason}.noProgress`, { count });
    }
    case 'continuations_used_up': {
      const count = whole(params, 'max');
      return count === undefined ? undefined : t(`${reason}.continuationsUsedUp`, { count });
    }
    case 'minutes_used_up': {
      const minutes = params.minutes;
      // Past about 10^14 minutes Intl.DurationFormat throws, which would take the whole panel down.
      if (typeof minutes !== 'number' || !(minutes > 0 && minutes <= MAX_MINUTES)) return undefined;
      return t(`${reason}.minutesUsedUp`, { duration: formatDuration(minutes * 60_000, language, 'long') });
    }
    case 'session_reopened':
      return t(`${reason}.sessionReopened`);
    default:
      return undefined;
  }
}

/** The goal as it was set (data), then why it paused; `reason` is already Chinese or English when there is no code. */
function goalLines(t: TFunction, payload: Record<string, unknown>, language: string | null | undefined): string[] {
  const code = str(payload.reasonCode);
  const said = code ? goalReason(t, code, parseParams(payload.reasonParams), language) : undefined;
  const reason = said ?? str(payload.reason);
  // A coded reason is only ever set while the goal is paused.
  const paused = said !== undefined || payload.status === 'paused';
  return lines(str(payload.text), reason && paused ? t(`${KEY}.goal.paused`, { reason }) : reason);
}

// ── frame.updated ───────────────────────────────────────────────────────────

/** The frame's open questions: the rules' own by code, the writer model's as it wrote them. */
function frameLines(t: TFunction, payload: Record<string, unknown>): string[] {
  const questions = record(payload.frame).openQuestions;
  const written = Array.isArray(questions) ? questions : [];
  const codes = Array.isArray(payload.openQuestionCodes) ? payload.openQuestionCodes : [];
  return lines(
    ...Array.from({ length: Math.max(written.length, codes.length) }, (_, index) => {
      const coded = parseCoded(codes[index]);
      const message = coded?.code === 'unclear_change' ? data(coded.params, 'message') : undefined;
      return message ? t(`${KEY}.frame.unclearChange`, { message }) : str(written[index]);
    })
  );
}

// ── web.search ──────────────────────────────────────────────────────────────

const SEARCH_PROBLEMS: ReadonlyMap<string, string> = new Map([
  ['source_not_configured', 'notConfigured'],
  ['source_robot_page', 'robotPage'],
  ['source_no_results', 'noResults'],
  ['source_unrelated', 'unrelated'],
]);

/** Why one search source gave nothing, by its code. */
function searchProblem(t: TFunction, coded: Coded | undefined): string | undefined {
  const source = coded ? data(coded.params, 'source') : undefined;
  if (!coded || !source) return undefined;
  if (coded.code === 'source_failed') {
    const message = data(coded.params, 'message');
    return message ? t(`${KEY}.search.failed`, { source, message }) : undefined;
  }
  if (coded.code === 'source_http_error') {
    // A status code is a name, not an amount: it is never written in another script or grouped.
    const status = whole(coded.params, 'status');
    return status === undefined ? undefined : t(`${KEY}.search.httpError`, { source, status: String(status) });
  }
  const key = SEARCH_PROBLEMS.get(coded.code);
  return key ? t(`${KEY}.search.${key}`, { source }) : undefined;
}

function searchLines(t: TFunction, payload: Record<string, unknown>): string[] {
  const problems = Array.isArray(payload.problems) ? payload.problems : [];
  const codes = Array.isArray(payload.problemCodes) ? payload.problemCodes : [];
  return lines(
    ...Array.from(
      { length: Math.max(problems.length, codes.length) },
      (_, index) => searchProblem(t, parseCoded(codes[index])) ?? str(problems[index])
    )
  );
}

// ── mcp.failed ──────────────────────────────────────────────────────────────

/** Reasons said without params: why a start was refused or failed (the MCP client's own kinds among them). */
const MCP_REASONS: ReadonlyMap<string, string> = new Map([
  ['project_untrusted', 'projectUntrusted'],
  ['denied', 'denied'],
  ['unreachable', 'unreachable'],
  ['closed', 'closed'],
  ['timeout', 'timeout'],
  ['aborted', 'aborted'],
  ['rpc', 'rpc'],
  ['protocol', 'protocol'],
  ['start_failed', 'startFailed'],
  ['disconnected', 'disconnected'],
]);
/** Codes whose `reason` is the server's or the transport's own words, not the English of the code: kept as a detail. */
const MCP_WORDS = new Set([
  'unreachable',
  'closed',
  'timeout',
  'aborted',
  'rpc',
  'protocol',
  'start_failed',
  'disconnected',
  'crashed',
  'restart_failed',
]);

function mcpReason(
  t: TFunction,
  code: string,
  params: CodeParams,
  payload: Record<string, unknown>
): string | undefined {
  const simple = MCP_REASONS.get(code);
  if (simple) return t(`${KEY}.mcp.${simple}`);
  switch (code) {
    case 'needs_approval': {
      const source = data(params, 'source');
      return source ? t(`${KEY}.mcp.needsApproval`, { source }) : undefined;
    }
    case 'needs_sign_in': {
      const server = data(params, 'server');
      return server ? t(`${KEY}.mcp.needsSignIn`, { server }) : undefined;
    }
    case 'crashed': {
      // The param is 0/1; the event's own `willRestart` says the same.
      const again =
        params.willRestart === 1 || params.willRestart === 0
          ? params.willRestart === 1
          : typeof payload.willRestart === 'boolean'
            ? payload.willRestart
            : undefined;
      if (again === undefined) return undefined;
      return t(again ? `${KEY}.mcp.crashedRestarting` : `${KEY}.mcp.crashedAgain`);
    }
    case 'restart_failed': {
      const cause = MCP_REASONS.get(data(params, 'cause') ?? '');
      return cause
        ? t(`${KEY}.mcp.restartFailedCause`, { cause: t(`${KEY}.mcp.${cause}`) })
        : t(`${KEY}.mcp.restartFailed`);
    }
    default:
      return undefined;
  }
}

/** The server (data) and why it failed, then the server's own last words when they are more than the code says. */
function mcpLines(t: TFunction, payload: Record<string, unknown>): string[] {
  const name = str(payload.name);
  const english = str(payload.reason);
  const code = str(payload.code);
  const said = code ? mcpReason(t, code, parseParams(payload.params), payload) : undefined;
  const reason = said ?? english;
  return lines(
    reason && name ? t(`${KEY}.mcp.line`, { name, reason }) : reason || name,
    said && english && MCP_WORDS.has(code) ? t(`${KEY}.detail`, { detail: english }) : undefined
  );
}

// ── rewind.proposed ─────────────────────────────────────────────────────────

const TROUBLE_KINDS = new Set(['loop', 'drift']);

/** What made the harness propose going back: the same command failing again and again, or the monitor's warnings. */
function rewindTrigger(t: TFunction, payload: Record<string, unknown>): string | undefined {
  const code = str(payload.triggerCode);
  const params = parseParams(payload.triggerParams);
  const count = whole(params, 'times');
  if (count === undefined) return undefined;
  if (code === 'same_command_failed') {
    const command = data(params, 'command');
    return command ? t(`${KEY}.rewind.sameCommandFailed`, { count, command }) : undefined;
  }
  if (code === 'monitor_trouble') {
    const kind = data(params, 'kind');
    const detail = data(params, 'detail');
    if (!kind || !TROUBLE_KINDS.has(kind) || !detail) return undefined;
    return t(`${KEY}.rewind.monitorTrouble`, { count, kind: t(`${KEY}.rewind.trouble.${kind}`), detail });
  }
  return undefined;
}

// ── browser.run ─────────────────────────────────────────────────────────────

/** The harness's run results as the step bar names them (`aborted` is shown as stopped). */
const RUN_STATUS: ReadonlyMap<string, BrowserRunStatus> = new Map<string, BrowserRunStatus>([
  ['done', 'done'],
  ['blocked', 'blocked'],
  ['budget', 'budget'],
  ['needs_confirmation', 'needs_confirmation'],
  ['aborted', 'stopped'],
  ['read', 'read'],
  ['failed', 'failed'],
]);

const LAUNCH_SIMPLE: ReadonlyMap<string, string> = new Map([
  ['devtools_port_timeout', 'devtoolsPortTimeout'],
  ['cdp_connect_timeout', 'cdpConnectTimeout'],
  ['cdp_connect_failed', 'cdpConnectFailed'],
]);

/** Why the browser could not be started or reached, by its `launchCode`. */
function launchSentence(t: TFunction, code: string, params: CodeParams): string | undefined {
  const launch = `${KEY}.browser.launch`;
  switch (code) {
    case 'no_browser': {
      const platform = data(params, 'platform');
      const wsl = params.wsl;
      if (!platform || (wsl !== 0 && wsl !== 1)) return undefined;
      const where = wsl === 1 ? 'wsl' : platform === 'darwin' ? 'mac' : platform === 'win32' ? 'windows' : 'other';
      return t(`${launch}.noBrowser.${where}`);
    }
    case 'windows_browser_unusable': {
      const executable = data(params, 'executable');
      return executable ? t(`${launch}.windowsBrowserUnusable`, { executable }) : undefined;
    }
    case 'profile_no_windows_path': {
      const profileDir = data(params, 'profileDir');
      return profileDir ? t(`${launch}.profileNoWindowsPath`, { profileDir }) : undefined;
    }
    case 'browser_spawn_failed': {
      const command = data(params, 'command');
      return command ? t(`${launch}.browserSpawnFailed`, { command }) : undefined;
    }
    case 'browser_exited_on_start': {
      const exitCode = params.exitCode;
      return typeof exitCode === 'number' && Number.isInteger(exitCode)
        ? t(`${launch}.browserExitedOnStart`, { exitCode: String(exitCode) })
        : undefined;
    }
    default: {
      const key = LAUNCH_SIMPLE.get(code);
      return key ? t(`${launch}.${key}`) : undefined;
    }
  }
}

/**
 * A run that never started (`failed`), or how one ended (`finished`), the latter in the step bar's own words. Other
 * states say nothing here.
 */
function browserLines(t: TFunction, payload: Record<string, unknown>): string[] | undefined {
  const english = str(payload.reason);
  if (payload.state === 'failed') {
    if (payload.code === 'open_failed') {
      const where = payload.embedded === true ? 'openFailedPanel' : 'openFailed';
      // The error behind it is the browser's own message.
      return lines(t(`${KEY}.browser.${where}`), english ? t(`${KEY}.detail`, { detail: english }) : undefined);
    }
    const launchCode = payload.code === 'launch_failed' ? str(payload.launchCode) : '';
    return lines((launchCode ? launchSentence(t, launchCode, parseParams(payload.params)) : undefined) ?? english);
  }
  if (payload.state !== 'finished') return undefined;
  const status = RUN_STATUS.get(str(payload.status));
  const run: BrowserRunState = {
    tabId: '',
    conversationId: '',
    phase: 'finished',
    goal: '',
    startUrl: '',
    startedAt: 0,
    paused: false,
    stopRequested: false,
    steps: [],
    notices: [],
    ...(status ? { status } : {}),
    ...(english ? { reason: english } : {}),
    ...runEnding(payload),
  };
  const line = reasonLine(run);
  const reason = line ? reasonText(line, t) : '';
  const label = status ? t(statusKey(status)) : '';
  return lines(label && reason ? t(`${KEY}.browser.finished`, { status: label, reason }) : label || reason);
}

// ── permissions.mode ────────────────────────────────────────────────────────

/** The harness's permission modes, named as the send box's permission menu names them. */
const PERMISSION_MODES: ReadonlySet<string> = new Set(['full', 'jev', 'ask']);

/** The mode the conversation runs in; a mode this build does not know goes by the harness's own label for it. */
function permissionsLine(t: TFunction, payload: Record<string, unknown>): string[] {
  const mode = str(payload.mode);
  const name = PERMISSION_MODES.has(mode) ? t(`mu.permissions.modes.${mode}.title`) : str(payload.label);
  return lines(name ? t(`${KEY}.permissions.mode`, { mode: name }) : undefined);
}

// ── permissions.request / resolved / approved ───────────────────────────────

/** mu's answers by id, as `permissions.resolved` reports them. */
const PERMISSION_ANSWERS: ReadonlySet<string> = new Set(['once', 'session', 'deny']);

/** mu waits for the person's permission; the call it names is data, shown as it is. */
function permissionRequestLine(t: TFunction, payload: Record<string, unknown>): string[] {
  const summary = str(payload.summary);
  return lines(summary ? t(`${KEY}.permissions.request`, { summary }) : t(`${KEY}.permissions.waiting`));
}

/** How the person answered, with the call when the question named one (`summary`, found by the log). */
function permissionAnswerLine(t: TFunction, payload: Record<string, unknown>): string[] | undefined {
  const answer = str(payload.answer);
  if (!PERMISSION_ANSWERS.has(answer)) return undefined;
  const said = t(`${KEY}.permissions.answers.${answer}`);
  const summary = str(payload.summary);
  return lines(summary ? t(`${KEY}.permissions.about`, { answer: said, summary }) : said);
}

/** A call that ran without asking: the judge let it through, or the person had allowed it for this conversation. */
function permissionApprovedLine(t: TFunction, payload: Record<string, unknown>): string[] | undefined {
  const summary = str(payload.summary);
  const by = str(payload.by);
  if (!summary || (by !== 'jev' && by !== 'grant')) return undefined;
  return lines(t(`${KEY}.permissions.approved.${by === 'jev' ? 'judge' : 'grant'}`, { summary }));
}

// ── checkpoint.off ──────────────────────────────────────────────────────────

/** Why the session goes without checkpoints, in the words the conversation's notice uses; mu's own line otherwise. */
function checkpointLine(t: TFunction, payload: Record<string, unknown>, language: string | null | undefined): string[] {
  const words = checkpointOffWords({
    title: '',
    reason: str(payload.code),
    params: readCheckpointParams(payload.params),
  });
  const values = words
    ? Object.fromEntries(Object.entries(words.values).map(([name, value]) => [name, formatNumber(value, language)]))
    : {};
  return lines(words ? t(words.key, values) : str(payload.message));
}

// ── board.switched ──────────────────────────────────────────────────────────

/** Whether the board is on: the harness says so whenever it starts and after each switch, so this is a state. */
const boardLine = (t: TFunction, payload: Record<string, unknown>): string[] | undefined =>
  typeof payload.on === 'boolean' ? [t(`${KEY}.board.${payload.on ? 'on' : 'off'}`)] : undefined;

// ── entry ───────────────────────────────────────────────────────────────────

/**
 * The summary lines of one runtime event in the app language, or undefined for a kind this module does not word (the
 * panel keeps its generic summary for those). An empty list means the event gave nothing to say.
 */
export function eventLines(
  t: TFunction,
  kind: string,
  payload: Record<string, unknown>,
  language?: string | null
): string[] | undefined {
  switch (kind) {
    case 'progress':
      return lines(progressStep(t, parseCoded(payload)) ?? str(payload.step));
    case 'goal.state':
      return goalLines(t, payload, language);
    case 'frame.updated':
      return frameLines(t, payload);
    case 'web.search':
      return searchLines(t, payload);
    case 'mcp.failed':
      return mcpLines(t, payload);
    case 'rewind.proposed':
      return lines(rewindTrigger(t, payload) ?? str(payload.trigger));
    case 'browser.run':
      return browserLines(t, payload);
    case 'permissions.mode':
      return permissionsLine(t, payload);
    case 'permissions.request':
      return permissionRequestLine(t, payload);
    case 'permissions.resolved':
      return permissionAnswerLine(t, payload);
    case 'permissions.approved':
      return permissionApprovedLine(t, payload);
    case 'checkpoint.off':
      return checkpointLine(t, payload, language);
    case 'board.switched':
      return boardLine(t, payload);
    default:
      return undefined;
  }
}
