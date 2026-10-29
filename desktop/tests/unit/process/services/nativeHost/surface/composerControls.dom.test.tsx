import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandItem } from '@/common/chat/slash/types';
import { emptyView, reduceAll, type PiCommand, type PiRecord } from '@/common/utils/nativeHost';
import { useConversationContextSafe } from '@/renderer/hooks/context/ConversationContext';
import { useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import NativeComposer from '@/renderer/pages/native/components/NativeComposer';
import { stageFirstMessage, useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
import { NativeClientContext } from '@/renderer/pages/native/utils/nativeClient';
import enAgent from '@/renderer/services/i18n/locales/en-US/agent.json';
import enAgentMode from '@/renderer/services/i18n/locales/en-US/agentMode.json';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import enConversation from '@/renderer/services/i18n/locales/en-US/conversation.json';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import type { FileSelectionItem } from '@/renderer/utils/file/fileSelection';
import { createFakeHost, type FakeHost } from './fakeClient';
import { ended, frame, reply, text, user } from './records';

/**
 * The native send box's controls against an in-memory host: the model and thinking level (shown without starting a
 * host, switched through pi's own commands), mu's permission mode (switched with mu's `/permissions <mode> --here`),
 * pi's slash commands for the `/` menu, `@` mentions of the project's files, and attachments (images as themselves,
 * files by their path). The shared send box is stood in for by its contract; Arco's menus render their lists inline.
 */

const { warning, mention, muDefault } = vi.hoisted(() => ({
  warning: vi.fn(),
  mention: { items: [] as unknown[] },
  // mu's default model, as the settings say it: none unless a test sets one.
  muDefault: { model: undefined as string | undefined, level: '' },
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- vi.mock is hoisted above anything outside it
  const dataOf = (props: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(props).filter(([name]) => name.startsWith('data-')));
  type Props = { children?: React.ReactNode; [key: string]: unknown };
  const Menu = Object.assign(({ children }: Props) => <div role='menu'>{children}</div>, {
    Item: ({ children, onClick, ...rest }: Props & { onClick?: () => void }) => (
      <div role='menuitem' onClick={onClick} {...dataOf(rest)}>
        {children}
      </div>
    ),
    ItemGroup: ({ children }: Props) => <div role='group'>{children}</div>,
  });
  return {
    ...actual,
    Dropdown: ({
      children,
      droplist,
      popupVisible,
    }: Props & { droplist?: React.ReactNode; popupVisible?: boolean }) => (
      <div>
        {children}
        {popupVisible ? droplist : null}
      </div>
    ),
    Menu,
    Message: { warning, error: vi.fn(), success: vi.fn() },
    Tooltip: ({ children }: Props) => <>{children}</>,
  };
});

// The real label measures itself for a marquee, which prints the text more than once.
vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock('@/renderer/hooks/agent/useProviderNames', () => ({ useProviderNames: () => new Map() }));

vi.mock('@/renderer/hooks/agent/useMuDefaultModel', () => ({
  useMuDefaultModel: () => ({
    ...(muDefault.model ? { model: muDefault.model } : {}),
    level: muDefault.level,
    makeDefault: vi.fn(async () => true),
  }),
}));

type BoxProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSend: (message: string, extras?: { images?: Array<{ data: string; mimeType: string }> }) => Promise<void | false>;
  tools?: React.ReactNode;
  rightTools?: React.ReactNode;
  prefix?: React.ReactNode;
  slash_commands?: SlashCommandItem[];
  onSlashBuiltinCommand?: (name: string) => void;
  onSelectedWorkspaceItemsChange?: (items: FileSelectionItem[]) => void;
  hasPendingAttachments?: boolean;
  testIds?: { input?: string; send?: string; stop?: string };
};

vi.mock('@/renderer/components/chat/SendBox', () => ({
  // As the real box: sending clears the text and a `false` answer brings it back. The folder `@` searches in is the
  // conversation context's; a mention the person picks comes back through `onSelectedWorkspaceItemsChange`. Its ↑/↓
  // history and `/copy` read the message list.
  default: (props: BoxProps) => {
    const context = useConversationContextSafe();
    const messages = useMessageList();
    const value = props.value ?? '';
    return (
      <div
        data-testid='sendbox'
        data-workspace={context?.workspace ?? ''}
        data-messages={messages
          .map((row) =>
            row.type === 'text' ? `${row.conversation_id} ${row.position}:${row.content.content}` : row.type
          )
          .join('|')}
        data-commands={(props.slash_commands ?? []).map((command) => command.name).join(' ')}
        data-pending={String(Boolean(props.hasPendingAttachments))}
      >
        {props.prefix}
        {props.tools}
        <textarea
          data-testid={props.testIds?.input}
          value={value}
          onChange={(event) => props.onChange?.(event.target.value)}
        />
        <button
          type='button'
          data-testid={props.testIds?.send}
          onClick={() => {
            props.onChange?.('');
            void props.onSend(value).then((result) => {
              if (result === false) props.onChange?.(value);
            });
          }}
        />
        <button
          type='button'
          data-testid='send-with-picture'
          onClick={() => {
            props.onChange?.('');
            void props.onSend(value, { images: [{ data: 'cG5n', mimeType: 'image/png' }] });
          }}
        />
        <button
          type='button'
          data-testid='mention'
          onClick={() => props.onSelectedWorkspaceItemsChange?.(mention.items as FileSelectionItem[])}
        />
        <button type='button' data-testid='slash-open' onClick={() => props.onSlashBuiltinCommand?.('open')} />
        {props.rightTools}
      </div>
    );
  },
}));

afterEach(() => {
  cleanup();
  warning.mockClear();
  mention.items = [];
  muDefault.model = undefined;
  muDefault.level = '';
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: {
    en: {
      translation: {
        agent: enAgent,
        agentMode: enAgentMode,
        common: enCommon,
        conversation: enConversation,
        messages: enMessages,
        mu: enMu,
      },
    },
  },
  interpolation: { escapeValue: false },
});

const Harness: React.FC<{ id: string }> = ({ id }) => <NativeComposer conversation={useNativeConversation(id)} />;

async function mount(host: FakeHost, id = 'c1') {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <NativeClientContext.Provider value={host.client}>
          <Harness id={id} />
        </NativeClientContext.Provider>
      </MemoryRouter>
    </I18nextProvider>
  );
  await waitFor(() => expect(host.calls.some((call) => call.method === 'open')).toBe(true));
  await act(async () => {});
  return view;
}

const commands = (host: FakeHost): PiCommand[] =>
  host.calls.filter((call) => call.method === 'request').flatMap((call) => (call.command ? [call.command] : []));
const sent = (host: FakeHost, type: PiCommand['type']) => commands(host).filter((command) => command.type === type);

const box = () => screen.getByTestId('sendbox');
const chip = () => screen.getByTestId('native-model-chip');
const pill = () => screen.getByTestId('native-permission-pill');
const type = (value: string) => fireEvent.change(screen.getByTestId('native-send-input'), { target: { value } });
const send = async () => {
  await act(async () => {
    fireEvent.click(screen.getByTestId('native-send'));
  });
};

/** pi's answer to `get_state`, which the main process passes on: the view's session reads it. */
const state = (provider: string, id: string, thinkingLevel: string): PiRecord => ({
  type: 'response',
  command: 'get_state',
  success: true,
  data: { model: { provider, id }, thinkingLevel },
});

/** mu's `permissions.mode` frame, as its permissions feature sends it. */
const modes = (mode: string) =>
  frame('permissions.mode', {
    mode,
    label: mode,
    conversationSwitch: true,
    modes: [
      { id: 'full', label: '完全访问', description: 'runs everything' },
      { id: 'judge', label: '判定模式', description: 'the judge approves' },
      { id: 'ask', label: '最小权限', description: 'asks first' },
    ],
  });

describe('the native send box’s model, thinking level and permission mode', () => {
  it('shows what a conversation with no host runs with, from its file, and starts nothing', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, emptyView(), { model: 'e2e/thinker', thinkingLevel: 'high', permissions: 'ask' });
    await mount(host);
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
    expect(chip()).toHaveAttribute('data-source', 'file');
    expect(chip()).toHaveTextContent('thinker · High');
    expect(pill()).toHaveAttribute('data-mode', 'ask');
    expect(pill()).toHaveTextContent('Permission · Ask first');
    expect(commands(host)).toEqual([]);

    // A running host says what it runs with, and mu what mode it is in: they count from then on.
    act(() => {
      host.play('c1', [state('e2e', 'one', 'off'), modes('full')]);
    });
    expect(chip()).toHaveAttribute('data-model', 'e2e/one');
    expect(chip()).toHaveAttribute('data-level', 'off');
    expect(chip()).toHaveAttribute('data-source', 'host');
    expect(pill()).toHaveAttribute('data-mode', 'full');
    expect(pill()).toHaveTextContent('Permission · Full access');
  });

  it('falls back to the model of the last reply, and says when mu has no model', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, reduceAll([ended(user('hi')), ended(reply([text('hello')]))]));
    await mount(host);
    expect(chip()).toHaveAttribute('data-model', 'p/m');
    expect(chip()).toHaveAttribute('data-source', 'reply');
    // mu's default mode: the conversation has not said one.
    expect(pill()).toHaveAttribute('data-mode', '');
    expect(pill()).toHaveTextContent("Permission · mu's default");
    act(() => {
      host.push('c1', { type: 'response', command: 'get_state', success: true, data: { thinkingLevel: 'off' } });
    });
    expect(chip()).toHaveAttribute('data-model', '');
    expect(chip()).toHaveTextContent('Choose a model');
  });

  it('goes on with mu’s default model in a conversation imported from another tool, not the tool’s', async () => {
    const host = createFakeHost();
    const imported = { api: 'claude-code', provider: 'claude-code', model: 'claude-opus-4-5' };
    host.add({ id: 'c1' }, reduceAll([ended(user('hi')), ended(reply([text('hello')], imported))]));
    await mount(host);
    expect(chip()).toHaveAttribute('data-model', '');
    expect(chip()).toHaveAttribute('data-source', 'none');
    expect(chip()).toHaveTextContent('Default model');
    expect(commands(host)).toEqual([]);
  });

  it('names mu’s default model, as the home page did, while nothing in the conversation says its model', async () => {
    muDefault.model = 'e2e/one';
    muDefault.level = 'low';
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    expect(chip()).toHaveAttribute('data-source', 'none');
    expect(chip()).toHaveAttribute('data-model', '');
    expect(chip()).toHaveTextContent('one · Low');
    expect(chip()).not.toHaveTextContent('Default model');
    expect(commands(host)).toEqual([]);
    // mu says what it runs with: that, from then on.
    act(() => {
      host.push('c1', state('e2e', 'two', 'off'));
    });
    expect(chip()).toHaveTextContent('two · Thinking off');
  });

  it('says the model and level the home page’s first message sets while mu starts, then what pi says', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    const pi: { setUp?: () => void } = {};
    host.answer(async (_id, command) => {
      // mu starts on the first command: it takes its time.
      if (command.type === 'set_model')
        await new Promise<void>((resolve) => {
          pi.setUp = resolve;
        });
      return { ok: true, data: { isStreaming: false, isCompacting: false } };
    });
    stageFirstMessage('c1', {
      setup: [
        { type: 'set_model', provider: 'e2e', modelId: 'thinker' },
        { type: 'set_thinking_level', level: 'high' },
      ],
      text: 'fix the build',
    });
    await mount(host);
    await waitFor(() => expect(chip()).toHaveAttribute('data-source', 'setup'));
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
    expect(chip()).toHaveTextContent('thinker · High');
    // mu says first what it started with, which the set-up is about to change: the chip keeps what is being set.
    act(() => {
      host.push('c1', state('e2e', 'one', 'off'));
    });
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
    // Set up: what pi says counts from then on.
    await act(async () => {
      host.play('c1', [
        { type: 'response', command: 'set_model', success: true, data: { provider: 'e2e', id: 'thinker' } },
        { type: 'thinking_level_changed', level: 'high' },
      ]);
      pi.setUp?.();
    });
    await waitFor(() => expect(chip()).toHaveAttribute('data-source', 'host'));
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
  });

  it('stops saying the model the first message was setting once mu refuses it', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer((_id, command) =>
      command.type === 'set_model'
        ? { ok: false, kind: 'command', message: 'Unknown model e2e/gone' }
        : { ok: true, data: undefined }
    );
    stageFirstMessage('c1', {
      setup: [{ type: 'set_model', provider: 'e2e', modelId: 'gone' }],
      text: 'fix the build',
    });
    await mount(host);
    await waitFor(() => expect(screen.getByTestId('native-command-failed')).toBeInTheDocument());
    expect(chip()).toHaveAttribute('data-source', 'none');
    expect(chip()).toHaveAttribute('data-model', '');
    expect(chip()).toHaveTextContent('Default model');
  });

  it('lists pi’s models when the chip opens, switches the model, and offers the levels of the model in use', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    let inUse = 'one';
    host.answer((_id, command) => {
      if (command.type === 'get_available_models')
        return {
          ok: true,
          data: {
            models: [
              { provider: 'e2e', id: 'one', name: 'One' },
              { provider: 'e2e', id: 'thinker', name: 'Thinker', reasoning: true },
              { provider: 'vercel-ai-gateway', id: 'hidden', name: 'Hidden' },
            ],
          },
        };
      if (command.type === 'set_model') inUse = String(command.modelId);
      if (command.type === 'get_available_thinking_levels')
        return {
          ok: true,
          data: { levels: inUse === 'thinker' ? ['off', 'minimal', 'low', 'medium', 'high'] : ['off'] },
        };
      return { ok: true, data: undefined };
    });
    await mount(host);
    act(() => {
      host.push('c1', state('e2e', 'one', 'off'));
    });
    fireEvent.click(screen.getByTestId('native-model-pill'));
    await waitFor(() => expect(screen.getAllByTestId('composer-model-option')).toHaveLength(2));
    expect(commands(host)).toEqual([{ type: 'get_available_models' }, { type: 'get_available_thinking_levels' }]);
    const row = (value: string) =>
      screen.getAllByTestId('composer-model-option').find((each) => each.getAttribute('data-value') === value)!;
    // The model in use takes one level: nothing to choose under the list.
    expect(screen.queryByTestId('composer-thinking')).toBeNull();
    // A row switches the model only: pi keeps a level of its own choosing.
    await act(async () => {
      fireEvent.click(row('e2e/thinker'));
    });
    expect(commands(host).slice(2)).toEqual([{ type: 'set_model', provider: 'e2e', modelId: 'thinker' }]);
    act(() => {
      host.play('c1', [
        { type: 'response', command: 'set_model', success: true, data: { provider: 'e2e', id: 'thinker' } },
        { type: 'thinking_level_changed', level: 'medium' },
      ]);
    });
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');

    // Open again: the levels of the model that reasons, by pi's own answer, under the list.
    fireEvent.click(screen.getByTestId('native-model-pill'));
    await waitFor(() => expect(screen.getByTestId('composer-thinking')).toBeInTheDocument());
    const levels = screen.getAllByTestId('composer-level-option');
    expect(levels.map((each) => each.getAttribute('data-value'))).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    await act(async () => {
      fireEvent.click(levels[4]);
    });
    expect(commands(host).slice(5)).toEqual([{ type: 'set_thinking_level', level: 'high' }]);
    act(() => {
      host.play('c1', [{ type: 'thinking_level_changed', level: 'high' }]);
    });
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
  });

  it('lists the newest OpenAI models and the one in use, and every model once asked', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer((_id, command) => {
      if (command.type === 'get_available_models')
        return {
          ok: true,
          data: {
            models: [
              { provider: 'openai', id: 'gpt-4.1', name: 'GPT-4.1' },
              { provider: 'openai', id: 'gpt-4o', name: 'GPT-4o' },
              { provider: 'openai', id: 'gpt-5', name: 'GPT-5', reasoning: true },
              { provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', reasoning: true },
              { provider: 'openai', id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', reasoning: true },
              { provider: 'openai', id: 'o3', name: 'o3', reasoning: true },
            ],
          },
        };
      if (command.type === 'get_available_thinking_levels') return { ok: true, data: { levels: ['low', 'high'] } };
      return { ok: true, data: undefined };
    });
    await mount(host);
    act(() => {
      host.push('c1', state('openai', 'gpt-5.5', 'high'));
    });
    fireEvent.click(screen.getByTestId('native-model-pill'));
    const listed = () => screen.getAllByTestId('composer-model-option').map((each) => each.getAttribute('data-value'));
    // The conversation's own older model stays listed beside the newest series.
    await waitFor(() => expect(listed()).toEqual(['openai/gpt-5.5', 'openai/gpt-6.1-sol']));
    expect(screen.getByTestId('composer-thinking')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('composer-model-show-all'));
    expect(listed()).toEqual([
      'openai/gpt-4.1',
      'openai/gpt-4o',
      'openai/gpt-5',
      'openai/gpt-5.5',
      'openai/gpt-6.1-sol',
      'openai/o3',
    ]);
    fireEvent.click(screen.getByTestId('composer-model-show-all'));
    expect(listed()).toEqual(['openai/gpt-5.5', 'openai/gpt-6.1-sol']);
    // A search looks through every model.
    fireEvent.change(screen.getByTestId('composer-model-search'), { target: { value: '4o' } });
    expect(listed()).toEqual(['openai/gpt-4o']);
  });

  it('waits for the run to end before a model switch', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    await mount(host);
    act(() => {
      host.play('c1', [{ type: 'agent_start' }, ended(user('go'))]);
    });
    expect(screen.getByTestId('native-model-pill')).toBeDisabled();
    act(() => {
      host.play('c1', [ended(reply([text('done')])), { type: 'agent_settled' }]);
    });
    expect(screen.getByTestId('native-model-pill')).not.toBeDisabled();
  });

  it('switches mu’s permission mode with mu’s own command, for this conversation only', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' }, emptyView(), { permissions: 'ask' });
    await mount(host);
    fireEvent.click(screen.getByTestId('native-permission'));
    const options = screen.getAllByTestId('native-permission-option');
    expect(options.map((each) => each.getAttribute('data-mode'))).toEqual(['full', 'judge', 'ask']);
    await act(async () => {
      fireEvent.click(options[0]);
    });
    expect(commands(host)).toEqual([{ type: 'prompt', message: '/permissions full --here' }]);
    act(() => {
      host.push('c1', modes('full'));
    });
    expect(pill()).toHaveAttribute('data-mode', 'full');
    // The mode in force again is no switch.
    fireEvent.click(screen.getByTestId('native-permission'));
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('native-permission-option')[0]);
    });
    expect(sent(host, 'prompt')).toHaveLength(1);
  });
});

describe('the native send box’s commands, mentions and attachments', () => {
  it('offers pi’s slash commands, asked when a command is started and again whenever a host runs', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
    host.answer((_id, command) =>
      command.type === 'get_commands'
        ? {
            ok: true,
            data: {
              commands: [
                { name: 'lessons', description: 'This project’s lessons\nwith more', source: 'extension' },
                { name: 'clear', description: 'A fresh session', source: 'extension' },
                { name: 'skill:tidy', description: 'Tidy up', source: 'skill' },
                { name: 'lessons', description: 'again', source: 'prompt' },
              ],
            },
          }
        : { ok: true, data: undefined }
    );
    await mount(host);
    expect(box()).toHaveAttribute('data-commands', '');
    expect(sent(host, 'get_commands')).toHaveLength(0);
    type('/');
    await waitFor(() => expect(box()).toHaveAttribute('data-commands', 'lessons skill:tidy'));
    expect(sent(host, 'get_commands')).toHaveLength(1);
    act(() => host.setStatus('c1', { phase: 'running' }));
    await waitFor(() => expect(sent(host, 'get_commands')).toHaveLength(2));
  });

  it('sends the files mentioned with @ as full paths after the files marker; @ searches the conversation’s folder', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/project' });
    await mount(host);
    expect(box()).toHaveAttribute('data-workspace', '/work/project');
    mention.items = [
      {
        path: '/work/project/src/a.ts',
        name: 'a.ts',
        isFile: true,
        relativePath: 'src/a.ts',
        chatRef: { kind: 'local', path: '/work/project/src/a.ts' },
      },
      { path: 'docs/b.md', name: 'b.md', isFile: true, relativePath: 'docs/b.md' },
    ];
    fireEvent.click(screen.getByTestId('mention'));
    expect(box()).toHaveAttribute('data-pending', 'true');
    type('look at @src/a.ts');
    await send();
    expect(sent(host, 'prompt')).toEqual([
      {
        type: 'prompt',
        message: 'look at @src/a.ts\n\n[[AION_FILES]]\n/work/project/src/a.ts\n/work/project/docs/b.md',
      },
    ]);
    expect(box()).toHaveAttribute('data-pending', 'false');
  });

  it('attaches images as themselves and other files by their path: picked, dropped or pasted, and taken off', async () => {
    const paths: Record<string, string> = { 'notes.txt': '/work/project/notes.txt' };
    const electron = window as unknown as { electronAPI?: { getPathForFile?: (file: File) => string } };
    const before = electron.electronAPI;
    electron.electronAPI = { getPathForFile: (file) => paths[file.name] ?? '' };
    try {
      const host = createFakeHost();
      host.add({ id: 'c1', cwd: '/work/project' });
      host.answer((_id, command) =>
        command.type === 'prompt' && command.message.startsWith('fail')
          ? { ok: false, kind: 'timeout', message: 'pi did not answer' }
          : { ok: true, data: undefined }
      );
      await mount(host);
      const bytes = new Uint8Array([137, 80, 78, 71]);
      const png = new File([bytes], 'shot.png', { type: 'image/png' });
      const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' });
      await act(async () => {
        fireEvent.change(screen.getByTestId('native-attach-input'), { target: { files: [png, notes] } });
      });
      const chips = () => screen.queryAllByTestId('native-attachment');
      await waitFor(() => expect(chips()).toHaveLength(2));
      expect(chips().map((each) => each.getAttribute('data-kind'))).toEqual(['image', 'file']);
      expect(box()).toHaveAttribute('data-pending', 'true');

      // Dropped: one more image. Pasted: a file with no path that is no image cannot be attached, and says so.
      await act(async () => {
        fireEvent.drop(box(), { dataTransfer: { files: [new File([bytes], 'again.png', { type: 'image/png' })] } });
      });
      await waitFor(() => expect(chips()).toHaveLength(3));
      await act(async () => {
        fireEvent.paste(screen.getByTestId('native-send-input'), {
          clipboardData: { files: [new File(['x'], 'blob.bin', { type: 'application/octet-stream' })] },
        });
      });
      await waitFor(() => expect(warning).toHaveBeenCalledWith("Couldn't attach blob.bin."));
      expect(chips()).toHaveLength(3);
      fireEvent.click(within(chips()[2]).getByTestId('native-attachment-remove'));
      expect(chips()).toHaveLength(2);

      // `/open` opens the same picker.
      const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
      fireEvent.click(screen.getByTestId('slash-open'));
      expect(click).toHaveBeenCalledTimes(1);
      click.mockRestore();

      // What did not reach pi stays, attachments included.
      type('fail first');
      await send();
      expect(chips()).toHaveLength(2);
      type('what is this');
      await send();
      const image = { type: 'image', mimeType: 'image/png', data: Buffer.from(bytes).toString('base64') };
      expect(sent(host, 'prompt').at(-1)).toEqual({
        type: 'prompt',
        message: 'what is this\n\n[[AION_FILES]]\n/work/project/notes.txt',
        images: [image],
      });
      expect(screen.queryByTestId('native-attachments')).toBeNull();
    } finally {
      electron.electronAPI = before;
    }
  });
});

describe('the picture of an element picked in the browser', () => {
  it('goes to pi as an image with the message that carries the element', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/project' });
    host.answer(() => ({ ok: true, data: undefined }));
    await mount(host);
    type('make it blue');
    await act(async () => {
      fireEvent.click(screen.getByTestId('send-with-picture'));
    });
    expect(sent(host, 'prompt').at(-1)).toEqual({
      type: 'prompt',
      message: 'make it blue',
      images: [{ type: 'image', mimeType: 'image/png', data: 'cG5n' }],
    });
  });
});

describe('the commands mu runs in the background', () => {
  const started = (id: string) =>
    frame('background.start', { id, name: id, command: `npm run ${id}`, logPath: `/logs/${id}.log` }, 1, Date.now());

  it('show as a pill while one runs; its list stops one or all with mu’s /jobs, and says how one ended', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1', cwd: '/work/project' });
    host.answer(() => ({ ok: true, data: undefined }));
    await mount(host);
    expect(screen.queryByTestId('native-jobs')).toBeNull();

    act(() => host.play('c1', [started('dev'), started('watch')]));
    expect(screen.getByTestId('native-jobs')).toHaveAttribute('data-count', '2');
    expect(screen.getByTestId('native-jobs-pill')).toHaveTextContent('Background · 2');
    fireEvent.click(screen.getByTestId('native-jobs-pill'));
    const list = await screen.findByTestId('native-jobs-list');
    expect(
      within(list)
        .getAllByTestId('native-job')
        .map((row) => row.getAttribute('data-job'))
    ).toEqual(['dev', 'watch']);
    expect(within(list).getByText('npm run dev')).toBeInTheDocument();
    expect(within(list).getAllByText(/^running for /)).toHaveLength(2);

    await act(async () => {
      fireEvent.click(within(list).getAllByTestId('native-job-stop')[0]);
    });
    expect(sent(host, 'prompt').at(-1)).toEqual({ type: 'prompt', message: '/jobs stop dev' });
    await act(async () => {
      fireEvent.click(within(list).getByTestId('native-jobs-stop-all'));
    });
    expect(sent(host, 'prompt').at(-1)).toEqual({ type: 'prompt', message: '/jobs stop all' });

    // The first ended: it stays listed under the one that runs, with how it ended.
    act(() =>
      host.play('c1', [frame('background.exit', { id: 'dev', exitCode: 1, durationMs: 65_000 }, 1, Date.now())])
    );
    expect(screen.getByTestId('native-jobs')).toHaveAttribute('data-count', '1');
    const endedRow = within(screen.getByTestId('native-jobs-list'))
      .getAllByTestId('native-job')
      .find((row) => row.getAttribute('data-job') === 'dev');
    expect(endedRow).toHaveAttribute('data-state', 'exited');
    expect(endedRow).toHaveTextContent(/exited with code 1 after/);
    expect(within(endedRow as HTMLElement).queryByTestId('native-job-stop')).toBeNull();
    expect(screen.queryByTestId('native-jobs-stop-all')).toBeNull();

    // Nothing runs: the pill goes.
    act(() =>
      host.play('c1', [
        frame('background.exit', { id: 'watch', exitCode: 0, durationMs: 1, stoppedBy: 'user' }, 1, Date.now()),
      ])
    );
    expect(screen.queryByTestId('native-jobs')).toBeNull();
  });
});

describe('the send box’s ↑/↓ history and /copy', () => {
  it('read the conversation’s text: the person’s words without their files, and the replies', async () => {
    const host = createFakeHost();
    host.add(
      { id: 'c1' },
      reduceAll([ended(user('first\n\n[[AION_FILES]]\n/p/a.md')), ended(reply([text('answer')]))])
    );
    await mount(host);
    expect(box()).toHaveAttribute('data-messages', 'c1 right:first|c1 left:answer');
    act(() => {
      host.play('c1', [ended(user('second')), ended(reply([text('more')]))]);
    });
    expect(box()).toHaveAttribute('data-messages', 'c1 right:first|c1 left:answer|c1 right:second|c1 left:more');
  });
});
