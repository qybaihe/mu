import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageAcpPermission } from '@/common/chat/chatLib';
import { muPermissionWording } from '@/renderer/pages/conversation/Messages/acp/muPermissionWording';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import zhCNMu from '@/renderer/services/i18n/locales/zh-CN/mu.json';
import zhTWMu from '@/renderer/services/i18n/locales/zh-TW/mu.json';

const { acpInvoke, words } = vi.hoisted(() => ({
  acpInvoke: vi.fn(),
  // The app's wording in some language other than mu's two (a stand-in: tagged so it cannot pass for mu's text).
  words: {
    value: {
      'mu.permissionsCard.kind.shell': '[ja] run a command',
      'mu.permissionsCard.reason.unsure': '[ja] Jev is not sure',
      'mu.permissionsCard.flagged': '[ja] risky: {{flag}}',
      'mu.permissionsCard.flag.force_push': '[ja] force push',
      'mu.permissionsCard.answer.once': '[ja] once',
      'mu.permissionsCard.answer.sessionFor': '[ja] this conversation ({{grant}})',
      'mu.permissionsCard.answer.deny': '[ja] deny',
      'mu.permissionsCard.decided.once': '[ja] allowed once: {{summary}}',
      'mu.permissionsCard.decided.session': '[ja] allowed for this conversation: {{summary}}',
      'mu.permissionsCard.decided.deny': '[ja] not allowed: {{summary}}',
    } as Record<string, string>,
  },
}));

vi.mock('@/common/adapter/ipcBridge', () => ({ conversation: { confirmMessage: { invoke: acpInvoke } } }));

const translate = (key: string, options?: Record<string, unknown>): string =>
  (words.value[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { exists: (key: string) => key in words.value } }),
}));

import MessageAcpPermission from '@/renderer/pages/conversation/Messages/acp/MessageAcpPermission';

const has = (key: string) => key in words.value;

/** mu's question as the bridge hands it on: mu's own sentences, its codes, and its answers by id. */
const card = (codes: Record<string, string>, extra: Record<string, unknown> = {}): IMessageAcpPermission => ({
  id: 'acp-message-1',
  conversation_id: 'conversation-1',
  type: 'acp_permission',
  position: 'left',
  content: {
    session_id: 'session-1',
    tool_call: {
      tool_call_id: 'permission:ui-1',
      title: 'mu 想运行命令，需要你授权',
      kind: 'execute',
      raw_input: { command: 'git push --force', description: '危险操作：强制推送。', mu: codes, ...extra },
    },
    options: [
      { option_id: 'mu:once', name: '允许这一次', kind: 'allow_once' },
      { option_id: 'mu:session', name: '这次对话都允许（git push）', kind: 'allow_always' },
      { option_id: 'mu:deny', name: '不允许', kind: 'reject_once' },
    ],
  },
});

const FLAGGED = { kind: 'shell', reason: 'flagged', flagCode: 'force_push', grantLabel: 'git push' };

beforeEach(() => acpInvoke.mockReset().mockResolvedValue(undefined));

describe('mu’s permission card', () => {
  it('is worded by mu’s codes in the reader’s language, with the call and the grant as sent', async () => {
    render(<MessageAcpPermission message={card(FLAGGED)} />);
    expect(screen.getByText('[ja] run a command')).toBeInTheDocument();
    expect(screen.getByText('[ja] risky: [ja] force push')).toBeInTheDocument();
    expect(screen.getByText('git push --force')).toBeInTheDocument();
    expect(screen.getByTestId('message-acp-permission-option-mu:once')).toHaveTextContent('[ja] once');
    expect(screen.getByTestId('message-acp-permission-option-mu:session')).toHaveTextContent(
      '[ja] this conversation (git push)'
    );
    expect(screen.getByTestId('message-acp-permission-option-mu:deny')).toHaveTextContent('[ja] deny');
    // No trace of mu's own sentences, nor of the codes as a detail.
    expect(screen.queryByText('mu 想运行命令，需要你授权')).toBeNull();
    expect(screen.queryByText(/flagCode/)).toBeNull();

    fireEvent.click(screen.getByTestId('message-acp-permission-option-mu:session'));
    await vi.waitFor(() =>
      expect(acpInvoke).toHaveBeenCalledWith(expect.objectContaining({ confirm_key: 'mu:session' }))
    );
  });

  it.each([
    ['mu:once', 'allow', '[ja] allowed once: git push --force'],
    ['mu:session', 'allow', '[ja] allowed for this conversation: git push --force'],
    ['mu:deny', 'deny', '[ja] not allowed: git push --force'],
  ])('says what the answer %s decided about the call, once it went through', async (optionId, outcome, said) => {
    render(<MessageAcpPermission message={card(FLAGGED)} />);
    fireEvent.click(screen.getByTestId(`message-acp-permission-option-${optionId}`));
    const status = await screen.findByTestId('message-acp-permission-status');
    expect(status).toHaveTextContent(said);
    expect(status).toHaveAttribute('data-outcome', outcome);
  });

  it('reads mu’s codes as the backend relays them, with the keys snake-cased', () => {
    render(
      <MessageAcpPermission
        message={card({ kind: 'shell', reason: 'flagged', flag_code: 'force_push', grant_label: 'git push' })}
      />
    );
    expect(screen.getByText('[ja] risky: [ja] force push')).toBeInTheDocument();
    expect(screen.getByTestId('message-acp-permission-option-mu:session')).toHaveTextContent(
      '[ja] this conversation (git push)'
    );
  });

  it('keeps mu’s own sentence for a code it has no wording for', () => {
    render(<MessageAcpPermission message={card({ kind: 'teleport', reason: 'flagged', flagCode: 'melts_cpu' })} />);
    expect(screen.getByText('mu 想运行命令，需要你授权')).toBeInTheDocument();
    expect(screen.getByText('危险操作：强制推送。')).toBeInTheDocument();
  });

  it('keeps mu’s own sentences where the app has no wording in this language yet', () => {
    const saved = words.value;
    words.value = {};
    try {
      render(<MessageAcpPermission message={card(FLAGGED)} />);
      expect(screen.getByText('mu 想运行命令，需要你授权')).toBeInTheDocument();
      expect(screen.getByText('危险操作：强制推送。')).toBeInTheDocument();
      expect(screen.getByTestId('message-acp-permission-option-mu:session')).toHaveTextContent(
        '这次对话都允许（git push）'
      );
    } finally {
      words.value = saved;
    }
  });
});

describe('the wording of mu’s permission card', () => {
  it('says why mu asks by the reason, or by the flag for a risky command', () => {
    expect(muPermissionWording({ mu: { kind: 'shell', reason: 'unsure' } }, translate, has)).toMatchObject({
      title: '[ja] run a command',
      description: '[ja] Jev is not sure',
    });
    // A flagged call without a known flag keeps mu's reason; so does a reason the app has no word for.
    expect(
      muPermissionWording({ mu: { kind: 'shell', reason: 'flagged' } }, translate, has)?.description
    ).toBeUndefined();
    expect(
      muPermissionWording({ mu: { kind: 'shell', reason: 'beyond' } }, translate, has)?.description
    ).toBeUndefined();
  });

  it('names only mu’s answers, and the session answer without a grant by its plain key', () => {
    const wording = muPermissionWording({ mu: { kind: 'shell' } }, translate, has);
    expect(wording?.answer('mu:once')).toBe('[ja] once');
    expect(wording?.answer('mu:session')).toBeUndefined(); // no plain `answer.session` in this dictionary
    expect(wording?.answer('mu:always')).toBeUndefined();
    expect(wording?.answer('allow')).toBeUndefined();
    expect(wording?.answer('0')).toBeUndefined();
  });

  it('is nothing for a card without mu’s codes', () => {
    for (const rawInput of [undefined, null, 'text', { command: 'ls' }, { mu: 'shell' }, { mu: ['shell'] }])
      expect(muPermissionWording(rawInput, translate, has)).toBeUndefined();
  });

  it('says what an answer decided only for mu’s answers, and only about a call it names', () => {
    const wording = muPermissionWording({ mu: { kind: 'shell' } }, translate, has);
    expect(wording?.decided('mu:deny', 'rm -rf build')).toBe('[ja] not allowed: rm -rf build');
    expect(wording?.decided('mu:deny', undefined)).toBeUndefined();
    expect(wording?.decided('reject', 'rm -rf build')).toBeUndefined();
    expect(wording?.decided('mu:always', 'rm -rf build')).toBeUndefined();
  });
});

describe('the wording of mu’s permission card in the app’s own languages', () => {
  // Every code the harness sends (its presentation-codes.md, permissions.request), in the three languages that must
  // not lag: the English fallback would otherwise stand in for mu's own Chinese.
  const KINDS = ['edit', 'shell', 'run', 'outside', 'delegate', 'other'];
  // `nojudge` and `judgedown`: Jev mode without a verdict (no judge could answer, or the judge did not this time).
  const REASONS = ['ask', 'unsure', 'beyond', 'unrelated', 'protected', 'nojudge', 'judgedown'];
  const FLAGS = [
    'recursive_or_forced_delete',
    'discards_git_work',
    'force_push',
    'drops_database_objects',
    'overwrites_device',
    'opens_permissions_recursively',
    'runs_downloaded_script',
    'runs_as_administrator',
    'runs_as_root',
  ];

  it.each([
    ['en-US', enMu],
    ['zh-CN', zhCNMu],
    ['zh-TW', zhTWMu],
  ])('has a sentence for every code in %s', (_language, dictionary) => {
    const lookup = (key: string): unknown =>
      key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], {
        mu: dictionary,
      });
    const own = (key: string) => typeof lookup(key) === 'string';
    const say = (key: string, options?: Record<string, unknown>) =>
      String(lookup(key)).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? ''));
    const worded = (codes: Record<string, string>) => muPermissionWording({ mu: codes }, say, own);

    for (const kind of KINDS) expect(worded({ kind })?.title).toBeTruthy();
    for (const reason of REASONS) expect(worded({ kind: 'shell', reason })?.description).toBeTruthy();
    for (const flagCode of FLAGS) {
      const description = worded({ kind: 'shell', reason: 'flagged', flagCode })?.description;
      expect(description).toBeTruthy();
      expect(description).not.toMatch(/\{\{|undefined/);
    }
    const answers = worded({ kind: 'shell', grantLabel: 'git push' });
    for (const id of ['once', 'session', 'deny']) expect(answers?.answer(`mu:${id}`)).toBeTruthy();
    expect(answers?.answer('mu:session')).toContain('git push');
    expect(worded({ kind: 'shell' })?.answer('mu:session')).toBeTruthy();
    for (const id of ['once', 'session', 'deny'])
      expect(answers?.decided(`mu:${id}`, 'rm -rf build')).toContain('rm -rf build');
  });
});
