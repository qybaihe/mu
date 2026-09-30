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
import { useNativeConversation } from '@/renderer/pages/native/hooks/useNativeConversation';
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

const { warning, mention } = vi.hoisted(() => ({ warning: vi.fn(), mention: { items: [] as unknown[] } }));

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
    // Both levels at once: the row and what it opens.
    SubMenu: ({ children, title, ...rest }: Props & { title?: React.ReactNode }) => (
      <div {...dataOf(rest)}>
        <div>{title}</div>
        <div>{children}</div>
      </div>
    ),
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

type BoxProps = {
  value?: string;
  onChange?: (value: string) => void;
  onSend: (message: string) => Promise<void | false>;
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
      { id: 'jev', label: 'Jev 审批', description: 'Jev approves' },
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
    expect(pill()).toHaveTextContent('Permission · Minimal permissions');
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

  it('lists pi’s models when the chip opens, and switches the model, then the level the person picked', async () => {
    const host = createFakeHost();
    host.add({ id: 'c1' });
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
      if (command.type === 'get_available_thinking_levels') return { ok: true, data: { levels: ['off'] } };
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
    // A model that reasons opens to the levels pi's rule gives it; one that does not is picked as it is.
    const levels = within(row('e2e/thinker')).getAllByTestId('composer-level-option');
    expect(levels.map((each) => each.getAttribute('data-value'))).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(within(row('e2e/one')).queryAllByTestId('composer-level-option')).toHaveLength(0);
    await act(async () => {
      fireEvent.click(levels[4]);
    });
    expect(commands(host).slice(2)).toEqual([
      { type: 'set_model', provider: 'e2e', modelId: 'thinker' },
      { type: 'set_thinking_level', level: 'high' },
    ]);
    // pi answers the switch: the chip follows the view.
    act(() => {
      host.play('c1', [
        { type: 'response', command: 'set_model', success: true, data: { provider: 'e2e', id: 'thinker' } },
        { type: 'thinking_level_changed', level: 'high' },
      ]);
    });
    expect(chip()).toHaveAttribute('data-model', 'e2e/thinker');
    expect(chip()).toHaveAttribute('data-level', 'high');
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
    expect(options.map((each) => each.getAttribute('data-mode'))).toEqual(['full', 'jev', 'ask']);
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
      await waitFor(() => expect(warning).toHaveBeenCalledWith('blob.bin could not be attached.'));
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
