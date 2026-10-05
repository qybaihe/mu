import {
  PROTOCOL_VERSION,
  type Agent,
  type AgentSideConnection,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SessionConfigOption,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PiRpc, array, asRecord, text, type JsonRecord, type RpcPort } from './piRpc.ts';
import { mapEvent, messageText, messageThinking } from './events.ts';
import { isConversationId, readImportRecord, writeImportRecord, type ImportRecord } from './importChats.ts';
import { muEnv, muHome } from './naming.ts';
import { Telemetry } from './telemetry.ts';
import { slashCommands } from './commands.ts';
import { supportedThinkingLevels, UNOFFERED_PROVIDER_IDS } from '../../../common/kyrn/models.ts';
import {
  answerIndex,
  answerKind,
  answerOptionId,
  asks,
  isModeId,
  modeOption,
  permissionCall,
  presentation,
  readModes,
  readRequest,
  readResolved,
  type PermissionModes,
  type PermissionRequest,
} from './permissions.ts';

type Connection = Pick<AgentSideConnection, 'sessionUpdate' | 'requestPermission'>;
type Session = {
  rpc: RpcPort;
  telemetry: Telemetry;
  refreshing?: Promise<void>;
  dirty?: boolean;
  queue: Promise<void>;
  busy: boolean;
  cancelled: boolean;
  cwd: string;
  streamed: string;
  thought: string;
  error?: Error;
  started?: boolean;
  settled?: () => void;
  /** Set once the session has answered its first state: later mode changes are announced to the app. */
  opened?: boolean;
  /** mu's session file, kept with the conversation's mode in the adapter's record. */
  file?: string;
  /** mu's permission modes, from its last `permissions.mode` event; unset while mu reports none. */
  permissions?: PermissionModes;
  /** What mu said about the permission question it is about to ask. */
  request?: PermissionRequest;
  /** Mode switches from the app in flight: mu's own "switched" note is not shown as a reply then. */
  switching: number;
  /**
   * mu's process has stopped (a crash, a kill). The conversation's next call starts a new one on the same session file
   * (`live`); a turn that was running fails with `processExited`.
   */
  stopped?: boolean;
  /** The conversation was told that Git for Windows is missing: once is enough. */
  bashMissingSaid?: boolean;
  /** mu runs without a model (pi found none it could use when it started), as its last state said. */
  noModel?: boolean;
  /** A look for a model this conversation can run on, while one is under way (`findModel`). */
  finding?: Promise<void>;
  /** What the conversation's notices have said: a warning, a checkpoint or a judge notice is said once. */
  said: Set<string>;
  /** A warning of mu's, held until its next event, which may say the same in the app's words (`checkpoint.off`). */
  held?: { text: string; level: NoticeLevel; timer: NodeJS.Timeout };
  /** Calls the person said no to: their rows say so, not the refusal mu hands the model. */
  denied: Set<string>;
  /** Calls mu started and has not ended yet (`endOpenCalls`). */
  open: Set<string>;
  /** The judge asked about the message being classified, for a row that ends without its answer. */
  judge?: string;
};
/** How a notice of mu's reads: an answer (`info`), or something that went wrong. */
type NoticeLevel = 'info' | 'warning' | 'error';
type RpcFactory = (
  cwd: string,
  file: string | undefined,
  onEvent: (event: JsonRecord) => void,
  /** The adapter session this harness process serves. */
  sessionId?: string,
  /** Added to the environment of the harness process. */
  env?: Readonly<Record<string, string>>
) => RpcPort;

/**
 * The errors this bridge raises into a conversation, in plain English. The bridge runs without i18n and what it
 * raises is stored with the conversation, so the desktop recognises these texts and shows its own translation
 * (`renderer/utils/chat/muTurnErrors.ts`, which a test keeps in step with this list).
 */
export const MU_TURN_ERRORS = {
  processExited: 'mu process exited during the turn',
  modelFailed: 'Model request failed',
  turnRunning: 'A mu turn is already running',
  busyConfig: 'Wait for the current turn before changing configuration',
  unsupportedValue: 'Unsupported configuration value',
  permissionsNotSwitched: 'mu did not switch permissions',
  imageUnsupported: 'Unsupported image format or size',
  contentUnsupported: 'This mu adapter accepts text, images and text resources',
  wrongProject: 'Session belongs to a different project',
  notPersisted: 'mu did not persist the session',
  /** pi has no model to answer with, or none it has a key for. pi's own words (with `/login` help) follow as a detail. */
  noModel: 'mu has no model to answer with',
} as const;

/** pi's words when it cannot run a prompt for want of a model: none at all, none chosen, or none with a key. */
const NO_MODEL = /No API key found for|No models available|No model selected/;
/** proper-lockfile's words for a store another mu process holds: pi did not start the prompt, which can go again. */
const STORE_LOCKED = /Lock file is already being held|ELOCKED/;
/** How long a conversation that started without a model looks for one, step by step: about six seconds in all. */
const MODEL_WAITS_MS = [0, 500, 1000, 2000, 3000] as const;
/** A message sent while there is still no model looks once more, more briefly. */
const PROMPT_MODEL_WAITS_MS = [0, 1000, 2000] as const;
/** A prompt refused because the model store was locked goes again after these waits. */
const LOCKED_RETRY_MS = [1500, 3000] as const;
/** How long a warning waits for the event that may say it in the app's words. */
const NOTICE_HOLD_MS = 150;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** pi's placeholder while it has no model (`unknown/unknown`), and a state that names none. */
export function isNoModel(model: unknown): boolean {
  const { provider, id } = asRecord(model);
  return !text(provider) || !text(id) || (provider === 'unknown' && id === 'unknown');
}

/**
 * A failure for want of a model, under the fixed headline, with pi's first sentence as the detail: the rest tells a
 * terminal user to run `/login` and names a file of the harness's docs, neither of which a desktop user can act on.
 */
function noModelError(said: string, cause?: unknown): Error | undefined {
  // Said under the headline already, or no such failure.
  if (said.startsWith(MU_TURN_ERRORS.noModel) || !NO_MODEL.test(said)) return undefined;
  const detail = said
    .split(/\n\s*\n/)[0]
    .replace(/\s*Use \/login[\s\S]*$/, '')
    .trim();
  return new Error(detail ? `${MU_TURN_ERRORS.noModel}: ${detail}` : MU_TURN_ERRORS.noModel, { cause });
}

/**
 * The model mu starts new sessions on: pi's `defaultProvider` and `defaultModel` in the agent folder's settings, or
 * undefined when there is none or the file cannot be read.
 *
 * @param home the user's home directory; tests pass a temporary one
 */
export function readDefaultModel(home?: string): { provider: string; id: string } | undefined {
  try {
    const agentDir = muEnv('AGENT_DIR') || join(muHome(home), 'agent');
    const settings = asRecord(JSON.parse(readFileSync(join(agentDir, 'settings.json'), 'utf8')));
    const provider = text(settings.defaultProvider);
    const id = text(settings.defaultModel);
    return provider && id ? { provider, id } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One-line notices the bridge adds to a conversation, by code. The bridge has no i18n: a notice is a tool call whose id
 * starts with `mu:notice:` and whose input carries the code (`rawInput.notice`); the desktop shows it as one line in
 * the reader's language (`renderer/pages/conversation/Messages/acp/muNotice.ts`, which a test keeps in step with this
 * list). The English text is its title, for other clients.
 */
export const MU_NOTICES = {
  /** A question of mu's got no usable answer (the app failed to ask, or answered with none of the choices). */
  answer_lost: 'mu did not get your answer, so it went on as if you had declined.',
  /** A command failed because mu found no bash on Windows: Git for Windows is missing (see `bashMissing`). */
  bash_missing:
    'mu needs Git for Windows to run commands. Once it is installed, send your message again. Download it here: https://git-scm.com/download/win',
  /**
   * The conversation goes without checkpoints (mu's `checkpoint.off`). The input carries mu's reason code and what it
   * names (`code`, `params`); the title is mu's own line, already in the app's language, and this only its stand-in.
   */
  checkpoint_off: 'mu: checkpoints are off in this session.',
  /**
   * No Jev key is set, so the judge answers with the free Jev on OpenCode Zen (mu's `judge.notice`). The title is mu's
   * own line, already in the app's language, and this only its stand-in.
   */
  free_jev: 'mu: no Jev key is set, so the judge uses the free Jev on OpenCode Zen for now.',
  /**
   * The free Jev stopped answering (mu's `judge.notice`); the input's `code` says why: `paid` (it asks for a key or
   * payment) or `gone` (no longer offered). Plain rules decide until a Jev key is set.
   */
  free_jev_unavailable: 'mu: the free Jev stopped answering, so plain rules decide until a Jev key is set.',
  /** The person stopped the reply: what came before this line is all of it. */
  stopped: 'You stopped this reply.',
} as const;
export type MuNoticeCode = keyof typeof MU_NOTICES;

/**
 * A shell call that failed because mu found no bash, which on Windows means Git for Windows is missing. The words are
 * pi's (`getShellConfig` in the harness's `packages/coding-agent/src/utils/shell.ts`, whose test keeps the first line).
 */
export function bashMissing(event: JsonRecord): boolean {
  return (
    event.type === 'tool_execution_end' &&
    event.isError === true &&
    /No bash shell found/.test(messageText(asRecord(event.result).content))
  );
}

/**
 * The language the app shows, as the desktop last wrote it to `<mu home>/app-language` for the harness, or undefined
 * when the file is missing or unreadable. Read at every harness start, so a new session follows a language switch.
 *
 * @param home the user's home directory; tests pass a temporary one
 */
export function readAppLanguage(home: string = homedir()): string | undefined {
  try {
    return readFileSync(join(muHome(home), 'app-language'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The environment a harness process gets besides the inherited one. */
export function harnessEnv(sessionId: string | undefined, home?: string): Record<string, string> {
  const language = readAppLanguage(home);
  return {
    // The app's browser bridge learns from this which conversation a browsing run belongs to: the harness hands the
    // value back in its hello, and the app looks the conversation up by the session.
    ...(sessionId ? { MU_DESKTOP_SESSION: sessionId } : {}),
    // The harness words its notices, confirmations and choices in this language.
    ...(language ? { MU_LANG: language } : {}),
  };
}

/** Option ids of the two answers to a harness confirmation; the desktop names them in the reader's language. */
const CONFIRM_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
] as const;

/** ACP adapter only: AionUi owns the UI and projects; mu owns all execution and judgment. */
export class KyrnAgent implements Agent {
  private connection: Connection;
  private store: string;
  private factory: RpcFactory;
  private home: string | undefined;
  private sessions = new Map<string, Session>();
  /** Sessions whose stopped mu is being started again (`live`). */
  private reviving = new Map<string, Promise<void>>();
  /**
   * @param home the user's home directory, whose mu home holds the app language; tests pass a temporary one
   */
  constructor(connection: Connection, launcher: string, store: string, factory?: RpcFactory, home?: string) {
    this.connection = connection;
    this.store = store;
    this.home = home;
    this.factory = factory ?? ((cwd, file, onEvent, _sessionId, env) => new PiRpc(launcher, cwd, file, onEvent, env));
    mkdirSync(store, { recursive: true, mode: 0o700 });
  }
  async initialize(): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      // `name` is an identifier the backend has already seen; only the title is shown.
      agentInfo: { name: 'kyrn', title: 'mu', version: '0.1.0' },
      agentCapabilities: { loadSession: true, promptCapabilities: { embeddedContext: true, image: true } },
      authMethods: [],
    };
  }
  async authenticate(): Promise<Record<string, never>> {
    return {};
  }
  private session(id: string): Session {
    const found = this.sessions.get(id);
    if (!found) throw new Error('Unknown mu session');
    return found;
  }
  private path(id: string): string {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid mu session ID');
    return join(this.store, `${id}.json`);
  }
  private async state(id: string): Promise<JsonRecord> {
    const session = this.session(id);
    const [state, stats] = await Promise.all([
      session.rpc.send({ type: 'get_state' }),
      session.rpc.send({ type: 'get_session_stats' }).catch(() => ({}) as JsonRecord),
    ]);
    session.telemetry.context({ ...state, sessionTokens: stats.tokens });
    session.noModel = isNoModel(state.model);
    return state;
  }
  private refresh(id: string): void {
    const session = this.sessions.get(id);
    // An old process can still speak while it is being ended, after its session was replaced or closed.
    if (!session || session.stopped) return;
    session.dirty = true;
    if (session.refreshing) return;
    session.refreshing = (async () => {
      while (session.dirty && this.sessions.has(id)) {
        session.dirty = false;
        // Re-read after a burst so a compaction never leaves the old token count on screen.
        // eslint-disable-next-line no-await-in-loop
        await this.state(id);
      }
    })()
      .catch((): void => {})
      .finally(() => {
        session.refreshing = undefined;
      });
  }
  /** The adapter's record of a conversation: where mu keeps it, and the permission mode it was last in. */
  private save(id: string, session: Session): void {
    const path = this.path(id);
    const record = { cwd: session.cwd, file: session.file, permissions: session.permissions?.mode };
    writeFileSync(`${path}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  private async attach(id: string, cwd: string, file?: string, permissions?: string): Promise<void> {
    if (this.sessions.has(id)) return;
    const session = {
      queue: Promise.resolve(),
      busy: false,
      cancelled: false,
      cwd,
      streamed: '',
      thought: '',
      switching: 0,
      said: new Set<string>(),
      denied: new Set<string>(),
      open: new Set<string>(),
    } as Session;
    this.sessions.set(id, session);
    const telemetry = new Telemetry(this.store, id);
    session.telemetry = telemetry;
    const onEvent = (event: JsonRecord): void => {
      telemetry.capture(event);
      const shown = presentation(event);
      // A held warning goes out before whatever came after it, unless this is mu saying the same by its code.
      if (session.held) {
        if (shown?.kind === 'checkpoint.off' && text(shown.payload.message).trim() === session.held.text) {
          clearTimeout(session.held.timer);
          session.held = undefined;
        } else this.release(id, session);
      }
      if (
        [
          'agent_start',
          'agent_settled',
          'message_end',
          'tool_execution_end',
          'compaction_start',
          'compaction_end',
        ].includes(text(event.type))
      ) {
        this.refresh(id);
      }
      if (event.type === 'agent_start') session.started = true;
      if (event.type === 'tool_execution_start') session.open.add(text(event.toolCallId));
      if (event.type === 'tool_execution_end') session.open.delete(text(event.toolCallId));
      if (event.type === 'agent_settled') session.settled?.();
      if (event.type === 'kyrn_rpc_closed') {
        session.stopped = true;
        session.error = new Error(MU_TURN_ERRORS.processExited);
        session.settled?.();
      }
      if (event.type === 'message_start' && asRecord(event.message).role === 'assistant') {
        session.streamed = '';
        session.thought = '';
      }
      this.permissionEvent(id, session, shown);
      if (shown?.kind === 'preflight.pending') session.judge = text(shown.payload.judge) || undefined;
      const notified = event.type === 'extension_ui_request' && event.method === 'notify';
      // mu's "switched" note while the app switches the mode itself says nothing the picker does not show.
      const quiet = session.switching > 0 && notified && event.notifyType === 'info';
      const updates = mapEvent(event);
      // No bash on Windows: pi's error (English, with options meant for developers) makes way for one line in the
      // reader's language with the download link, said once below.
      const noBash = bashMissing(event);
      // A call the person said no to ends with mu's refusal, which is for the model: the row says so in its own words.
      const denied = event.type === 'tool_execution_end' && session.denied.delete(text(event.toolCallId));
      for (const update of updates) {
        if (update.sessionUpdate !== 'tool_call_update') continue;
        if (noBash) {
          update.content = [];
          update.rawOutput = { notice: 'bash_missing' };
        }
        if (denied) update.rawOutput = { ...asRecord(update.rawOutput), mu: { answer: 'deny' } };
        // A classification that ended without an answer is named by the judge that was asked.
        if (asRecord(update.rawOutput).preflight === 'fallback' && session.judge)
          update.rawOutput = { ...asRecord(update.rawOutput), judge: session.judge };
      }
      for (const update of updates) {
        if (update.sessionUpdate === 'agent_thought_chunk' && update.content.type === 'text')
          session.thought += update.content.text;
        if (
          update.sessionUpdate === 'agent_message_chunk' &&
          update.content.type === 'text' &&
          event.type === 'message_update'
        ) {
          session.streamed += update.content.text;
        }
      }
      if (event.type === 'message_end') {
        const message = asRecord(event.message);
        const thought = messageThinking(message.content);
        if (
          message.role === 'assistant' &&
          thought.startsWith(session.thought) &&
          thought.length > session.thought.length
        ) {
          updates.push({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: thought.slice(session.thought.length) },
          });
          session.thought = thought;
        }
        if (message.role === 'assistant') {
          // The provider's own text follows a fixed headline, which the desktop translates. A model without a key is
          // no failure of the request: the desktop sends the person to set one up.
          const detail = text(message.errorMessage);
          const failed = detail ? `${MU_TURN_ERRORS.modelFailed}: ${detail}` : MU_TURN_ERRORS.modelFailed;
          session.error = message.stopReason === 'error' ? (noModelError(detail) ?? new Error(failed)) : undefined;
        }
        // Some providers finish with authoritative text without emitting text deltas.
        // Only forward the unstreamed suffix so ordinary streaming never duplicates the answer.
        const finalText = messageText(message.content);
        if (
          message.role === 'assistant' &&
          finalText.startsWith(session.streamed) &&
          finalText.length > session.streamed.length
        ) {
          updates.push({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: finalText.slice(session.streamed.length) },
          });
          session.streamed = finalText;
        }
      }
      if (
        event.type === 'extension_ui_request' &&
        ['confirm', 'select', 'input', 'editor'].includes(text(event.method))
      ) {
        // Permissions are out-of-band so a pending dialog cannot block cancellation or streaming.
        void this.permission(id, session, event);
        return;
      }
      for (const update of updates)
        session.queue = session.queue
          .then(() => this.connection.sessionUpdate({ sessionId: id, update }))
          .catch((): void => {});
      if (noBash && !session.bashMissingSaid) {
        session.bashMissingSaid = true;
        this.notice(id, session, 'bash_missing');
      }
      if (notified && !quiet) this.harnessNotice(id, session, text(event.message), text(event.notifyType));
      if (shown?.kind === 'checkpoint.off') this.checkpointNotice(id, session, shown.payload);
      if (shown?.kind === 'judge.notice') this.judgeNotice(id, session, shown.payload);
    };
    session.rpc = this.factory(cwd, file, onEvent, id, {
      ...harnessEnv(id, this.home),
      // A reopened conversation starts in the mode it was last in, unless mu's own record of it says otherwise.
      ...(permissions ? { MU_PERMISSIONS: permissions } : {}),
    });
    let model: unknown;
    try {
      const state = await this.state(id);
      // mu announces its mode at startup, before it answers anything, so the options below already carry it.
      session.opened = true;
      if (!state.sessionFile) throw new Error(MU_TURN_ERRORS.notPersisted);
      session.file = text(state.sessionFile);
      this.save(id, session);
      model = state.model;
    } catch (error) {
      session.rpc.close();
      this.sessions.delete(id);
      throw error;
    }
    if (isNoModel(model)) this.lookForModel(id, session, MODEL_WAITS_MS);
  }
  /**
   * pi chooses a conversation's model when it starts, from the models it can use then. One that started while another
   * mu process held the model store found none and runs without one; the store frees up within seconds. So the
   * conversation keeps looking for a while, takes the model new sessions start on (or the first one offered) as soon
   * as pi lists it, and the send box hears of it. Nothing is chosen when the person picked a model meanwhile.
   */
  private lookForModel(id: string, session: Session, waits: readonly number[]): void {
    if (session.finding) return;
    const finding = this.findModel(id, session, waits)
      .catch((): void => {})
      .finally(() => {
        if (session.finding === finding) session.finding = undefined;
      });
    session.finding = finding;
  }
  private async findModel(id: string, session: Session, waits: readonly number[]): Promise<void> {
    const wanted = readDefaultModel(this.home);
    for (const wait of waits) {
      // eslint-disable-next-line no-await-in-loop
      if (wait) await delay(wait);
      if (this.sessions.get(id) !== session || session.stopped) return;
      // eslint-disable-next-line no-await-in-loop
      const models = array((await session.rpc.send({ type: 'get_available_models' })).models).map(asRecord);
      const pick =
        models.find((each) => text(each.provider) === wanted?.provider && text(each.id) === wanted?.id) ??
        models.find((each) => text(each.provider) && text(each.id) && !UNOFFERED_PROVIDER_IDS.has(text(each.provider)));
      if (!pick) continue;
      // eslint-disable-next-line no-await-in-loop
      if (!isNoModel((await this.state(id)).model)) return;
      // eslint-disable-next-line no-await-in-loop
      await session.rpc.send({ type: 'set_model', provider: text(pick.provider), modelId: text(pick.id) });
      // eslint-disable-next-line no-await-in-loop
      await this.state(id);
      this.announce(id, session);
      return;
    }
  }
  /**
   * The session with a running mu. One whose mu stopped (it crashed, or was killed) gets a new process on the same session
   * file, in the mode it was in, so the conversation goes on instead of failing every call after that. A new process
   * that does not start leaves the session as it was, for the next call to try again.
   */
  private async live(id: string): Promise<Session> {
    await this.reviving.get(id);
    const session = this.session(id);
    if (!session.stopped) return session;
    if (!session.file) throw new Error(MU_TURN_ERRORS.processExited);
    const revival = (async () => {
      this.sessions.delete(id);
      session.rpc.close();
      try {
        await this.attach(id, session.cwd, session.file, session.permissions?.mode);
      } catch (error) {
        if (!this.sessions.has(id)) this.sessions.set(id, session);
        throw error;
      }
    })().finally(() => this.reviving.delete(id));
    this.reviving.set(id, revival);
    await revival;
    const revived = this.session(id);
    // The conversation has already heard what the old process said once (a checkpoint notice, a warning).
    for (const said of session.said) revived.said.add(said);
    // The send box learns the new process's options (the same model and mode, read again).
    this.announce(id, revived);
    return revived;
  }
  /**
   * Keeps what mu says about permissions: its modes for the send box, its next question for the card, and the calls
   * the person said no to.
   */
  private permissionEvent(id: string, session: Session, shown: ReturnType<typeof presentation>): void {
    if (shown?.kind === 'permissions.mode') {
      const modes = readModes(shown.payload);
      if (!modes) return;
      const before = session.permissions?.mode;
      session.permissions = modes;
      // A switch typed in the conversation, or made by the send box: the picker follows either way.
      if (session.opened && before !== modes.mode) {
        this.announce(id, session);
        // AionCore sets the mode it last saw whenever it reopens a conversation; one that was never switched would
        // otherwise come back in mu's current default, and that set would then switch it (and save it as mu's default).
        try {
          if (session.file) this.save(id, session);
        } catch {
          // The conversation keeps its mode for now; only a reopen can come back in another one.
        }
      }
    }
    if (shown?.kind === 'permissions.request') session.request = readRequest(shown.payload);
    if (shown?.kind === 'permissions.resolved') {
      session.request = undefined;
      const { answer, toolCallId } = readResolved(shown.payload);
      if (answer === 'deny' && toolCallId) session.denied.add(toolCallId);
    }
  }
  private announce(id: string, session: Session): void {
    session.queue = session.queue
      .then(async () => {
        const configOptions = await this.options(id);
        await this.connection.sessionUpdate({
          sessionId: id,
          update: { sessionUpdate: 'config_option_update', configOptions },
        });
      })
      .catch((): void => {});
  }
  /**
   * Switches this conversation with mu's own command. It runs at once, even during a turn: the next call is checked
   * under the new mode. The switch is for this conversation only (`--here`): the app sets a mode by itself too, when it
   * opens a conversation or seeds a new one, and the mode new conversations start in is set in the settings. An older
   * mu, which has no `--here`, makes each switch its default as well.
   */
  private async switchPermissions(id: string, value: string): Promise<SetSessionConfigOptionResponse> {
    const session = this.session(id);
    if (!session.permissions?.modes.some((mode) => mode.id === value)) throw new Error(MU_TURN_ERRORS.unsupportedValue);
    // The app sets the mode it remembers whenever it opens a conversation; the same mode again is no switch (mu
    // would forget what was allowed for this conversation).
    if (session.permissions.mode !== value) {
      session.switching += 1;
      let timer: NodeJS.Timeout | undefined;
      try {
        // A prompt has no deadline in the RPC client; this one is a command that answers at once.
        await Promise.race([
          session.rpc.send({
            type: 'prompt',
            message: `/permissions ${value}${session.permissions.conversationSwitch ? ' --here' : ''}`,
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(MU_TURN_ERRORS.permissionsNotSwitched)), 30000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        session.switching -= 1;
      }
      // mu announces the new mode before it answers the command.
      if (session.permissions.mode !== value) throw new Error(MU_TURN_ERRORS.permissionsNotSwitched);
    }
    return { configOptions: await this.options(id) };
  }
  private async options(id: string): Promise<SessionConfigOption[]> {
    const session = this.session(id);
    const { rpc } = session;
    const [state, models, levels] = await Promise.all([
      this.state(id),
      rpc.send({ type: 'get_available_models' }),
      rpc.send({ type: 'get_available_thinking_levels' }),
    ]);
    const current = asRecord(state.model);
    // No model is no value: pi's placeholder (`unknown/unknown`) is not a model the send box could name.
    const currentValue = isNoModel(current) ? '' : `${text(current.provider)}/${text(current.id)}`;
    const offered = array(models.models)
      .map(asRecord)
      // A model already in use stays listed, so the picker still shows what the conversation runs on.
      .filter(
        (model) =>
          !UNOFFERED_PROVIDER_IDS.has(text(model.provider)) ||
          `${text(model.provider)}/${text(model.id)}` === currentValue
      );
    // What each model takes, by pi's own rule, beside the options: an ACP select option has no room for it. The send
    // box offers each model with its levels, so one pick can switch both.
    session.telemetry.levels(
      Object.fromEntries(
        offered.map((model) => [
          `${text(model.provider)}/${text(model.id)}`,
          supportedThinkingLevels(model.reasoning === true, asRecord(model.thinkingLevelMap)),
        ])
      )
    );
    return [
      {
        id: 'model',
        category: 'model',
        name: 'Model',
        type: 'select',
        currentValue,
        options: offered.map((model) => ({
          value: `${text(model.provider)}/${text(model.id)}`,
          name: text(model.name) || text(model.id),
          description: text(model.provider),
        })),
      },
      {
        id: 'thinking',
        category: 'thought_level',
        name: 'Thinking',
        type: 'select',
        currentValue: text(state.thinkingLevel),
        options: array(levels.levels).map((level) => ({ value: text(level), name: text(level) })),
      },
      ...(session.permissions ? [modeOption(session.permissions)] : []),
    ];
  }
  /**
   * Tells the app which slash commands mu has, for the send box's `/` menu. Called as a session is answered: the app
   * keeps a session's commands only once it knows the session, so this runs after the answer has gone out.
   */
  private advertise(id: string): void {
    setImmediate(() => {
      const session = this.sessions.get(id);
      if (!session) return;
      session.queue = session.queue
        .then(async () => {
          const availableCommands = slashCommands(await session.rpc.send({ type: 'get_commands' }));
          if (!availableCommands.length) return;
          await this.connection.sessionUpdate({
            sessionId: id,
            update: { sessionUpdate: 'available_commands_update', availableCommands },
          });
        })
        .catch((): void => {});
    });
  }
  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const id = randomUUID();
    const cwd = await realpath(params.cwd);
    const imported = await this.importFor(cwd);
    await this.attach(id, cwd, imported?.record.file);
    if (imported) this.adopted(imported.conversationId, imported.record, id);
    const configOptions = await this.options(id);
    this.advertise(id);
    return { sessionId: id, configOptions };
  }
  /**
   * The session a conversation the app made from a Claude Code or Codex transcript goes on with, until an adapter
   * session has opened it (process/agent/kyrn/importChats.ts). The backend starts an adapter for each conversation and
   * names the conversation in the adapter's environment (`AIONUI_CONVERSATION_ID`, the backend's own variable).
   */
  private async importFor(cwd: string): Promise<{ conversationId: string; record: ImportRecord } | undefined> {
    const conversationId = process.env.AIONUI_CONVERSATION_ID;
    if (!isConversationId(conversationId)) return undefined;
    const record = readImportRecord(this.store, conversationId);
    if (!record || record.session || !existsSync(record.file)) return undefined;
    // The conversation runs in the folder the transcript ran in; a folder that moved since cannot take the session.
    const folder = await realpath(record.cwd).catch(() => record.cwd);
    if (folder !== cwd) throw new Error(MU_TURN_ERRORS.wrongProject);
    return { conversationId, record };
  }
  /** Marks an imported session as taken: a conversation reset later starts a session of its own. */
  private adopted(conversationId: string, record: ImportRecord, session: string): void {
    try {
      writeImportRecord(this.store, conversationId, { ...record, session });
    } catch {
      // Unmarked, the conversation's next new session opens the same file again: the conversation, as it was.
    }
  }
  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const saved = asRecord(JSON.parse(readFileSync(this.path(params.sessionId), 'utf8')));
    const cwd = await realpath(params.cwd);
    if (saved.cwd !== cwd) throw new Error(MU_TURN_ERRORS.wrongProject);
    const permissions = text(saved.permissions);
    await this.attach(params.sessionId, cwd, text(saved.file), isModeId(permissions) ? permissions : undefined);
    const messages = await (await this.live(params.sessionId)).rpc.send({ type: 'get_messages' });
    for (const item of array(messages.messages).map(asRecord)) {
      if (!['user', 'assistant'].includes(text(item.role))) continue;
      const thought = item.role === 'assistant' ? messageThinking(item.content) : '';
      // Replay must remain ordered with the text immediately following it.
      if (thought) {
        // eslint-disable-next-line no-await-in-loop
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: thought },
          },
        });
      }
      const value = messageText(item.content);
      if (!value) continue;
      // Preserve transcript order; parallel notifications can interleave user and assistant chunks.
      // eslint-disable-next-line no-await-in-loop
      await this.connection.sessionUpdate({
        sessionId: params.sessionId,
        update: {
          sessionUpdate: item.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: value },
        },
      });
    }
    const configOptions = await this.options(params.sessionId);
    this.advertise(params.sessionId);
    return { configOptions };
  }
  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    const session = await this.live(params.sessionId);
    if (params.configId === 'mode') return this.switchPermissions(params.sessionId, String(params.value));
    if (session.busy) throw new Error(MU_TURN_ERRORS.busyConfig);
    const options = await this.options(params.sessionId);
    const option = options.find((item) => item.id === params.configId);
    if (
      !option ||
      option.type !== 'select' ||
      !option.options.some((item) => 'value' in item && item.value === params.value)
    )
      throw new Error(MU_TURN_ERRORS.unsupportedValue);
    if (params.configId === 'model') {
      const value = String(params.value);
      const slash = value.indexOf('/');
      await session.rpc.send({ type: 'set_model', provider: value.slice(0, slash), modelId: value.slice(slash + 1) });
    } else await session.rpc.send({ type: 'set_thinking_level', level: params.value });
    const configOptions = await this.options(params.sessionId);
    await this.connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions },
    });
    return { configOptions };
  }
  async unstable_setSessionModel(params: SetSessionModelRequest): Promise<Record<string, never>> {
    await this.setSessionConfigOption({ sessionId: params.sessionId, configId: 'model', value: params.modelId });
    return {};
  }
  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (this.session(params.sessionId).busy) throw new Error(MU_TURN_ERRORS.turnRunning);
    const images: { type: 'image'; data: string; mimeType: string }[] = [];
    const parts = params.prompt.map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') {
        if (!/^image\/(png|jpeg|webp|gif)$/.test(block.mimeType) || block.data.length > 16 * 1024 * 1024)
          throw new Error(MU_TURN_ERRORS.imageUnsupported);
        images.push({ type: 'image', mimeType: block.mimeType, data: block.data });
        return '';
      }
      if (block.type === 'resource' && 'text' in block.resource) return block.resource.text;
      if (block.type === 'resource_link') return `${block.name}: ${block.uri}`;
      throw new Error(MU_TURN_ERRORS.contentUnsupported);
    });
    const found = this.session(params.sessionId);
    // Only a conversation whose mu stopped waits for a new one; any other sends the prompt at once, as before.
    const session = found.stopped || this.reviving.has(params.sessionId) ? await this.live(params.sessionId) : found;
    if (session.busy) throw new Error(MU_TURN_ERRORS.turnRunning);
    session.busy = true;
    session.cancelled = false;
    session.error = undefined;
    session.started = false;
    const completed = new Promise<void>((resolve) => {
      session.settled = resolve;
    });
    try {
      // A conversation that started without a model gets a moment to find one before the message goes to mu.
      if (session.noModel) {
        this.lookForModel(params.sessionId, session, PROMPT_MODEL_WAITS_MS);
        await session.finding;
      }
      if (!session.cancelled) {
        await this.sendPrompt(session, {
          type: 'prompt',
          message: parts.join('\n'),
          ...(images.length ? { images } : {}),
        });
        // An abort during classification can precede agent_start. Repeat after ACK
        // so cancellation never accidentally launches a fresh model turn.
        if (session.cancelled) await session.rpc.send({ type: 'abort' });
        // pi acknowledges preflight, not turn completion. ACP must remain open until
        // agent_settled, including automatic retries, tools and completion nudges.
        // Extension slash commands can be handled without starting an agent at all.
        const state = await this.state(params.sessionId);
        if (session.started || state.isStreaming || state.isCompacting) await completed;
      }
      this.endOpenCalls(params.sessionId, session);
      await session.queue;
      // A mu that stopped during the turn answers nothing more; the turn failed, and says why.
      if (session.stopped) throw new Error(MU_TURN_ERRORS.processExited);
      await this.state(params.sessionId);
      if (session.error) throw session.error;
      if (!session.cancelled) return { stopReason: 'end_turn' };
      // A reply that was stopped would read as a finished one: the line after it says it was stopped.
      this.notice(params.sessionId, session, 'stopped');
      await session.queue;
      return { stopReason: 'cancelled' };
    } catch (error) {
      this.endOpenCalls(params.sessionId, session);
      await session.queue;
      // Whatever failed first (the prompt, a state read), a mu that stopped is the reason.
      if (session.stopped) throw new Error(MU_TURN_ERRORS.processExited, { cause: error });
      throw noModelError(errorText(error), error) ?? error;
    } finally {
      session.busy = false;
      session.settled = undefined;
    }
  }
  /**
   * A turn is over, and a call mu started has no end: its process closed mid-call (a crash, a kill), or the turn ended
   * without one. The conversation keeps what it was last told, so that row would stay running for good, a sub-agent
   * card with its bees at work. It ends as failed: the call did not finish, and the turn says why.
   */
  private endOpenCalls(id: string, session: Session): void {
    for (const toolCallId of session.open) {
      const update: SessionUpdate = { sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' };
      session.queue = session.queue
        .then(() => this.connection.sessionUpdate({ sessionId: id, update }))
        .catch((): void => {});
    }
    session.open.clear();
  }
  /**
   * Sends a prompt, and sends it again after a moment when pi refused it because another mu process held the model
   * store: pi had not started it then, so nothing runs twice.
   */
  private async sendPrompt(session: Session, command: JsonRecord): Promise<void> {
    for (const wait of [...LOCKED_RETRY_MS, undefined]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await session.rpc.send(command);
        return;
      } catch (error) {
        if (wait === undefined || session.cancelled || session.stopped || !STORE_LOCKED.test(errorText(error)))
          throw error;
        // eslint-disable-next-line no-await-in-loop
        await delay(wait);
      }
    }
  }
  async cancel(params: CancelNotification): Promise<void> {
    const session = this.session(params.sessionId);
    session.cancelled = true;
    // A mu that stopped runs nothing that could be stopped.
    if (session.stopped) return;
    await session.rpc.send({ type: 'abort' });
  }
  /**
   * One line in the conversation, in the reader's language (see MU_NOTICES). `title` stands in for the code's English
   * where mu said it itself; `input` is what the code names.
   */
  private notice(
    id: string,
    session: Session,
    code: MuNoticeCode,
    { title, input }: { title?: string; input?: JsonRecord } = {}
  ): void {
    this.line(id, session, title || MU_NOTICES[code], { notice: code, ...input });
  }
  /** A line of its own in the conversation: a tool call the desktop shows as one line, never as a call. */
  private line(id: string, session: Session, title: string, rawInput: JsonRecord): void {
    const update: SessionUpdate = {
      sessionUpdate: 'tool_call',
      toolCallId: `mu:notice:${randomUUID()}`,
      title,
      kind: 'other',
      status: 'completed',
      rawInput,
    };
    session.queue = session.queue
      .then(() => this.connection.sessionUpdate({ sessionId: id, update }))
      .catch((): void => {});
  }
  /**
   * What mu notified, as a line of its own: it is no part of the reply. mu words it in the app's language already.
   * An answer (`info`, such as a command's reply) is said each time; a warning or an error once per conversation, and
   * only after a moment, because mu may say the same right after by its code (`checkpoint.off`), which the app words.
   * Words a coded notice said just before (`judge.notice`) are not said again.
   */
  private harnessNotice(id: string, session: Session, message: string, type: string): void {
    const words = message.trim();
    if (!words) return;
    const level: NoticeLevel = type === 'warning' || type === 'error' ? type : 'info';
    if (level === 'info') {
      if (session.said.has(`coded:${words}`)) return;
      this.line(id, session, words, { level });
      return;
    }
    this.release(id, session);
    if (session.said.has(`text:${words}`)) return;
    const timer = setTimeout(() => this.release(id, session), NOTICE_HOLD_MS);
    session.held = { text: words, level, timer };
  }
  /** The warning held back by `harnessNotice`, said now, unless the conversation has heard it. */
  private release(id: string, session: Session): void {
    const held = session.held;
    if (!held) return;
    session.held = undefined;
    clearTimeout(held.timer);
    if (session.said.has(`text:${held.text}`)) return;
    session.said.add(`text:${held.text}`);
    this.line(id, session, held.text, { level: held.level });
  }
  /**
   * The session goes without checkpoints (mu's `checkpoint.off`): one line, by mu's code, which the desktop words in
   * the app's language. mu's own line is its title, and is not said again as a plain notice.
   */
  private checkpointNotice(id: string, session: Session, payload: JsonRecord): void {
    const message = text(payload.message).trim();
    if (message) session.said.add(`text:${message}`);
    if (session.said.has('checkpoint_off')) return;
    session.said.add('checkpoint_off');
    const reason = text(payload.code);
    // The numbers mu's reason names (a limit, seconds); nothing else of its params is passed on.
    const given = asRecord(payload.params);
    const params = Object.fromEntries(
      Object.entries(given).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
    );
    this.notice(id, session, 'checkpoint_off', {
      title: message,
      input: { ...(reason ? { code: reason } : {}), params },
    });
  }
  /**
   * mu's `judge.notice`: the judge answers with the free Jev on OpenCode Zen (`free_jev`), or the free Jev stopped
   * (`free_jev_unavailable`, why in `reason`). One line each per conversation, by code, which the desktop words in the
   * app's language; mu's own line, its title, comes right after as a notification and is not said again. A code this
   * build does not know leaves mu's line to say it.
   */
  private judgeNotice(id: string, session: Session, payload: JsonRecord): void {
    const code = text(payload.code);
    if (code !== 'free_jev' && code !== 'free_jev_unavailable') return;
    const message = text(payload.message).trim();
    if (message) {
      session.said.add(`coded:${message}`);
      session.said.add(`text:${message}`);
    }
    if (session.said.has(code)) return;
    session.said.add(code);
    const reason = text(payload.reason);
    this.notice(id, session, code, { title: message, input: reason ? { code: reason } : {} });
  }
  /**
   * Asks the app one of mu's questions and answers mu exactly once, whatever happens: a failure to ask, an answer that
   * is none of the choices, or an error here all end as "cancelled" (for a permission, not allowed), with a line in the
   * conversation that says so. mu is never left waiting on a question the app can no longer answer.
   */
  private async permission(id: string, session: Session, event: JsonRecord): Promise<void> {
    let answered = false;
    const answer = (response: JsonRecord): void => {
      if (answered) return;
      answered = true;
      session.rpc.respond({ id: event.id, ...response });
    };
    try {
      await this.ask(id, session, event, answer);
    } catch {
      // The app could not ask, or answering failed here.
    }
    if (answered) return;
    answer({ cancelled: true });
    this.notice(id, session, 'answer_lost');
  }
  /** The question as the app shows it, and the answer back to mu; returns without answering when there is none to give. */
  private async ask(
    id: string,
    session: Session,
    event: JsonRecord,
    answer: (response: JsonRecord) => void
  ): Promise<void> {
    if (!['confirm', 'select'].includes(text(event.method))) {
      answer({ cancelled: true });
      return;
    }
    const confirm = event.method === 'confirm';
    // A confirmation gets stable ids and kinds, so the desktop words the two answers in the reader's language (the
    // names are the English fallback). The choices of a select are the harness's own text and stay as sent.
    const choices = confirm ? [] : array(event.options).map(text);
    const message = text(event.message);
    // mu's permission question comes right after what it said about it; any other picker keeps the plain shape.
    const request = !confirm && session.request && asks(session.request, choices) ? session.request : undefined;
    session.request = undefined;
    const result = await this.connection.requestPermission({
      sessionId: id,
      toolCall: {
        toolCallId: `permission:${text(event.id)}`,
        ...(request
          ? permissionCall(request, text(event.title))
          : {
              title: text(event.title),
              kind: 'other' as const,
              content: [{ type: 'content' as const, content: { type: 'text' as const, text: message } }],
              // The desktop's permission card shows the input's description, not the content: without it, what the
              // harness asks (the command, the action) never reaches the reader.
              ...(message ? { rawInput: { description: message } } : {}),
            }),
      },
      options: confirm
        ? [...CONFIRM_OPTIONS]
        : choices.map((name, i) => ({
            optionId: answerOptionId(request, i),
            name,
            kind: request ? answerKind(i, choices.length) : ('allow_once' as const),
          })),
    });
    // Stopped, or dismissed: no answer is an answer too.
    if (result.outcome.outcome === 'cancelled' || session.cancelled) {
      answer({ cancelled: true });
      return;
    }
    const { optionId } = result.outcome;
    if (confirm) {
      if (optionId === 'allow' || optionId === 'reject') answer({ confirmed: optionId === 'allow' });
      return;
    }
    const index = answerIndex(request, optionId, choices.length);
    if (index >= 0) answer({ value: choices[index] });
  }
  close(): void {
    for (const session of this.sessions.values()) {
      if (session.held) clearTimeout(session.held.timer);
      session.rpc.close();
    }
    this.sessions.clear();
  }
}
