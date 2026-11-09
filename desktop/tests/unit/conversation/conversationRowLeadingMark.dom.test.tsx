/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import type { ConversationLeadingMark } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';

const mark = vi.hoisted(() => ({ value: { kind: 'assistant_fallback', label: 'mu' } as ConversationLeadingMark }));
const layout = vi.hoisted(() => ({ isMobile: false }));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: null }),
}));
vi.mock('@/renderer/utils/model/agentLogo', () => ({ useAgentLogos: () => ({}) }));
vi.mock('@/renderer/pages/cron', () => ({
  CronJobIndicator: ({ status }: { status: string }) => <span data-testid='cron-indicator'>{status}</span>,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => layout }));
vi.mock('@/renderer/pages/conversation/utils/conversationAssistantIdentity', () => ({
  resolveConversationLeadingMark: () => mark.value,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import type { ConversationRowProps } from '@/renderer/pages/conversation/GroupedHistory/types';

const conversation = (extra: Record<string, unknown> = {}, name = '做一个harness需要注意什么') =>
  ({
    id: 'conv-1',
    name,
    type: 'acp',
    created_at: 1,
    modified_at: 1,
    extra,
  }) as unknown as TChatConversation;

const baseProps: ConversationRowProps = {
  conversation: conversation(),
  isGenerating: false,
  isWaitingConfirmation: false,
  hasUnread: false,
  isManualUnread: false,
  collapsed: false,
  tooltipEnabled: false,
  batchMode: false,
  checked: false,
  selected: false,
  menuVisible: false,
  onToggleChecked: vi.fn(),
  onConversationClick: vi.fn(),
  onOpenMenu: vi.fn(),
  onMenuVisibleChange: vi.fn(),
  onEditStart: vi.fn(),
  onCreateCronTask: vi.fn(),
  onArchive: vi.fn(),
  onTogglePin: vi.fn(),
  onToggleManualUnread: vi.fn(),
  getJobStatus: () => 'none',
};

const renderRow = (props: Partial<ConversationRowProps> = {}) => render(<ConversationRow {...baseProps} {...props} />);
const row = (container: HTMLElement) => container.querySelector('#c-conv-1') as HTMLElement;
const leading = () => screen.queryByTestId('conversation-leading-conv-1');
const trailing = () => screen.queryByTestId('conversation-status-conv-1');

beforeEach(() => {
  mark.value = { kind: 'assistant_fallback', label: 'mu' };
  layout.isMobile = false;
});

describe('a conversation without an avatar in the sidebar', () => {
  it('shows its title alone: no stand-in robot or chat bubble', () => {
    for (const value of [
      { kind: 'assistant_fallback', label: 'mu' },
      { kind: 'fallback', label: 'acp' },
    ] as ConversationLeadingMark[]) {
      mark.value = value;
      const { container, unmount } = renderRow();
      expect(leading()).toBeNull();
      expect(container.querySelector('.i-icon-robot, .i-icon-message-one')).toBeNull();
      expect(screen.getByText('做一个harness需要注意什么')).toBeInTheDocument();
      // Lined up with the section label, and inside a project with the project's name.
      expect(row(container).className).toContain('ps-12px');
      unmount();
      const inProject = renderRow({ dimIcon: true });
      expect(row(inProject.container).className).toContain('ps-40px');
      inProject.unmount();
    }
  });

  it('shows a live turn at the end of the row, so the title does not move', () => {
    const { container, rerender } = renderRow({ isGenerating: true });
    expect(leading()).toBeNull();
    expect(trailing()?.querySelector('.arco-spin')).not.toBeNull();
    expect(row(container).className).toContain('pe-32px');

    // Waiting on the user wins over the spinner, as before.
    rerender(<ConversationRow {...baseProps} isGenerating isWaitingConfirmation />);
    expect(trailing()).toContainElement(screen.getByTestId('conversation-waiting-confirmation-conv-1'));
    expect(container.querySelector('.arco-spin')).toBeNull();

    // The row's menu opens where the status is.
    rerender(<ConversationRow {...baseProps} isGenerating menuVisible />);
    expect(trailing()).toBeNull();
    // Selection mode shows no status, and an idle row none either.
    rerender(<ConversationRow {...baseProps} isGenerating batchMode />);
    expect(trailing()).toBeNull();
    rerender(<ConversationRow {...baseProps} />);
    expect(trailing()).toBeNull();
    expect(row(container).className).toContain('pe-16px');
  });

  it('keeps its status clear of the menu on mobile, where the menu always shows', () => {
    layout.isMobile = true;
    renderRow({ isGenerating: true, menuVisible: true });
    expect(trailing()?.className).toContain('end-32px');
  });

  it('shows the first character of its title when the sidebar is collapsed', () => {
    renderRow({ collapsed: true, isGenerating: false, conversation: conversation({}, '  hello there') });
    expect(leading()).toContainElement(screen.getByTestId('conversation-initial-conv-1'));
    expect(screen.getByTestId('conversation-initial-conv-1')).toHaveTextContent('H');
    // Collapsed, the leading slot is the whole row, so a live turn shows there.
    const { unmount } = renderRow({ collapsed: true, isGenerating: true });
    expect(screen.getAllByTestId('conversation-leading-conv-1')[1].querySelector('.arco-spin')).not.toBeNull();
    unmount();
  });

  it('shows its scheduled task at its end, so the title stays put when the tasks load after the list', () => {
    // The scheduled tasks load after the conversation list: first 'none', then the job's status.
    const { container, rerender } = renderRow();
    expect(row(container).className).toContain('ps-12px');
    rerender(<ConversationRow {...baseProps} getJobStatus={() => 'active'} />);
    expect(leading()).toBeNull();
    expect(row(container).className).toContain('ps-12px');
    expect(trailing()).toContainElement(screen.getByTestId('cron-indicator'));
    expect(row(container).className).toContain('pe-32px');

    // A live turn and the unread dot take the place first.
    rerender(<ConversationRow {...baseProps} getJobStatus={() => 'active'} isGenerating />);
    expect(trailing()?.querySelector('.arco-spin')).not.toBeNull();
    expect(screen.queryByTestId('cron-indicator')).toBeNull();
    rerender(<ConversationRow {...baseProps} getJobStatus={() => 'active'} hasUnread />);
    expect(trailing()).toBeNull();
    expect(container.querySelector('.h-8px.w-8px')).not.toBeNull();
    // Selecting rows keeps it; nothing opens over it there.
    rerender(<ConversationRow {...baseProps} getJobStatus={() => 'active'} batchMode />);
    expect(trailing()).toContainElement(screen.getByTestId('cron-indicator'));
    expect(trailing()?.className).not.toContain('group-hover:hidden');
  });

  it('goes by the name the command palette gives it while nothing has named it, never a blank row', () => {
    for (const name of ['', '   ']) {
      const { container, unmount } = renderRow({ conversation: conversation({}, name) });
      expect(row(container)).toHaveTextContent('conversation.welcome.newConversation');
      unmount();
    }
    renderRow({ collapsed: true, conversation: conversation({}, '') });
    // Collapsed, its initial comes from that name too.
    expect(screen.getByTestId('conversation-initial-conv-1')).toHaveTextContent('C');
  });

  it('keeps a pin where its drag handle appears when it is pinned', () => {
    const { container } = renderRow({ conversation: conversation({ pinned: true }) });
    expect(leading()?.querySelector('.i-icon-pushpin')).not.toBeNull();
    expect(container.querySelector('.i-icon-robot')).toBeNull();
    expect(row(container).className).toContain('ps-10px');
  });

  it('uses regular weight at rest and medium primary weight when selected or unread', () => {
    const { container, rerender } = renderRow({ selected: false, hasUnread: false });
    const titleBox = () => container.querySelector('.chat-history__item-name') as HTMLElement;
    expect(titleBox().className).toContain('font-[400]');
    expect(titleBox().className).toContain('text-t-secondary');

    rerender(<ConversationRow {...baseProps} selected />);
    expect(titleBox().className).toContain('font-[500]');
    expect(titleBox().className).toContain('text-t-primary');

    rerender(<ConversationRow {...baseProps} selected={false} hasUnread />);
    expect(titleBox().className).toContain('font-[500]');
    expect(titleBox().className).toContain('text-t-primary');
  });
});

describe('a conversation with a mark in the sidebar', () => {
  it('keeps its avatar, and a live turn replaces it in place', () => {
    mark.value = { kind: 'emoji', value: '🦊', label: 'Fox' };
    const { rerender } = renderRow();
    expect(leading()).toHaveTextContent('🦊');
    rerender(<ConversationRow {...baseProps} isGenerating />);
    expect(leading()?.querySelector('.arco-spin')).not.toBeNull();
    expect(trailing()).toBeNull();
  });

  it('shows its scheduled task in place of the avatar, as before', () => {
    mark.value = { kind: 'emoji', value: '🦊', label: 'Fox' };
    renderRow({ getJobStatus: () => 'active' });
    expect(leading()).toContainElement(screen.getByTestId('cron-indicator'));
    expect(trailing()).toBeNull();
  });
});
