import React, { type PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import type { IMessageAcpToolCall, TMessage } from '@/common/chat/chatLib';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
} from '@/renderer/pages/conversation/Messages/hooks';
import MessageList from '@/renderer/pages/conversation/Messages/MessageList';
import MessageJudgeLine from '@/renderer/pages/conversation/Messages/acp/MessageJudgeLine';
import { fallbackKind, judgeLine, judgeName } from '@/renderer/pages/conversation/Messages/acp/judgeLine';
import enCommon from '@/renderer/services/i18n/locales/en-US/common.json';
import zhCommon from '@/renderer/services/i18n/locales/zh-CN/common.json';

// The judge's class for a message, as the mu adapter sends it (a tool call with a `jev:` id), is a line of its own.
// The list runs for real; unrelated rows are stubbed, as in the thinking-flow test.

vi.mock('react-i18next', async (original) => {
  const actual = await original<typeof import('react-i18next')>();
  return { ...actual };
});
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ key: 'location-key', state: {} }),
  useNavigate: () => navigate,
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'conversation-1', type: 'acp' }),
}));

vi.mock('@/renderer/pages/team/hooks/TeamPermissionContext', () => ({
  useTeamPermission: () => null,
}));

let mockIsProcessing = true;
vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({ isProcessing: mockIsProcessing, hydrated: true }),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  useConversationArtifacts: () => [],
}));

vi.mock('@/renderer/pages/conversation/Messages/useAutoScroll', () => ({
  useAutoScroll: () => ({
    handleScrollerRef: () => {},
    handleContentRef: () => {},
    handleScroll: () => {},
    handleWheel: () => {},
    handlePointerDown: () => {},
    showScrollButton: false,
    scrollToBottom: () => {},
    scrollElementIntoView: () => {},
    hideScrollButton: () => {},
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/components/MessageText', () => ({
  default: ({ message }: { message: { content: { content: string } } }) => <div>{message.content.content}</div>,
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageTips', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroup', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageAgentStatus', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessagePermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpPermission', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpToolCall', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/acp/MessageAcpTerminalOutput', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageQuestion', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageCronTrigger', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageSkillSuggest', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/components/SelectionReplyButton', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/anchorRail', () => ({ MessageAnchorRail: () => null }));
vi.mock('@/renderer/pages/conversation/Messages/MessageFileChanges', () => ({
  __esModule: true,
  default: () => null,
  parseDiff: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Messages/components/MessageToolGroupSummary', () => ({
  default: ({ messages }: { messages: IMessageAcpToolCall[] }) => (
    <div data-testid='tool-summary'>{messages.map((message) => message.id).join(',')}</div>
  ),
}));

afterEach(cleanup);

let created = 0;
const call = (id: string, update: Record<string, unknown>): IMessageAcpToolCall =>
  ({
    id,
    msg_id: id,
    conversation_id: 'conversation-1',
    type: 'acp_tool_call',
    position: 'left',
    created_at: ++created,
    content: {
      session_id: 'session-1',
      update: { sessionUpdate: 'tool_call_update', tool_call_id: id, status: 'completed', kind: 'execute', ...update },
    },
  }) as IMessageAcpToolCall;
const preflight = (update: Record<string, unknown>) => call('jev:runtime-1:3', update);

describe('reading the judge’s class from the tool call the adapter sends', () => {
  it('reads the stage the adapter marks in rawOutput, whatever the title says', () => {
    expect(
      judgeLine(preflight({ title: 'Jev · Classifying', status: 'completed', rawOutput: { preflight: 'pending' } }))
    ).toEqual({
      stage: 'classifying',
      judge: '',
    });
    expect(
      judgeLine(
        preflight({
          title: 'Jev · chat',
          rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest', preflight: 'verdict' },
        })
      )
    ).toEqual({ stage: 'classified', turnType: 'chat', state: 'applied', byRule: false, judge: 'jev-latest' });
    // An earlier adapter's fallback title is spelled "Jev", and its class is no turn type: the wait ran out.
    expect(judgeLine(preflight({ title: 'Jev · Fallback', rawOutput: { preflight: 'fallback' } }))).toEqual({
      stage: 'fallback',
      why: 'unanswered',
      judge: '',
    });
    expect(
      judgeLine(preflight({ title: 'Jev · Default', rawOutput: { preflight: 'verdict', state: 'applied' } }))
    ).toEqual({
      stage: 'fallback',
      why: 'unsure',
      judge: '',
    });
  });

  it('names the judge that was asked or answered: the wait’s judge, the verdict’s by, never a rule', () => {
    expect(
      judgeLine(
        preflight({
          title: 'Jev · Classifying',
          status: 'in_progress',
          rawOutput: { preflight: 'pending', judge: 'laya' },
        })
      )
    ).toEqual({ stage: 'classifying', judge: 'laya' });
    expect(
      judgeLine(preflight({ title: 'Jev · chat', rawOutput: { preflight: 'verdict', turnType: 'chat', by: 'clm-8b' } }))
    ).toMatchObject({ stage: 'classified', judge: 'clm-8b' });
    // The adapter adds the judge it asked to a wait that ran out.
    expect(
      judgeLine(preflight({ title: 'Jev · Fallback', rawOutput: { preflight: 'fallback', judge: 'laya>jev-latest' } }))
    ).toEqual({ stage: 'fallback', why: 'unanswered', judge: 'laya>jev-latest' });
    expect(
      judgeLine(preflight({ title: 'Jev · chat', rawOutput: { preflight: 'verdict', turnType: 'chat', by: 'rule' } }))
    ).toMatchObject({ byRule: true, judge: '' });
  });

  it('tells a judge that did not answer from one that was not sure, from none at all, from a quiet one', () => {
    const verdict = (fields: Record<string, unknown>) =>
      judgeLine(
        preflight({
          title: 'Jev · Default',
          rawOutput: { preflight: 'verdict', turnType: 'unknown', state: 'none', ...fields },
        })
      );
    expect(verdict({ reasonCode: 'error:auth', reason: 'HTTP 401' })).toEqual({ stage: 'noJudge' });
    expect(verdict({ reason_code: 'error:timeout' })).toEqual({ stage: 'fallback', why: 'unanswered', judge: '' });
    expect(verdict({ reason: 'no answer after 6.0 s', by: 'laya' })).toEqual({
      stage: 'fallback',
      why: 'unanswered',
      judge: 'laya',
    });
    expect(verdict({ reasonCode: 'abstain' })).toEqual({ stage: 'fallback', why: 'unsure', judge: '' });
    expect(verdict({ reasonCode: 'off' })).toEqual({ stage: 'quiet' });
    expect(verdict({ reason: 'skipped' })).toEqual({ stage: 'quiet' });
    // The hints still come with a line that has no judge.
    expect(verdict({ reasonCode: 'error:auth', hintIds: ['answered'] })).toEqual({
      stage: 'noJudge',
      hints: ['answered'],
    });
  });

  it('is only a jev: call, classifying while it runs', () => {
    expect(judgeLine(call('bash-1', { title: 'bash' }))).toBeUndefined();
    expect(judgeLine({ ...call('x', {}), type: 'text' } as unknown as TMessage)).toBeUndefined();
    expect(judgeLine(preflight({ title: 'Jev · Classifying', status: 'in_progress' }))).toEqual({
      stage: 'classifying',
      judge: '',
    });
  });

  it('takes the class and its state from the verdict, and from the title when the verdict is not kept', () => {
    expect(
      judgeLine(preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest' } }))
    ).toEqual({
      stage: 'classified',
      turnType: 'chat',
      state: 'applied',
      byRule: false,
      judge: 'jev-latest',
    });
    expect(
      judgeLine(
        preflight({ title: 'Jev · research', raw_output: { turnType: 'research', state: 'shadow', by: 'rule' } })
      )
    ).toMatchObject({
      turnType: 'research',
      state: 'shadow',
      byRule: true,
    });
    expect(judgeLine(preflight({ title: 'Jev · single_edit' }))).toMatchObject({
      stage: 'classified',
      turnType: 'single_edit',
      state: 'applied',
    });
  });

  it('takes the hints the main model was given, in their order, each once, and only the ones it has words for', () => {
    // The verdict as the harness sends it again once the turn has started (presentation-codes.md, preflight.verdict).
    expect(
      judgeLine(
        preflight({
          title: 'Jev · multi_step_task',
          rawOutput: {
            turnType: 'multi_step_task',
            state: 'applied',
            preflight: 'verdict',
            hintIds: ['plan_first', 'a_hint_from_a_newer_harness', 'try_delegate', 'plan_first'],
          },
        })
      )
    ).toEqual({
      stage: 'classified',
      turnType: 'multi_step_task',
      state: 'applied',
      byRule: false,
      judge: '',
      hints: ['plan_first', 'try_delegate'],
    });
    // The relay may have snake_cased the key; a rule's hint comes even when the judge gave no class.
    expect(
      judgeLine(
        preflight({ title: 'Jev · Default', rawOutput: { turnType: 'unknown', state: 'none', hint_ids: ['answered'] } })
      )
    ).toEqual({ stage: 'fallback', why: 'unsure', judge: '', hints: ['answered'] });
    // No hint, no field: a line without hints reads as it always did.
    expect(
      judgeLine(preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'applied', hintIds: [] } }))
    ).toEqual({ stage: 'classified', turnType: 'chat', state: 'applied', byRule: false, judge: '' });
    expect(
      judgeLine(
        preflight({ title: 'Jev · Classifying', status: 'in_progress', rawOutput: { hintIds: ['plan_first'] } })
      )
    ).toEqual({ stage: 'classifying', judge: '' });
  });

  it('is a fallback when no class came: the wait ended, the class is unknown, or there was no verdict', () => {
    // A row recorded before the stages were marked: the wait ran out, so the judge did not answer.
    expect(judgeLine(preflight({ title: 'Jev · Fallback' }))).toEqual({
      stage: 'fallback',
      why: 'unanswered',
      judge: '',
    });
    expect(
      judgeLine(preflight({ title: 'Jev · Default', rawOutput: { turnType: 'unknown', state: 'applied' } }))
    ).toEqual({
      stage: 'fallback',
      why: 'unsure',
      judge: '',
    });
    expect(judgeLine(preflight({ title: 'Jev · Default', rawOutput: { turnType: 'unknown', state: 'none' } }))).toEqual(
      {
        stage: 'fallback',
        why: 'unsure',
        judge: '',
      }
    );
  });
});

describe('the judge’s name and why no class came', () => {
  it('names Jev, Laya and CLM by their labels, a cascade by its first tier, and Jev when none is named', () => {
    expect(judgeName('jev-latest')).toBe('Jev');
    expect(judgeName('openrouter/jev-latest')).toBe('Jev');
    expect(judgeName('laya')).toBe('Laya');
    expect(judgeName('laya>jev-latest')).toBe('Laya');
    expect(judgeName('clm-8b')).toBe('CLM');
    expect(judgeName('')).toBe('Jev');
    expect(judgeName(undefined)).toBe('Jev');
    expect(judgeName('my-own-judge')).toBe('my-own-judge');
  });

  it('reads a refused key as no judge, a failure or a wait as no answer, and off or skipped as nothing to say', () => {
    expect(fallbackKind('error:auth')).toBe('noJudge');
    for (const reason of ['no_answer', 'timeout', 'error:timeout', 'error:network', 'error:server']) {
      expect(fallbackKind(reason)).toBe('unanswered');
    }
    expect(fallbackKind('off')).toBe('quiet');
    expect(fallbackKind('skipped')).toBe('quiet');
    expect(fallbackKind('abstain')).toBe('unsure');
    expect(fallbackKind('')).toBe('unsure');
  });
});

const showLine = (lng: 'zh' | 'en', message: IMessageAcpToolCall) => {
  const i18n = createInstance();
  void i18n.init({
    lng,
    resources: { zh: { translation: { common: zhCommon } }, en: { translation: { common: enCommon } } },
    interpolation: { escapeValue: false },
  });
  const line = judgeLine(message);
  if (!line) throw new Error('not a judge line');
  return render(
    <I18nextProvider i18n={i18n}>
      <MessageJudgeLine line={line} />
    </I18nextProvider>
  );
};

describe('the line, in the language of the app', () => {
  it('says what the judge made of the message, in Chinese and in English', () => {
    const chat = preflight({
      title: 'Jev · chat',
      rawOutput: { turnType: 'chat', state: 'applied', by: 'jev-latest' },
    });
    const zh = showLine('zh', chat);
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Jev 归类为闲聊$/);
    zh.unmount();
    showLine('en', chat);
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Classified by Jev: Conversation$/);
  });

  it('keeps shadow, late, rule and fallback apart', () => {
    const { unmount } = showLine(
      'zh',
      preflight({ title: 'Jev · research', rawOutput: { turnType: 'research', state: 'shadow' } })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent('Jev 归类为调研（仅观察，没有生效）');
    unmount();
    const late = showLine('zh', preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'late' } }));
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent('（来晚了，这一轮没用上）');
    late.unmount();
    const rule = showLine(
      'zh',
      preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'applied', by: 'rule' } })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent('按规则归类为闲聊');
    rule.unmount();
    const none = showLine('en', preflight({ title: 'Jev · Fallback' }));
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Jev didn't answer this time; continuing as usual$/);
    none.unmount();
    const unsure = showLine(
      'en',
      preflight({ title: 'Jev · Default', rawOutput: { preflight: 'verdict', state: 'applied' } })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(
      /^Jev gave no clear answer this time; continuing as usual$/
    );
    unsure.unmount();
    showLine('zh', preflight({ title: 'Jev · Classifying', status: 'in_progress' }));
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent('Jev 正在归类…');
  });

  it('names the judge that answered or was asked: Laya, CLM, the first tier of a cascade', () => {
    const laya = showLine(
      'zh',
      preflight({
        title: 'Jev · chat',
        rawOutput: { preflight: 'verdict', turnType: 'chat', state: 'applied', by: 'laya' },
      })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Laya 归类为闲聊$/);
    laya.unmount();
    const clm = showLine(
      'en',
      preflight({
        title: 'Jev · Classifying',
        status: 'in_progress',
        rawOutput: { preflight: 'pending', judge: 'clm-8b' },
      })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^CLM is classifying this message…$/);
    clm.unmount();
    showLine(
      'zh',
      preflight({ title: 'Jev · Fallback', rawOutput: { preflight: 'fallback', judge: 'laya>jev-latest' } })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Laya 这次没有回答，按默认方式继续$/);
  });

  it('says there is no judge when its key was refused, and leads to the judges’ settings', () => {
    navigate.mockClear();
    const refused = preflight({
      title: 'Jev · Default',
      rawOutput: { preflight: 'verdict', turnType: 'unknown', state: 'none', reasonCode: 'error:auth' },
    });
    const zh = showLine('zh', refused);
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^还没有可用的判定器，消息不会被归类。设置判定器$/);
    zh.unmount();
    showLine('en', refused);
    expect(screen.getByTestId('mu-judge-line')).toHaveAttribute('data-stage', 'noJudge');
    expect(screen.getByTestId('mu-judge-line')).not.toHaveTextContent(/Jev|auth|401/);
    fireEvent.click(screen.getByTestId('mu-judge-setup'));
    expect(navigate).toHaveBeenCalledWith('/settings/judges');
  });

  it('shows nothing for a classification that is switched off', () => {
    const { container } = showLine(
      'en',
      preflight({ title: 'Jev · Default', rawOutput: { preflight: 'verdict', turnType: 'unknown', reasonCode: 'off' } })
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('follows the line with the hints the main model was given, each with its whole sentence on hover', () => {
    const planned = preflight({
      title: 'Jev · multi_step_task',
      rawOutput: { turnType: 'multi_step_task', state: 'applied', hintIds: ['plan_first', 'try_delegate'] },
    });
    const zh = showLine('zh', planned);
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(
      `Jev 归类为${zhCommon.kyrn.judgeView.values.multi_step_task}${zhCommon.kyrn.judgeView.hintChips.plan_first}${zhCommon.kyrn.judgeView.hintChips.try_delegate}`
    );
    const chips = screen.getAllByTestId('mu-judge-hint');
    expect(chips.map((chip) => chip.getAttribute('data-hint'))).toEqual(['plan_first', 'try_delegate']);
    expect(chips[0]).toHaveAttribute('title', zhCommon.kyrn.judgeView.hints.plan_first);
    zh.unmount();

    const en = showLine('en', planned);
    expect(screen.getAllByTestId('mu-judge-hint').map((chip) => chip.textContent)).toEqual([
      enCommon.kyrn.judgeView.hintChips.plan_first,
      enCommon.kyrn.judgeView.hintChips.try_delegate,
    ]);
    en.unmount();

    // A reply to the agent's own question gets its hint even when the judge gave no class.
    const replied = showLine(
      'en',
      preflight({
        title: 'Jev · unknown',
        rawOutput: { turnType: 'unknown', state: 'none', preflight: 'verdict', hintIds: ['answered'] },
      })
    );
    expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(
      `Jev gave no clear answer this time; continuing as usual${enCommon.kyrn.judgeView.hintChips.answered}`
    );
    replied.unmount();

    showLine('en', preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'applied' } }));
    expect(screen.queryByTestId('mu-judge-hint')).not.toBeInTheDocument();
  });

  it('names a class it has no word for as "other", never by its raw id', () => {
    // A class a newer harness added, and a word that is a judge value but no class.
    for (const turnType of ['pair_programming', 'shadow']) {
      const message = preflight({
        title: `Jev · ${turnType}`,
        rawOutput: { turnType, state: 'applied', preflight: 'verdict' },
      });
      const zh = showLine('zh', message);
      expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Jev 归类为其他$/);
      zh.unmount();
      const en = showLine('en', message);
      expect(screen.getByTestId('mu-judge-line')).toHaveTextContent(/^Classified by Jev: Other$/);
      en.unmount();
    }
  });
});

function Wrapper({ children, messages }: PropsWithChildren<{ messages: TMessage[] }>): JSX.Element {
  return (
    <MessageListLoadingProvider value={false}>
      <MessagePaginationProvider
        value={{ hasMoreBefore: false, hasMoreAfter: false, isLoadingBefore: false, isLoadingAnchor: false }}
      >
        <MessageListProvider value={messages}>{children}</MessageListProvider>
      </MessagePaginationProvider>
    </MessageListLoadingProvider>
  );
}

describe('in the conversation', () => {
  it('is one line of its own, and the tool box keeps only the real tools', () => {
    const messages: TMessage[] = [
      preflight({ title: 'Jev · chat', rawOutput: { turnType: 'chat', state: 'applied' } }),
      call('bash-1', { title: 'bash' }),
      call('read-1', { title: 'read', kind: 'read' }),
    ];
    render(<MessageList />, { wrapper: ({ children }) => <Wrapper messages={messages}>{children}</Wrapper> });
    expect(screen.getAllByTestId('mu-judge-line')).toHaveLength(1);
    expect(screen.getByTestId('tool-summary')).toHaveTextContent(/^bash-1,read-1$/);
  });

  it('says once that there is no judge, not under every message, and nothing for a switched-off one', () => {
    const refused = { preflight: 'verdict', turnType: 'unknown', state: 'none', reasonCode: 'error:auth' };
    const messages: TMessage[] = [
      call('jev:runtime-1:1', { title: 'Jev · Default', rawOutput: refused }),
      call('bash-1', { title: 'bash' }),
      call('jev:runtime-1:2', { title: 'Jev · Default', rawOutput: refused }),
      call('jev:runtime-1:3', { title: 'Jev · Default', rawOutput: { ...refused, reasonCode: 'off' } }),
      call('jev:runtime-1:4', { title: 'Jev · Fallback', rawOutput: { preflight: 'fallback' } }),
    ];
    render(<MessageList />, { wrapper: ({ children }) => <Wrapper messages={messages}>{children}</Wrapper> });
    expect(screen.getAllByTestId('mu-judge-line').map((line) => line.getAttribute('data-stage'))).toEqual([
      'noJudge',
      'fallback',
    ]);
    expect(screen.getAllByTestId('mu-judge-setup')).toHaveLength(1);
  });

  it('shows a notice of the bridge as a line of its own too, never in the tool box', () => {
    const messages: TMessage[] = [
      call('bash-1', { title: 'bash' }),
      call('mu:notice:1', {
        sessionUpdate: 'tool_call',
        title: "mu didn't receive your answer, so it continued as if you had declined.",
        raw_input: { notice: 'answer_lost' },
      }),
    ];
    render(<MessageList />, { wrapper: ({ children }) => <Wrapper messages={messages}>{children}</Wrapper> });
    expect(screen.getAllByTestId('mu-notice')).toHaveLength(1);
    expect(screen.getByTestId('tool-summary')).toHaveTextContent(/^bash-1$/);
  });
});
