import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  KyrnAgent,
  MU_NOTICES,
  MU_TURN_ERRORS,
  harnessEnv,
  isNoModel,
  readAppLanguage,
  readDefaultModel,
} from '../../../packages/desktop/src/process/agent/kyrn/KyrnAgent.ts';
import type { JsonRecord } from '../../../packages/desktop/src/process/agent/kyrn/piRpc.ts';
import { activityPage, modelLevels } from '../../../packages/desktop/src/process/agent/kyrn/telemetry';

const noop = (): void => {};

const MODES = [
  { id: 'full', label: 'Full access', description: 'Everything runs without asking.' },
  { id: 'jev', label: 'Jev approves', description: 'Jev approves what the task needs.' },
  { id: 'ask', label: 'Minimal permissions', description: 'Reading only; the rest asks.' },
];
/** A presentation event the way mu sends it: JSON on its status channel. */
const shown = (kind: string, payload: JsonRecord): JsonRecord => ({
  type: 'extension_ui_request',
  id: `status-${kind}`,
  method: 'setStatus',
  statusKey: 'kyrn.presentation.v1',
  statusText: JSON.stringify({ version: 1, sequence: 1, at: 0, runtimeId: 'r', turnId: 0, kind, payload }),
});
const modeShown = (mode: string, conversationSwitch = false) =>
  shown('permissions.mode', {
    mode,
    label: MODES.find((each) => each.id === mode)?.label,
    ...(conversationSwitch ? { conversationSwitch: true } : {}),
    modes: MODES,
  });
const tick = () => new Promise((resolve) => setImmediate(resolve));

type FixtureOptions = {
  /** The user's home the bridge reads the app language from; a temporary one. */
  home?: string;
  permission?: (request: RequestPermissionRequest) => RequestPermissionResponse | Promise<RequestPermissionResponse>;
  /** The permission mode mu starts in, announced before its first answer as mu does; unset: mu reports none. */
  mode?: string;
  /** mu understands `/permissions <id> --here` and says so (`conversationSwitch`). */
  here?: boolean;
  /** What pi's `get_commands` answers. */
  commands?: JsonRecord[];
  /** What pi's `get_available_models` answers; unset: a fixture model and the judge's gateway model. */
  models?: JsonRecord[];
  /** The model mu runs on until `set_model`; unset: the fixture model. pi says `unknown/unknown` while it has none. */
  model?: JsonRecord;
  /** pi refuses the next messages with these errors, one each, before it takes one. */
  promptErrors?: string[];
};

/** Error text of a fixture mu that has stopped, as PiRpc's. */
const CLOSED = 'mu process is closed';

function fixture(options: FixtureOptions = {}) {
  const store = mkdtempSync(join(tmpdir(), 'kyrn-acp-'));
  // Never the real home: the bridge reads the app language from `<home>/.mu`.
  const ownHome = options.home ? undefined : mkdtempSync(join(tmpdir(), 'kyrn-home-'));
  const updates: SessionNotification[] = [];
  const commands: JsonRecord[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const responses: JsonRecord[] = [];
  const envs: (Readonly<Record<string, string>> | undefined)[] = [];
  /** The session file each mu process was started on. */
  const files: (string | undefined)[] = [];
  /** How many of the next mu processes fail to start. */
  let failStarts = 0;
  /** Stops the current mu process, as a crash does. */
  let stop: () => void = noop;
  let emit: (event: JsonRecord) => void = noop;
  let finish: () => void = noop;
  let thinking = 'medium';
  let closed = false;
  let tokens: number | null = 0;
  const served: (string | undefined)[] = [];
  let answer = options.permission;
  let mode = options.mode;
  let model = options.model ?? { provider: 'fixture', id: 'model' };
  const promptErrors = [...(options.promptErrors ?? [])];
  /** The mode each mu process was handed (MU_PERMISSIONS). */
  const launched: (string | undefined)[] = [];
  let announced = false;
  const agent = new KyrnAgent(
    {
      sessionUpdate: async (event) => {
        updates.push(event);
      },
      requestPermission: async (request) => {
        permissions.push(request);
        return answer?.(request) ?? { outcome: { outcome: 'cancelled' } };
      },
    },
    'fixture',
    store,
    (_cwd, file, listener, servedSession, env) => {
      emit = listener;
      served.push(servedSession);
      envs.push(env);
      files.push(file);
      const failing = failStarts > 0;
      if (failing) failStarts -= 1;
      let down = false;
      stop = () => {
        down = true;
        listener({ type: 'kyrn_rpc_closed' });
      };
      const handed = env?.MU_PERMISSIONS;
      launched.push(handed);
      // A new mu process announces its mode again; one handed a mode starts in it (no session entry here).
      announced = false;
      if (handed) mode = handed;
      return {
        send: async (command) => {
          if (failing) throw new Error('mu failed to start');
          if (down) throw new Error(CLOSED);
          commands.push(command);
          switch (command.type) {
            case 'get_state':
              if (mode && !announced) {
                announced = true;
                emit(modeShown(mode, options.here));
              }
              return {
                sessionFile: '/fixture/session.jsonl',
                model,
                thinkingLevel: thinking,
                contextUsage: { tokens, contextWindow: 128000 },
                compactionSettings: { enabled: true, maxContextTokens: 64000, reserveTokens: 16000 },
              };
            case 'get_available_models':
              return {
                models: options.models ?? [
                  { provider: 'fixture', id: 'model', name: 'Fixture Model' },
                  { provider: 'vercel-ai-gateway', id: 'openai/gpt-5', name: 'GPT-5' },
                ],
              };
            case 'get_session_stats':
              return { tokens: { input: 100, cacheRead: 800, cacheWrite: 100, output: 200 } };
            case 'get_available_thinking_levels':
              return { levels: ['off', 'medium', 'high'] };
            case 'set_thinking_level':
              thinking = String(command.level);
              return {};
            case 'set_model':
              model = { provider: String(command.provider), id: String(command.modelId) };
              return {};
            case 'get_commands':
              return { commands: options.commands ?? [] };
            case 'get_messages':
              return { messages: [{ role: 'user', content: 'Saved message' }] };
            case 'prompt':
              // mu's command: it announces the new mode, says so, then answers; no turn starts.
              if (mode && String(command.message).startsWith('/permissions ')) {
                const [next, flag] = String(command.message).slice('/permissions '.length).split(' ');
                mode = next;
                emit(modeShown(mode, options.here));
                // A switch for this conversation only says nothing.
                if (flag === '--here' && options.here) return {};
                emit({
                  type: 'extension_ui_request',
                  id: 'n',
                  method: 'notify',
                  message: 'Switched',
                  notifyType: 'info',
                });
                return {};
              }
              if (promptErrors.length) throw new Error(promptErrors.shift());
              emit({ type: 'agent_start' });
              finish = () => emit({ type: 'agent_settled' });
              return {};
            case 'abort':
              finish();
              return {};
            default:
              return {};
          }
        },
        respond: (response) => {
          if (!down) responses.push(response);
        },
        close: () => {
          closed = true;
          down = true;
        },
      };
    },
    options.home ?? ownHome
  );
  return {
    agent,
    updates,
    commands,
    served,
    envs,
    permissions,
    responses,
    store,
    launched,
    files,
    /** mu's process stops, as a crash does: kyrn_rpc_closed, and every command fails from then on. */
    stop: () => stop(),
    /** The next `count` mu processes fail to start. */
    failStarts: (count: number) => {
      failStarts = count;
    },
    /** mu's default changed elsewhere, e.g. in another conversation. */
    setMode: (value: string) => {
      mode = value;
    },
    answer: (value: RequestPermissionResponse | Promise<RequestPermissionResponse>) => {
      answer = () => value;
    },
    /** The app fails to ask (its connection is gone, say). */
    failAsking: () => {
      answer = () => {
        throw new Error('ACP connection closed');
      };
    },
    setTokens: (value: number | null) => {
      tokens = value;
    },
    emit: (e: JsonRecord) => emit(e),
    finish: () => finish(),
    closed: () => closed,
    cleanup: () => {
      agent.close();
      rmSync(store, { recursive: true, force: true });
      if (ownHome) rmSync(ownHome, { recursive: true, force: true });
    },
  };
}

describe('KYRN ACP bridge', () => {
  it('tells each harness process which adapter session it serves, for the app’s browser to find the conversation', async () => {
    const f = fixture();
    try {
      const first = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const second = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      expect(f.served).toEqual([first.sessionId, second.sessionId]);
      expect(first.sessionId).not.toBe(second.sessionId);
    } finally {
      f.cleanup();
    }
  });

  it('refreshes context after completion and never retains the pre-compaction count', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.setTokens(32000);
      f.emit({ type: 'message_end', message: { role: 'assistant', content: [] } });
      await new Promise((resolve) => setImmediate(resolve));
      f.setTokens(null);
      f.emit({ type: 'compaction_end', aborted: false, result: { tokensBefore: 32000, estimatedTokensAfter: 8000 } });
      f.finish();
      await running;
      const snapshots = activityPage(f.store, sessionId, 0).events.filter((e) => e.kind === 'context.usage');
      expect(snapshots.some((e) => (e.payload.usage as JsonRecord).tokens === 32000)).toBe(true);
      expect(snapshots.at(-1)?.payload.usage).toMatchObject({ tokens: null, contextWindow: 128000 });
      expect(snapshots.at(-1)?.payload.sessionTokens).toMatchObject({ cacheRead: 800, input: 100 });
    } finally {
      f.cleanup();
    }
  });
  it('streams exposed thinking, fills final-only thinking and never repeats deltas', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: 'Inspect' } });
      f.emit({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspect the test', thinkingSignature: 'private-signature' },
            { type: 'thinking', redacted: true, thinking: 'redacted-placeholder' },
            { type: 'text', text: 'Result' },
          ],
        },
      });
      f.finish();
      await running;
      const thought = f.updates.filter((e) => e.update.sessionUpdate === 'agent_thought_chunk');
      expect(thought.map((e) => ('content' in e.update ? e.update.content : null))).toEqual([
        { type: 'text', text: 'Inspect' },
        { type: 'text', text: ' the test' },
      ]);
      expect(JSON.stringify(f.updates)).not.toContain('private-signature');
      expect(JSON.stringify(f.updates)).not.toContain('redacted-placeholder');
    } finally {
      f.cleanup();
    }
  });
  it('passes image attachments to pi without fetching remote image URLs', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({
        sessionId,
        prompt: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      });
      f.finish();
      await running;
      expect(f.commands.find((c) => c.type === 'prompt')?.images).toEqual([
        { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
      ]);
      await expect(
        f.agent.prompt({ sessionId, prompt: [{ type: 'image', data: 'x', mimeType: 'image/svg+xml' }] })
      ).rejects.toThrow('Unsupported image');
    } finally {
      f.cleanup();
    }
  });
  it('does not finish an ACP prompt when pi only acknowledges preflight', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      let completed = false;
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] }).then(() => {
        completed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(completed).toBe(false);
      f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Answer' }] } });
      f.finish();
      await running;
      expect(completed).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it('delivers final-only provider text and does not duplicate streamed text', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Final only' }] } });
      f.emit({ type: 'message_start', message: { role: 'assistant' } });
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Streamed' } });
      f.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Streamed' }] } });
      f.finish();
      await running;
      expect(
        f.updates
          .filter((e) => e.update.sessionUpdate === 'agent_message_chunk')
          .map((e) => ('content' in e.update ? e.update.content : null))
      ).toEqual([
        { type: 'text', text: 'Final only' },
        { type: 'text', text: 'Streamed' },
      ]);
    } finally {
      f.cleanup();
    }
  });
  it('says once, in a line of its own, that Git for Windows is missing, instead of pi’s error', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      // pi's words when it finds no bash on Windows (getShellConfig), for a bash call and for a background one.
      const noBash =
        'No bash shell found. Options:\n  1. Install Git for Windows: https://git-scm.com/download/win\n' +
        '  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n  3. Set shellPath in settings.json\n\n' +
        'Searched Git Bash in:\n  C:\\Program Files\\Git\\bin\\bash.exe';
      for (const [toolCallId, toolName] of [
        ['call-1', 'bash'],
        ['call-2', 'bg_start'],
      ]) {
        f.emit({ type: 'tool_execution_start', toolCallId, toolName, args: { command: 'ls' } });
        f.emit({
          type: 'tool_execution_end',
          toolCallId,
          toolName,
          isError: true,
          result: { content: [{ type: 'text', text: noBash }], details: {} },
        });
      }
      // Any other failure keeps its words.
      f.emit({ type: 'tool_execution_start', toolCallId: 'call-3', toolName: 'bash', args: { command: 'false' } });
      f.emit({
        type: 'tool_execution_end',
        toolCallId: 'call-3',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'Command exited with code 1' }] },
      });
      f.finish();
      await running;
      const seen = f.updates.map((each) => each.update);
      expect(JSON.stringify(seen)).not.toContain('No bash shell found');
      const notices = seen.filter(
        (update) => update.sessionUpdate === 'tool_call' && update.toolCallId.startsWith('mu:notice:')
      );
      expect(notices).toEqual([
        expect.objectContaining({
          title: MU_NOTICES.bash_missing,
          status: 'completed',
          rawInput: { notice: 'bash_missing' },
        }),
      ]);
      // The line comes right after the call that failed.
      const failed = seen.findIndex(
        (update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'call-1'
      );
      expect(seen[failed]).toMatchObject({ status: 'failed', content: [], rawOutput: { notice: 'bash_missing' } });
      expect(seen[failed + 1]).toBe(notices[0]);
      expect(
        seen.find((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'call-3')
      ).toMatchObject({
        status: 'failed',
        content: [{ type: 'content', content: { type: 'text', text: 'Command exited with code 1' } }],
      });
    } finally {
      f.cleanup();
    }
  });
  it('exposes real model and reasoning options and confirms changes', async () => {
    const f = fixture();
    try {
      const session = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      expect(session.configOptions?.[0].type).toBe('select');
      // The judge's gateway key makes pi list the Vercel AI Gateway; nobody picked it, so it is not offered.
      expect(session.configOptions?.[0]).toMatchObject({
        options: [{ value: 'fixture/model', name: 'Fixture Model', description: 'fixture' }],
      });
      const changed = await f.agent.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'thinking',
        value: 'high',
      });
      expect(changed.configOptions?.[1]).toMatchObject({ currentValue: 'high' });
      await expect(
        f.agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'model', value: 'fake/unknown' })
      ).rejects.toThrow('Unsupported');
    } finally {
      f.cleanup();
    }
  });
  it('records the thinking levels each offered model takes, by pi’s rule, for the send box’s picker', async () => {
    const f = fixture({
      models: [
        {
          provider: 'fixture',
          id: 'model',
          name: 'Fixture Model',
          reasoning: true,
          thinkingLevelMap: { minimal: null, xhigh: 'max-effort' },
        },
        { provider: 'fixture', id: 'plain', name: 'No Reasoning' },
        { provider: 'vercel-ai-gateway', id: 'openai/gpt-5', name: 'GPT-5', reasoning: true },
      ],
    });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      // Only what the picker offers: the gateway nobody picked is left out, as it is from the model list.
      expect(modelLevels(f.store, sessionId)).toEqual({
        'fixture/model': ['off', 'low', 'medium', 'high', 'xhigh'],
        'fixture/plain': ['off'],
      });
    } finally {
      f.cleanup();
    }
  });
  it('offers no permission picker while mu reports no modes', async () => {
    const f = fixture();
    try {
      const session = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      expect(session.configOptions?.some((option) => option.id === 'mode')).toBe(false);
      await expect(
        f.agent.setSessionConfigOption({ sessionId: session.sessionId, configId: 'mode', value: 'full' })
      ).rejects.toThrow('Unsupported');
    } finally {
      f.cleanup();
    }
  });
  it('puts mu’s permission modes in the send box and switches them with mu’s own command', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      const { sessionId, configOptions } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      expect(configOptions?.find((option) => option.id === 'mode')).toEqual({
        id: 'mode',
        category: 'mode',
        name: 'Permissions',
        type: 'select',
        currentValue: 'jev',
        options: MODES.map(({ id, label, description }) => ({ value: id, name: label, description })),
      });
      const changed = await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'ask' });
      expect(f.commands.filter((command) => command.type === 'prompt')).toEqual([
        { type: 'prompt', message: '/permissions ask' },
      ]);
      expect(changed.configOptions?.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'ask' });
      await tick();
      // The picker hears of it; mu's "switched" note is not shown as a reply.
      expect(f.updates.map((each) => each.update)).toContainEqual(
        expect.objectContaining({ sessionUpdate: 'config_option_update' })
      );
      expect(f.updates.some((each) => each.update.sessionUpdate === 'agent_message_chunk')).toBe(false);
      // The app sets the mode it remembers when it opens a conversation: the same mode again sends nothing.
      await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'ask' });
      await expect(f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'default' })).rejects.toThrow(
        'Unsupported'
      );
      expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it('switches this conversation only when mu can, so the default for new ones stays the settings’', async () => {
    const f = fixture({ mode: 'jev', here: true });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const changed = await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'full' });
      expect(changed.configOptions?.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'full' });
      expect(f.commands.filter((command) => command.type === 'prompt')).toEqual([
        { type: 'prompt', message: '/permissions full --here' },
      ]);
      await tick();
      expect(f.updates.some((each) => each.update.sessionUpdate === 'agent_message_chunk')).toBe(false);
    } finally {
      f.cleanup();
    }
  });
  it('switches permissions during a turn, and follows a switch typed in the conversation', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      await tick();
      const changed = await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'full' });
      expect(changed.configOptions?.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'full' });
      // The model still waits for the turn.
      await expect(f.agent.setSessionConfigOption({ sessionId, configId: 'thinking', value: 'high' })).rejects.toThrow(
        'Wait'
      );
      f.finish();
      await running;
      // `/permissions ask` typed by the user: mu announces the mode, and the picker follows.
      f.emit(modeShown('ask'));
      await tick();
      await tick();
      const last = f.updates.findLast((each) => each.update.sessionUpdate === 'config_option_update');
      expect(last?.update).toMatchObject({
        configOptions: expect.arrayContaining([expect.objectContaining({ id: 'mode', currentValue: 'ask' })]),
      });
    } finally {
      f.cleanup();
    }
  });
  it('reopens a conversation in the mode it was last in, so the app setting it again switches nothing', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'ask' });
      await tick();
      expect(JSON.parse(readFileSync(join(f.store, `${sessionId}.json`), 'utf8'))).toMatchObject({
        permissions: 'ask',
      });
      f.agent.close();
      f.setMode('full');
      const { configOptions } = await f.agent.loadSession({ sessionId, cwd: tmpdir(), mcpServers: [] });
      expect(f.launched).toEqual([undefined, 'ask']);
      expect(configOptions?.find((option) => option.id === 'mode')).toMatchObject({ currentValue: 'ask' });
      // AionCore sets the mode it last saw when it reopens a conversation: the same one, so no command.
      await f.agent.setSessionConfigOption({ sessionId, configId: 'mode', value: 'ask' });
      expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it('shows mu’s permission question as a card whose buttons say what each answer does', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const answers = ['Allow once', 'Allow for this conversation（npm test）', 'Don’t allow'];
      f.answer({ outcome: { outcome: 'selected', optionId: '1' } });
      f.emit(
        shown('permissions.request', {
          id: 'permission-1',
          mode: 'jev',
          tool: 'bash',
          kind: 'shell',
          summary: 'npm test\n  -- --watch=false',
          reason: 'unsure',
          grant: { key: 'shell:npm test', label: 'npm test' },
          answers,
        })
      );
      f.emit({
        type: 'extension_ui_request',
        id: 'ui-1',
        method: 'select',
        title: 'mu wants to run a command\nnpm test\n  -- --watch=false\nJev is not sure this step is what you want.',
        options: answers,
      });
      await tick();
      expect(f.permissions[0].toolCall).toMatchObject({
        toolCallId: 'permission:ui-1',
        title: 'mu wants to run a command',
        kind: 'execute',
        rawInput: {
          command: 'npm test\n  -- --watch=false',
          description: 'Jev is not sure this step is what you want.',
        },
      });
      expect(f.permissions[0].options.map((option) => option.kind)).toEqual([
        'allow_once',
        'allow_always',
        'reject_once',
      ]);
      expect(f.responses).toEqual([{ id: 'ui-1', value: answers[1] }]);
      // Any other picker (here, mu's own list of modes) keeps the plain shape.
      f.emit({
        type: 'extension_ui_request',
        id: 'ui-2',
        method: 'select',
        title: 'Permission mode',
        options: ['a', 'b'],
      });
      await tick();
      expect(f.permissions[1].toolCall).toMatchObject({ title: 'Permission mode', kind: 'other' });
      expect(f.permissions[1].options.map((option) => option.kind)).toEqual(['allow_once', 'allow_once']);
    } finally {
      f.cleanup();
    }
  });
  it('gives the card mu’s codes and its answers by id, so the desktop words them in any language', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const answers = ['允许这一次', '这次对话都允许（git push）', '不允许'];
      const ask = (id: string, optionId: string) => {
        f.answer({ outcome: { outcome: 'selected', optionId } });
        f.emit(
          shown('permissions.request', {
            id: `permission-${id}`,
            mode: 'jev',
            tool: 'bash',
            kind: 'shell',
            summary: 'git push --force',
            reason: 'flagged',
            flag: 'force push',
            flagCode: 'force_push',
            grant: { key: 'shell:git push', label: 'git push' },
            answers,
            answerIds: ['once', 'session', 'deny'],
          })
        );
        f.emit({
          type: 'extension_ui_request',
          id,
          method: 'select',
          title: 'mu 想运行命令，需要你授权\ngit push --force\n危险操作：强制推送。',
          options: answers,
        });
      };
      ask('ui-1', 'mu:session');
      await tick();
      expect(f.permissions[0].toolCall.rawInput).toEqual({
        command: 'git push --force',
        description: '危险操作：强制推送。',
        mu: { kind: 'shell', reason: 'flagged', flagCode: 'force_push', grantLabel: 'git push' },
      });
      expect(f.permissions[0].options).toEqual([
        { optionId: 'mu:once', name: answers[0], kind: 'allow_once' },
        { optionId: 'mu:session', name: answers[1], kind: 'allow_always' },
        { optionId: 'mu:deny', name: answers[2], kind: 'reject_once' },
      ]);
      // The answer goes back to mu as its own text; a position or an unknown id is no answer.
      ask('ui-2', '1');
      await tick();
      ask('ui-3', 'mu:always');
      await tick();
      expect(f.responses).toEqual([
        { id: 'ui-1', value: answers[1] },
        { id: 'ui-2', cancelled: true },
        { id: 'ui-3', cancelled: true },
      ]);
    } finally {
      f.cleanup();
    }
  });
  it('offers mu’s slash commands to the send box once the session is answered, and again when it is reopened', async () => {
    const f = fixture({
      commands: [
        { name: 'permissions', description: 'How much mu may do without asking\nmore', source: 'extension' },
        { name: 'skill:review', description: '', source: 'skill' },
        { name: 'two words', description: 'not a command name' },
        { name: 'clear', description: 'Start a fresh conversation (same as /new)', source: 'extension' },
        { name: 'permissions', description: 'a second one' },
      ],
    });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const offered = () => f.updates.filter((each) => each.update.sessionUpdate === 'available_commands_update');
      await vi.waitFor(() => expect(offered()).toHaveLength(1));
      expect(offered()[0]).toMatchObject({
        sessionId,
        update: {
          availableCommands: [
            { name: 'permissions', description: 'How much mu may do without asking' },
            { name: 'skill:review', description: 'skill:review' },
          ],
        },
      });
      f.agent.close();
      await f.agent.loadSession({ sessionId, cwd: tmpdir(), mcpServers: [] });
      await vi.waitFor(() => expect(offered()).toHaveLength(2));
    } finally {
      f.cleanup();
    }
  });
  it('streams before completion, rejects overlapping prompts and cancels the running turn', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const params = { sessionId, prompt: [{ type: 'text' as const, text: 'Test' }] };
      const running = f.agent.prompt(params);
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Live' } });
      await expect(f.agent.prompt(params)).rejects.toThrow('already running');
      await f.agent.cancel({ sessionId });
      expect(await running).toEqual({ stopReason: 'cancelled' });
      expect(f.updates.at(-2)?.update).toMatchObject({
        sessionUpdate: 'agent_message_chunk',
        content: { text: 'Live' },
      });
      // A stopped reply would read as a finished one: the line after it says it was stopped.
      expect(f.updates.at(-1)?.update).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: expect.stringMatching(/^mu:notice:/),
        title: MU_NOTICES.stopped,
        status: 'completed',
        rawInput: { notice: 'stopped' },
      });
      // A reply that ends by itself says nothing of the kind.
      const next = f.agent.prompt(params);
      await tick();
      f.finish();
      expect(await next).toEqual({ stopReason: 'end_turn' });
      expect(f.updates.filter((each) => JSON.stringify(each.update).includes('"stopped"'))).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });
  it('reloads saved messages and rejects malformed session ids', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      await f.agent.loadSession({ sessionId, cwd: tmpdir(), mcpServers: [] });
      expect(f.updates.at(-1)?.update).toMatchObject({ sessionUpdate: 'user_message_chunk' });
      await expect(f.agent.loadSession({ sessionId: '../../outside', cwd: tmpdir(), mcpServers: [] })).rejects.toThrow(
        'Invalid'
      );
      f.agent.close();
      expect(f.closed()).toBe(true);
    } finally {
      f.cleanup();
    }
  });
  it('tells every new harness process the app language, read again at each start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'kyrn-home-'));
    const f = fixture({ home });
    try {
      const muHome = join(home, '.mu');
      mkdirSync(muHome, { recursive: true });
      writeFileSync(join(muHome, 'app-language'), 'zh-CN\n');
      const first = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      writeFileSync(join(muHome, 'app-language'), 'en-US\n');
      const second = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      rmSync(join(muHome, 'app-language'));
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      expect(f.envs).toEqual([
        { MU_DESKTOP_SESSION: first.sessionId, MU_LANG: 'zh-CN' },
        { MU_DESKTOP_SESSION: second.sessionId, MU_LANG: 'en-US' },
        { MU_DESKTOP_SESSION: expect.any(String) },
      ]);
    } finally {
      f.cleanup();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('reads the app language from the legacy home and ignores an empty or missing file', () => {
    const home = mkdtempSync(join(tmpdir(), 'kyrn-home-'));
    try {
      expect(readAppLanguage(home)).toBeUndefined();
      mkdirSync(join(home, '.kyrn'), { recursive: true });
      writeFileSync(join(home, '.kyrn', 'app-language'), '  \n');
      expect(readAppLanguage(home)).toBeUndefined();
      writeFileSync(join(home, '.kyrn', 'app-language'), 'ja-JP\n');
      expect(readAppLanguage(home)).toBe('ja-JP');
      expect(harnessEnv(undefined, home)).toEqual({ MU_LANG: 'ja-JP' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('sends a harness confirmation with stable allow and reject answers the desktop can name', async () => {
    const f = fixture({ permission: () => ({ outcome: { outcome: 'selected', optionId: 'reject' } }) });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      f.emit({
        type: 'extension_ui_request',
        id: 'c1',
        method: 'confirm',
        title: 'mu: rm',
        message: 'Run rm -rf build?',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.permissions[0]).toMatchObject({
        sessionId,
        toolCall: { toolCallId: 'permission:c1', title: 'mu: rm', rawInput: { description: 'Run rm -rf build?' } },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      expect(f.responses).toEqual([{ id: 'c1', confirmed: false }]);
    } finally {
      f.cleanup();
    }
  });

  it('answers a harness choice with the choice itself and cancels an unknown answer', async () => {
    const answers = ['1', 'allow'];
    const f = fixture({
      permission: () => ({ outcome: { outcome: 'selected', optionId: answers.shift() ?? 'x' } }),
    });
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const select = { type: 'extension_ui_request', method: 'select', title: 'Pick', options: ['Keep', 'Drop'] };
      f.emit({ ...select, id: 's1' });
      await new Promise((resolve) => setImmediate(resolve));
      f.emit({ ...select, id: 's2' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(f.permissions[0].options).toEqual([
        { optionId: '0', name: 'Keep', kind: 'allow_once' },
        { optionId: '1', name: 'Drop', kind: 'allow_once' },
      ]);
      expect(f.responses).toEqual([
        { id: 's1', value: 'Drop' },
        { id: 's2', cancelled: true },
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('fails a turn whose mu stopped with the error the desktop explains, and starts mu again for the next message', async () => {
    const f = fixture({ mode: 'ask' });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      await vi.waitFor(() => expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1));
      f.stop();
      await expect(running).rejects.toThrow(MU_TURN_ERRORS.processExited);
      // Stopping what no longer runs is no error.
      await expect(f.agent.cancel({ sessionId })).resolves.toBeUndefined();
      // The next message: a new mu on the same session file, in the mode the conversation was in.
      const next = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Again' }] });
      await vi.waitFor(() => expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(2));
      f.finish();
      await expect(next).resolves.toEqual({ stopReason: 'end_turn' });
      expect(f.files).toEqual([undefined, '/fixture/session.jsonl']);
      expect(f.launched).toEqual([undefined, 'ask']);
    } finally {
      f.cleanup();
    }
  });

  it('ends a call mu started and never ended as failed when mu stops mid-call, so no row stays running', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Look into it' }] });
      await vi.waitFor(() => expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1));
      f.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } });
      f.emit({ type: 'tool_execution_end', toolCallId: 'read-1', result: { content: [] }, isError: false });
      // A hive at work when mu's process closes: its call never ends.
      f.emit({ type: 'tool_execution_start', toolCallId: 'hive-1', toolName: 'hive', args: { question: 'Why?' } });
      f.stop();
      await expect(running).rejects.toThrow(MU_TURN_ERRORS.processExited);
      const ends = f.updates.map((each) => each.update).filter((update) => update.sessionUpdate === 'tool_call_update');
      expect(ends).toEqual([
        expect.objectContaining({ toolCallId: 'read-1', status: 'completed' }),
        { sessionUpdate: 'tool_call_update', toolCallId: 'hive-1', status: 'failed' },
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('adds nothing to a turn whose calls all ended', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Read it' }] });
      await vi.waitFor(() => expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1));
      f.emit({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'a.ts' } });
      f.emit({ type: 'tool_execution_end', toolCallId: 'read-1', result: { content: [] }, isError: true });
      f.finish();
      await expect(running).resolves.toEqual({ stopReason: 'end_turn' });
      const ends = f.updates.map((each) => each.update).filter((update) => update.sessionUpdate === 'tool_call_update');
      expect(ends).toEqual([
        expect.objectContaining({ toolCallId: 'read-1', status: 'failed', rawOutput: { content: [] } }),
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('goes on after mu stopped between turns: a setting or a message starts it again, with no error', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      f.stop();
      const changed = await f.agent.setSessionConfigOption({ sessionId, configId: 'thinking', value: 'high' });
      expect(changed.configOptions?.[1]).toMatchObject({ currentValue: 'high' });
      expect(f.files).toEqual([undefined, '/fixture/session.jsonl']);
      // The send box hears the new process's options.
      await vi.waitFor(() =>
        expect(f.updates.some((each) => each.update.sessionUpdate === 'config_option_update')).toBe(true)
      );
    } finally {
      f.cleanup();
    }
  });

  it('keeps a conversation whose new mu did not start, and tries again on the next call', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      f.stop();
      f.failStarts(1);
      await expect(f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] })).rejects.toThrow(
        'mu failed to start'
      );
      const next = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Again' }] });
      await vi.waitFor(() => expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1));
      f.finish();
      await expect(next).resolves.toEqual({ stopReason: 'end_turn' });
      expect(f.files).toEqual([undefined, '/fixture/session.jsonl', '/fixture/session.jsonl']);
    } finally {
      f.cleanup();
    }
  });

  it('answers mu exactly once, and says so in the conversation when the app could not ask or no choice came back', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const answers = ['允许这一次', '不允许'];
      const ask = (id: string) => {
        f.emit(
          shown('permissions.request', {
            id: `permission-${id}`,
            mode: 'jev',
            tool: 'bash',
            kind: 'shell',
            summary: 'rm -rf build',
            reason: 'flagged',
            flag: 'recursive or forced delete',
            flagCode: 'recursive_or_forced_delete',
            answers,
            answerIds: ['once', 'deny'],
          })
        );
        f.emit({ type: 'extension_ui_request', id, method: 'select', title: 'mu 想运行命令', options: answers });
      };
      const notices = () =>
        f.updates.filter(
          (each) => each.update.sessionUpdate === 'tool_call' && each.update.toolCallId.startsWith('mu:notice:')
        );
      // The app could not ask: mu hears "no" and the conversation says why.
      f.failAsking();
      ask('ui-1');
      // An answer that is none of the choices.
      await tick();
      f.answer({ outcome: { outcome: 'selected', optionId: 'mu:always' } });
      ask('ui-2');
      await tick();
      // A choice, and a dismissal: answered as given, nothing to say.
      f.answer({ outcome: { outcome: 'selected', optionId: 'mu:once' } });
      ask('ui-3');
      await tick();
      f.answer({ outcome: { outcome: 'cancelled' } });
      ask('ui-4');
      await vi.waitFor(() => expect(f.responses).toHaveLength(4));
      expect(f.responses).toEqual([
        { id: 'ui-1', cancelled: true },
        { id: 'ui-2', cancelled: true },
        { id: 'ui-3', value: answers[0] },
        { id: 'ui-4', cancelled: true },
      ]);
      await vi.waitFor(() => expect(notices()).toHaveLength(2));
      expect(notices()[0]).toMatchObject({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          title: MU_NOTICES.answer_lost,
          status: 'completed',
          rawInput: { notice: 'answer_lost' },
        },
      });
    } finally {
      f.cleanup();
    }
  });

  it('lets an answer to a mu that stopped meanwhile go nowhere, with nothing else to say', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      let release: (value: RequestPermissionResponse) => void = noop;
      f.answer(
        new Promise<RequestPermissionResponse>((resolve) => {
          release = resolve;
        })
      );
      f.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'select', title: 'Pick', options: ['Keep', 'Drop'] });
      await tick();
      f.stop();
      release({ outcome: { outcome: 'selected', optionId: '0' } });
      await tick();
      await tick();
      expect(f.responses).toEqual([]);
      expect(f.updates.some((each) => JSON.stringify(each.update).includes('mu:notice:'))).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it('raises a failed model request under a fixed headline with the provider text after it', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.emit({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: '429 rate limited' },
      });
      f.finish();
      await expect(running).rejects.toThrow(`${MU_TURN_ERRORS.modelFailed}: 429 rate limited`);
    } finally {
      f.cleanup();
    }
  });
});

/** pi's words when a prompt has no model with a key, help for a terminal user included. */
const NO_KEY =
  'No API key found for anthropic.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /opt/mu/docs/providers.md';

describe('a conversation without a model', () => {
  it('reads pi’s placeholder, a missing model and a named one', () => {
    expect(isNoModel({ provider: 'unknown', id: 'unknown' })).toBe(true);
    expect(isNoModel(undefined)).toBe(true);
    expect(isNoModel({ provider: 'anthropic' })).toBe(true);
    expect(isNoModel({ provider: 'fixture', id: 'model' })).toBe(false);
  });

  it('reads the model new sessions start on from the agent folder’s settings, and nothing from a missing file', () => {
    vi.stubEnv('MU_AGENT_DIR', '');
    vi.stubEnv('KYRN_AGENT_DIR', '');
    const home = mkdtempSync(join(tmpdir(), 'kyrn-home-'));
    try {
      expect(readDefaultModel(home)).toBeUndefined();
      mkdirSync(join(home, '.mu', 'agent'), { recursive: true });
      writeFileSync(join(home, '.mu', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 'fixture' }));
      expect(readDefaultModel(home)).toBeUndefined();
      writeFileSync(
        join(home, '.mu', 'agent', 'settings.json'),
        JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'second' })
      );
      expect(readDefaultModel(home)).toEqual({ provider: 'fixture', id: 'second' });
    } finally {
      rmSync(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('takes the model new sessions start on once pi lists it, and the send box hears of it', async () => {
    // Started while another mu held the model store, pi found no model and runs on its placeholder.
    vi.stubEnv('MU_AGENT_DIR', '');
    vi.stubEnv('KYRN_AGENT_DIR', '');
    const home = mkdtempSync(join(tmpdir(), 'kyrn-home-'));
    mkdirSync(join(home, '.mu', 'agent'), { recursive: true });
    writeFileSync(
      join(home, '.mu', 'agent', 'settings.json'),
      JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'second' })
    );
    const f = fixture({
      home,
      model: { provider: 'unknown', id: 'unknown' },
      models: [
        { provider: 'fixture', id: 'model', name: 'Fixture Model' },
        { provider: 'fixture', id: 'second', name: 'Second Model' },
      ],
    });
    try {
      const { sessionId, configOptions } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      // The placeholder is no model the send box could name.
      expect(configOptions?.find((option) => option.id === 'model')).toMatchObject({ currentValue: '' });
      await vi.waitFor(() =>
        expect(f.commands).toContainEqual({ type: 'set_model', provider: 'fixture', modelId: 'second' })
      );
      await vi.waitFor(() =>
        expect(
          f.updates.findLast((each) => each.update.sessionUpdate === 'config_option_update')?.update
        ).toMatchObject({
          configOptions: expect.arrayContaining([
            expect.objectContaining({ id: 'model', currentValue: 'fixture/second' }),
          ]),
        })
      );
      // A message goes to mu at once now, and looks for no model.
      const looks = f.commands.filter((command) => command.type === 'get_available_models').length;
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      await tick();
      f.finish();
      await expect(running).resolves.toEqual({ stopReason: 'end_turn' });
      expect(f.commands.filter((command) => command.type === 'get_available_models')).toHaveLength(looks);
    } finally {
      f.cleanup();
      rmSync(home, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });

  it('fails a message sent with no model at all under its own headline, without pi’s /login help', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const f = fixture({ model: { provider: 'unknown', id: 'unknown' }, models: [], promptErrors: [NO_KEY] });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      const failed = expect(running).rejects.toThrow(
        new Error(`${MU_TURN_ERRORS.noModel}: No API key found for anthropic.`)
      );
      // The conversation looked for a model for a while before the message went.
      await vi.advanceTimersByTimeAsync(10_000);
      await failed;
      expect(f.commands.filter((command) => command.type === 'prompt')).toHaveLength(1);
      expect(f.commands.filter((command) => command.type === 'get_available_models').length).toBeGreaterThan(1);
      expect(f.commands.some((command) => command.type === 'set_model')).toBe(false);
    } finally {
      vi.useRealTimers();
      f.cleanup();
    }
  });

  it('fails a reply whose model had no key the same way, not as a failed request', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.emit({
        type: 'message_end',
        message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: NO_KEY },
      });
      f.finish();
      await expect(running).rejects.toThrow(new Error(`${MU_TURN_ERRORS.noModel}: No API key found for anthropic.`));
    } finally {
      f.cleanup();
    }
  });

  it('sends a message again when another mu held the model store, and fails it when that goes on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const locked = 'Lock file is already being held';
    const f = fixture({ promptErrors: [locked, locked, locked, locked] });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const prompts = () => f.commands.filter((command) => command.type === 'prompt');
      const once = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      const failed = expect(once).rejects.toThrow(locked);
      await vi.advanceTimersByTimeAsync(5_000);
      await failed;
      // The first try and two more.
      expect(prompts()).toHaveLength(3);
      const again = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Again' }] });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(prompts()).toHaveLength(5);
      f.finish();
      await expect(again).resolves.toEqual({ stopReason: 'end_turn' });
    } finally {
      vi.useRealTimers();
      f.cleanup();
    }
  });
});

/** The notices the bridge added to the conversation, in their order. */
const noticesOf = (updates: SessionNotification[]) =>
  updates
    .map((each) => each.update)
    .filter((update) => update.sessionUpdate === 'tool_call' && update.toolCallId.startsWith('mu:notice:'));
/** mu notifies something, as its RPC event does. */
const notify = (f: ReturnType<typeof fixture>, message: string, notifyType: string) =>
  f.emit({ type: 'extension_ui_request', id: `notify-${message}`, method: 'notify', message, notifyType });

describe('what mu notifies', () => {
  it('is a line of its own, never reply text: an answer each time, a warning or an error once', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      notify(f, 'Permissions: full access', 'info');
      notify(f, 'Permissions: full access', 'info');
      notify(f, 'mu could not save a checkpoint.', 'warning');
      f.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Answer' } });
      notify(f, 'mu could not save a checkpoint.', 'warning');
      notify(f, 'The judge is not reachable.', 'error');
      f.finish();
      await running;
      const seen = f.updates.map((each) => each.update);
      expect(noticesOf(f.updates).map((update) => [update.title, update.rawInput])).toEqual([
        ['Permissions: full access', { level: 'info' }],
        ['Permissions: full access', { level: 'info' }],
        ['mu could not save a checkpoint.', { level: 'warning' }],
        ['The judge is not reachable.', { level: 'error' }],
      ]);
      // The reply is only the model's own text, after the warning that came before it.
      const chunks = seen.filter((update) => update.sessionUpdate === 'agent_message_chunk');
      expect(chunks.map((update) => ('content' in update ? update.content : null))).toEqual([
        { type: 'text', text: 'Answer' },
      ]);
      expect(seen.indexOf(noticesOf(f.updates)[2])).toBeLessThan(seen.indexOf(chunks[0]));
    } finally {
      f.cleanup();
    }
  });

  it('says once that checkpoints are off, by mu’s code and the numbers it names, and not again in mu’s words', async () => {
    const f = fixture();
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const words = 'mu: checkpoints are off, because this folder has more than 5000 files to snapshot.';
      // mu's plain warning comes first, and its coded event right after says the same.
      notify(f, words, 'warning');
      f.emit(
        shown('checkpoint.off', { code: 'too_many_files', params: { limit: 5000, folder: '/Users/x' }, message: words })
      );
      // A second report, in either order, says nothing new.
      f.emit(shown('checkpoint.off', { code: 'too_many_files', params: { limit: 5000 }, message: words }));
      notify(f, words, 'warning');
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(noticesOf(f.updates)).toEqual([
        expect.objectContaining({
          title: words,
          status: 'completed',
          rawInput: { notice: 'checkpoint_off', code: 'too_many_files', params: { limit: 5000 } },
        }),
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('says the reasons without numbers with empty params, and a warning with other words as it is', async () => {
    const f = fixture();
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const words = 'mu: checkpoints are off, because git cannot run on this Mac until the Xcode license is accepted.';
      f.emit(shown('checkpoint.off', { code: 'xcode_license', params: {}, message: words }));
      notify(f, 'mu could not reach the judge.', 'warning');
      await vi.waitFor(() => expect(noticesOf(f.updates)).toHaveLength(2));
      expect(noticesOf(f.updates).map((update) => update.rawInput)).toEqual([
        { notice: 'checkpoint_off', code: 'xcode_license', params: {} },
        { level: 'warning' },
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('says the free Jev’s notices by code, once each, and not again in mu’s words', async () => {
    const f = fixture();
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const free = 'mu: no Jev key is set, so the judge uses Jev 1.13 on OpenCode Zen, free for a limited time.';
      const paid = 'mu: the free Jev on OpenCode Zen now asks for a key or payment, so plain rules decide for now.';
      // mu's coded event comes first, its own line right after.
      f.emit(shown('judge.notice', { code: 'free_jev', message: free }));
      notify(f, free, 'info');
      f.emit(shown('judge.notice', { code: 'free_jev_unavailable', reason: 'paid', message: paid }));
      notify(f, paid, 'warning');
      f.emit(shown('judge.notice', { code: 'free_jev_unavailable', reason: 'gone', message: 'again' }));
      // A code this build does not know leaves mu's line to say it.
      f.emit(shown('judge.notice', { code: 'newer', message: 'Something newer.' }));
      notify(f, 'Something newer.', 'info');
      await vi.waitFor(() => expect(noticesOf(f.updates)).toHaveLength(3));
      expect(noticesOf(f.updates).map((update) => [update.title, update.rawInput])).toEqual([
        [free, { notice: 'free_jev' }],
        [paid, { notice: 'free_jev_unavailable', code: 'paid' }],
        ['Something newer.', { level: 'info' }],
      ]);
    } finally {
      f.cleanup();
    }
  });
});

const asRecordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** mu asks about a call, as it does before its picker opens. */
const ask = (f: ReturnType<typeof fixture>, toolCallId: string, reason: string) => {
  const answers = ['Allow once', 'Don’t allow'];
  f.emit(
    shown('permissions.request', {
      id: `permission-${toolCallId}`,
      toolCallId,
      mode: 'jev',
      tool: 'bash',
      kind: 'shell',
      summary: 'rm -rf build',
      reason,
      answers,
      answerIds: ['once', 'deny'],
    })
  );
  f.emit({
    type: 'extension_ui_request',
    id: `ui-${toolCallId}`,
    method: 'select',
    title: 'mu wants to run a command\nrm -rf build',
    options: answers,
  });
};
/** mu runs a call that fails with these words. */
const run = (f: ReturnType<typeof fixture>, toolCallId: string, text: string) => {
  f.emit({ type: 'tool_execution_start', toolCallId, toolName: 'bash', args: { command: 'rm -rf build' } });
  f.emit({
    type: 'tool_execution_end',
    toolCallId,
    toolName: 'bash',
    isError: true,
    result: { content: [{ type: 'text', text }] },
  });
};
/** How the row of a call ended. */
const ended = (f: ReturnType<typeof fixture>, toolCallId: string) =>
  f.updates
    .map((each) => each.update)
    .find((update) => update.sessionUpdate === 'tool_call_update' && update.toolCallId === toolCallId);

describe('answers to mu’s permission questions', () => {
  it('gives the card the call it asks about, and a reason the judge left open', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      ask(f, 'call-1', 'nojudge');
      await tick();
      ask(f, 'call-2', 'judgedown');
      await tick();
      expect(f.permissions.map((request) => request.toolCall.rawInput)).toEqual([
        expect.objectContaining({ mu: { kind: 'shell', reason: 'nojudge', toolCallId: 'call-1' } }),
        expect.objectContaining({ mu: { kind: 'shell', reason: 'judgedown', toolCallId: 'call-2' } }),
      ]);
    } finally {
      f.cleanup();
    }
  });

  it('marks the row of a call the person did not allow, and only that one', async () => {
    const f = fixture({ mode: 'jev' });
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      ask(f, 'call-1', 'flagged');
      await tick();
      f.emit(shown('permissions.resolved', { id: 'permission-call-1', toolCallId: 'call-1', answer: 'deny' }));
      run(f, 'call-1', 'The user did not allow this (rm -rf build).');
      // A call allowed once that then failed by itself, and one that failed with no question at all.
      ask(f, 'call-2', 'flagged');
      await tick();
      f.emit(shown('permissions.resolved', { id: 'permission-call-2', toolCallId: 'call-2', answer: 'once' }));
      run(f, 'call-2', 'rm: build: Permission denied');
      run(f, 'call-3', 'Command exited with code 1');
      f.finish();
      await running;
      expect(ended(f, 'call-1')).toMatchObject({ status: 'failed', rawOutput: { mu: { answer: 'deny' } } });
      expect(asRecordOf(ended(f, 'call-2')).rawOutput).not.toHaveProperty('mu');
      expect(asRecordOf(ended(f, 'call-3')).rawOutput).not.toHaveProperty('mu');
    } finally {
      f.cleanup();
    }
  });
});

describe('the judge’s line', () => {
  it('names the judge that was asked on a classification that ended without its answer', async () => {
    const f = fixture();
    try {
      const { sessionId } = await f.agent.newSession({ cwd: tmpdir(), mcpServers: [] });
      const running = f.agent.prompt({ sessionId, prompt: [{ type: 'text', text: 'Test' }] });
      f.emit(shown('preflight.pending', { judge: 'laya>jev-latest', mode: 'active' }));
      f.emit(shown('preflight.wait_end', { reason: 'timeout' }));
      f.finish();
      await running;
      const rows = f.updates
        .map((each) => each.update)
        .filter((update) => 'toolCallId' in update && update.toolCallId === 'jev:r:0');
      expect(rows.map((update) => ('rawOutput' in update ? update.rawOutput : undefined))).toEqual([
        { preflight: 'pending', judge: 'laya>jev-latest' },
        { preflight: 'fallback', judge: 'laya>jev-latest' },
      ]);
    } finally {
      f.cleanup();
    }
  });
});
