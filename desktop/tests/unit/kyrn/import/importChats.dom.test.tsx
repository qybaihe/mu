import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { FoundChat, ImportedHistory, ImportList, ImportOutcome } from '@/common/kyrn/importChats';
import common from '@/renderer/services/i18n/locales/en-US/common.json';
import mu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { emitter } from '@/renderer/utils/emitter';
import ImportChatsModal from '@/renderer/pages/settings/SystemSettings/ImportChats/ImportChatsModal';
import ImportedChatNotice from '@/renderer/pages/conversation/platforms/acp/ImportedChat';
import ImportedHistoryModal from '@/renderer/pages/conversation/platforms/acp/ImportedChat/ImportedHistoryModal';

type Answer<T> = { ok: true; data: T } | { ok: false; error: string };

const { list, run, history, navigate, said, native } = vi.hoisted(() => ({
  /** Whether the app runs mu itself (the native host): imported sessions are then conversations of their own. */
  native: { on: false, rereads: 0 },
  list: vi.fn<(request: { cwd?: string }) => Promise<Answer<ImportList>>>(),
  run: vi.fn<(request: { paths: string[]; locale: string }) => Promise<Answer<ImportOutcome[]>>>(),
  history: vi.fn<(request: { conversationId: string }) => Promise<Answer<ImportedHistory>>>(),
  navigate: vi.fn(),
  /** What the dialog said in a toast: [kind, text]. */
  said: [] as [string, string][],
}));
vi.mock('@/common/kyrn/bridge', () => ({
  kyrnBridge: { importList: { invoke: list }, importRun: { invoke: run }, importHistory: { invoke: history } },
  unwrap: <T,>(result: Answer<T>) => {
    if (result.ok === false) throw new Error(result.error);
    return result.data;
  },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('@/renderer/pages/native/hooks/useNativeConversations', () => ({
  useNativeEnabled: () => native.on,
  rereadNativeConversations: () => {
    native.rereads++;
  },
}));
// The dialog frame (AionModal) sizes itself by the font scale.
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({ useThemeContext: () => ({ fontScale: 1 }) }));
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  const toast = (kind: string) => (text: string) => {
    said.push([kind, text]);
  };
  return {
    ...actual,
    Message: { ...actual.Message, success: toast('success'), warning: toast('warning'), error: toast('error') },
  };
});

const i18n = createInstance();
beforeAll(async () => {
  await i18n.init({
    lng: 'en',
    resources: { en: { translation: { common, mu } } },
    interpolation: { escapeValue: false },
  });
});

const at = '2026-09-20T10:00:00.000Z';
const chat = (tool: FoundChat['tool'], title: string, extra: Partial<FoundChat> = {}): FoundChat => ({
  tool,
  path: `/t/${title.replace(/\s+/g, '-')}.jsonl`,
  cwd: '/work/app',
  title,
  modified: at,
  size: 2048,
  ...extra,
});
const found: FoundChat[] = [
  chat('claude-code', 'Fix the login form'),
  chat('claude-code', 'Held one', { importedAs: '/s/held.jsonl', conversationId: 'held' }),
  chat('codex', 'Deploy script', { cwd: undefined }),
];

const settle = () =>
  act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });

function Dialog({ onClose = () => {} }: { onClose?: () => void }) {
  return (
    <I18nextProvider i18n={i18n}>
      <ImportChatsModal visible onClose={onClose} />
    </I18nextProvider>
  );
}
const row = (title: string) =>
  screen.getAllByTestId('import-chat-row').find((each) => each.textContent?.includes(title)) as HTMLElement;

beforeEach(() => {
  list.mockResolvedValue({ ok: true, data: { conversations: found } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  said.length = 0;
});

describe('the import dialog', () => {
  it('lists the conversations under their tool, with folder, date and first message', async () => {
    render(<Dialog />);
    await settle();
    const groups = screen.getAllByTestId('import-chat-group');
    expect(groups.map((group) => group.dataset.tool)).toEqual(['claude-code', 'codex']);
    expect(within(groups[0]).getByText('Claude Code')).toBeInTheDocument();
    expect(row('Fix the login form').textContent).toContain('app');
    expect(row('Fix the login form').textContent).toContain('2 KB');
    expect(row('Deploy script').textContent).toContain('Folder unknown');
    expect(list).toHaveBeenCalledWith({ native: false });
  });

  it('offers a conversation already in the list to open, not to import again', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    await settle();
    const held = row('Held one');
    expect(held.textContent).toContain('In your list');
    expect(within(held).getByRole('checkbox')).toBeDisabled();
    fireEvent.click(within(held).getByRole('button', { name: 'Open' }));
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/conversation/held');
  });

  it('finds conversations by the words of their first message or folder', async () => {
    render(<Dialog />);
    await settle();
    fireEvent.change(screen.getByPlaceholderText('Search by words or folder'), { target: { value: 'deploy' } });
    expect(screen.getAllByTestId('import-chat-row').map((each) => each.dataset.path)).toEqual([
      '/t/Deploy-script.jsonl',
    ]);
    fireEvent.change(screen.getByPlaceholderText('Search by words or folder'), {
      target: { value: 'nothing like it' },
    });
    expect(screen.getByText('No conversation matches.')).toBeInTheDocument();
  });

  it('imports the chosen one, refreshes the conversation list and opens it', async () => {
    const onClose = vi.fn();
    const emit = vi.spyOn(emitter, 'emit');
    run.mockResolvedValue({
      ok: true,
      data: [
        {
          status: 'imported',
          source: '/t/Fix-the-login-form.jsonl',
          tool: 'claude-code',
          conversationId: 'new-1',
          name: 'Fix the login form',
        },
      ],
    });
    render(<Dialog onClose={onClose} />);
    await settle();
    expect(screen.getByTestId('import-chats-start')).toBeDisabled();
    fireEvent.click(within(row('Fix the login form')).getByText('Fix the login form'));
    expect(screen.getByText('Chosen: 1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('import-chats-start'));
    await settle();
    expect(run).toHaveBeenCalledWith({ paths: ['/t/Fix-the-login-form.jsonl'], locale: 'en', native: false });
    expect(emit).toHaveBeenCalledWith('chat.history.refresh');
    expect(onClose).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/conversation/new-1');
    expect(said).toEqual([['success', '1 conversation imported. It is in your conversation list.']]);
  });

  it('with the app running mu itself, opens the session an import became, and reads the native list again', async () => {
    native.on = true;
    native.rereads = 0;
    try {
      const emit = vi.spyOn(emitter, 'emit');
      list.mockResolvedValue({
        ok: true,
        data: {
          conversations: [
            chat('claude-code', 'Fix the login form'),
            chat('codex', 'Held one', { importedAs: '/s/held.jsonl', conversationId: 'session-held', native: true }),
          ],
        },
      });
      run.mockResolvedValue({
        ok: true,
        data: [
          {
            status: 'imported',
            source: '/t/Fix-the-login-form.jsonl',
            tool: 'claude-code',
            conversationId: 'session-1',
            name: 'Fix the login form',
            native: true,
          },
        ],
      });
      const { unmount } = render(<Dialog />);
      await settle();
      expect(list).toHaveBeenCalledWith({ native: true });
      fireEvent.click(within(row('Held one')).getByRole('button', { name: 'Open' }));
      expect(navigate).toHaveBeenCalledWith('/conversation/native/session-held');
      unmount();

      render(<Dialog />);
      await settle();
      fireEvent.click(within(row('Fix the login form')).getByRole('checkbox'));
      fireEvent.click(screen.getByTestId('import-chats-start'));
      await settle();
      expect(run).toHaveBeenCalledWith({ paths: ['/t/Fix-the-login-form.jsonl'], locale: 'en', native: true });
      expect(native.rereads).toBe(1);
      expect(emit).not.toHaveBeenCalledWith('chat.history.refresh');
      expect(navigate).toHaveBeenLastCalledWith('/conversation/native/session-1');
    } finally {
      native.on = false;
    }
  });

  it('keeps the dialog open with the reason under each one that failed', async () => {
    const onClose = vi.fn();
    run.mockResolvedValue({
      ok: true,
      data: [{ status: 'failed', source: '/t/Deploy-script.jsonl', reason: 'folderMissing', detail: '/gone/app' }],
    });
    render(<Dialog onClose={onClose} />);
    await settle();
    fireEvent.click(within(row('Deploy script')).getByRole('checkbox'));
    fireEvent.click(screen.getByTestId('import-chats-start'));
    await settle();
    expect(onClose).not.toHaveBeenCalled();
    expect(row('Deploy script').textContent).toContain('Its project folder is gone: /gone/app');
    expect(navigate).not.toHaveBeenCalled();
    expect(said).toEqual([['warning', '1 conversation could not be imported. The reason is under it.']]);
    // The list is asked again, so what did come in shows as in the list.
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('says what went wrong when the conversations cannot be listed, and tries again', async () => {
    list.mockResolvedValueOnce({ ok: false, error: 'mu import did not start' });
    render(<Dialog />);
    await settle();
    expect(screen.getByRole('alert').textContent).toContain('mu import did not start');
    expect(screen.queryByPlaceholderText('Search by words or folder')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(screen.getAllByTestId('import-chat-row')).toHaveLength(3);
  });

  it('is framed as the settings dialogs are: the title at the start and a close button', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    await settle();
    const title = screen.getByRole('heading', { name: 'Import conversations' });
    expect(title.closest('.arco-modal')?.classList.contains('aionui-modal-standard')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a search box only once there is something to search', async () => {
    const answers: ((result: Answer<ImportList>) => void)[] = [];
    list.mockReturnValueOnce(new Promise((done) => answers.push(done)));
    render(<Dialog />);
    await settle();
    expect(screen.getByText('Looking for conversations…')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search by words or folder')).toBeNull();
    await act(async () => answers[0]({ ok: true, data: { conversations: found } }));
    expect(screen.getByPlaceholderText('Search by words or folder')).toBeInTheDocument();
  });

  it('says nothing was found on the line where the description starts, with no search box', async () => {
    list.mockResolvedValue({ ok: true, data: { conversations: [] } });
    render(<Dialog />);
    await settle();
    const empty = screen.getByText('No Claude Code or Codex conversations were found on this computer.');
    const hint = screen.getByText(/Each conversation you choose becomes a mu conversation/);
    // Both in the dialog's one column, the empty line not in the list that reaches past it.
    expect(empty.parentElement).toBe(hint.parentElement);
    expect(screen.queryByTestId('import-chats-list')).toBeNull();
    expect(screen.queryByPlaceholderText('Search by words or folder')).toBeNull();
  });
});

describe('an imported conversation', () => {
  const mark = { tool: 'claude-code' as const, source: '/t/0001.jsonl', user: 18, assistant: 204, toolCalls: 1188 };
  const Notice = ({ inline = false }: { inline?: boolean }) => (
    <I18nextProvider i18n={i18n}>
      <ImportedChatNotice conversationId='conv-1' mark={mark} inline={inline} />
    </I18nextProvider>
  );

  it('says where it came from and how much came along', () => {
    render(<Notice />);
    const notice = screen.getByTestId('imported-chat-notice');
    expect(notice.textContent).toContain('Imported from Claude Code');
    expect(notice.textContent).toContain('/t/0001.jsonl');
    expect(notice.textContent).toContain('Your messages: 18 · answers: 204 · tool calls: 1,188');
    expect(notice.textContent).toContain('Just keep going below');
    cleanup();
    render(<Notice inline />);
    expect(screen.getByTestId('imported-chat-notice').textContent).not.toContain('Just keep going below');
  });

  it('reads the earlier conversation back: the person, the answers with their tools, the summaries', async () => {
    history.mockResolvedValue({
      ok: true,
      data: {
        tool: 'claude-code',
        source: '/t/0001.jsonl',
        earlier: 2,
        items: [
          { kind: 'summary', text: 'The form was fixed.' },
          { kind: 'user', text: 'Now add a test' },
          { kind: 'assistant', text: 'Added it.', tools: ['Bash', 'Edit', 'Bash'] },
        ],
      },
    });
    render(<Notice />);
    fireEvent.click(screen.getByRole('button', { name: 'Read the earlier conversation' }));
    await settle();
    expect(history).toHaveBeenCalledWith({ conversationId: 'conv-1' });
    const steps = screen.getAllByTestId('imported-history-step');
    expect(steps.map((step) => step.dataset.kind)).toEqual(['summary', 'user', 'assistant']);
    expect(steps[1].textContent).toContain('You');
    expect(steps[2].textContent).toContain('Claude Code');
    expect(steps[2].textContent).toContain('Used: Bash ×2 and Edit');
    expect(screen.getByText('2 earlier steps are not shown.')).toBeInTheDocument();
  });

  it('reads it back in a dialog framed as the settings dialogs are: the title at the start and a close button', async () => {
    history.mockResolvedValue({
      ok: true,
      data: { tool: 'claude-code', source: '/t/0001.jsonl', earlier: 0, items: [{ kind: 'user', text: 'Hello' }] },
    });
    const onClose = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ImportedHistoryModal conversationId='conv-1' tool='Claude Code' visible onClose={onClose} />
      </I18nextProvider>
    );
    await settle();
    const title = screen.getByRole('heading', { name: 'Earlier, in Claude Code' });
    expect(title.closest('.arco-modal')?.classList.contains('aionui-modal-standard')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
