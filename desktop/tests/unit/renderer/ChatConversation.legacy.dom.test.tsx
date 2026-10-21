import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';
import { BACKEND_APP_SOURCE } from '@/common/platform/backendNames';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';

const usePresetAssistantInfoMock = vi.fn();
const acpChatMock = vi.fn(() => <div data-testid='mock-acp-chat'>acp chat</div>);
const runtimeReady = vi.hoisted(() => ({ current: false }));

vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({
  default: ({ className }: { className?: string }) => <div className={className}>message history</div>,
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  MessageListLoadingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessageListProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessagePaginationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMessageLstCache: vi.fn(),
}));

vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  ConversationArtifactProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/renderer/pages/conversation/components/ChatLayout', () => ({
  default: ({ children, headerExtra }: { children: React.ReactNode; headerExtra?: React.ReactNode }) => (
    <div>
      {headerExtra}
      {children}
    </div>
  ),
}));

vi.mock('@/renderer/pages/conversation/platforms/acp/AcpChat', () => ({
  __esModule: true,
  default: (props: unknown) => acpChatMock(props),
}));

vi.mock('@/renderer/components/agent/AcpRuntimeRestartButton', () => ({
  __esModule: true,
  default: ({ availability }: { availability?: string }) => (
    <div data-testid='mock-runtime-restart' data-availability={availability} />
  ),
}));

vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  classifyConfigSetError: () => 'unknown',
  useAcpConfigOptions: () => ({ isRuntimeReady: runtimeReady.current }),
}));

vi.mock('@/renderer/pages/conversation/components/ChatSlider.tsx', () => ({
  default: () => <div>slider</div>,
}));

vi.mock('@/renderer/pages/cron', () => ({
  CronJobManager: () => <div>cron</div>,
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  resolveAssistantConfigId: () => undefined,
  usePresetAssistantInfo: (...args: unknown[]) => usePresetAssistantInfoMock(...args),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));

function legacyConversation(type: 'gemini' | 'codex' | 'openclaw-gateway' | 'nanobot' | 'remote'): TChatConversation {
  return {
    id: `conv-${type}`,
    user_id: 'user-1',
    name: `${type} history`,
    type,
    model: {},
    extra: { workspace: '/tmp/mu-history' },
    status: 'finished',
    source: BACKEND_APP_SOURCE,
    created_at: 1,
    modified_at: 1,
    pinned: false,
  } as TChatConversation;
}

describe('ChatConversation legacy runtime rendering', () => {
  beforeEach(() => {
    usePresetAssistantInfoMock.mockReset();
    acpChatMock.mockClear();
    runtimeReady.current = false;
    usePresetAssistantInfoMock.mockReturnValue({ info: undefined, isLoading: false });
  });

  it.each(['gemini', 'codex', 'openclaw-gateway', 'nanobot', 'remote'] as const)(
    'renders %s history without the old runtime chat',
    (type) => {
      render(<ChatConversation conversation={legacyConversation(type)} />);

      expect(screen.getByText('message history')).toBeInTheDocument();
      expect(screen.queryByTestId('legacy-openclaw-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-nanobot-chat')).not.toBeInTheDocument();
      expect(screen.queryByTestId('legacy-remote-chat')).not.toBeInTheDocument();
    }
  );

  it('prefers preset assistant backend over legacy extra backend for ACP conversations', () => {
    usePresetAssistantInfoMock.mockReturnValue({
      info: {
        name: 'Research Assistant',
        logo: '📚',
        isEmoji: true,
        backend: 'codex',
        assistantId: 'assistant-research',
      },
      isLoading: false,
    });

    render(
      <ChatConversation
        conversation={
          {
            id: 'conv-acp',
            user_id: 'user-1',
            name: 'ACP history',
            type: 'acp',
            model: {},
            extra: { workspace: '/tmp/mu-history', backend: 'claude' },
            status: 'finished',
            source: BACKEND_APP_SOURCE,
            created_at: 1,
            modified_at: 1,
            pinned: false,
          } as TChatConversation
        }
      />
    );

    expect(screen.getByTestId('mock-acp-chat')).toBeInTheDocument();
    expect(acpChatMock).toHaveBeenCalled();
    expect(acpChatMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        backend: 'codex',
        assistantId: 'assistant-research',
      })
    );
  });

  it('keeps the model picker out of the header of an ACP conversation; the header restarts the runtime once it is ready', () => {
    // The model and its thinking level are the composer's chip; the header carries no second picker.
    const acpConversation = {
      id: 'conv-acp',
      user_id: 'user-1',
      name: 'ACP history',
      type: 'acp',
      model: {},
      extra: { workspace: '/tmp/mu-history', backend: 'claude', current_model_id: 'model-1' },
      status: 'finished',
      source: BACKEND_APP_SOURCE,
      created_at: 1,
      modified_at: 1,
      pinned: false,
    } as TChatConversation;

    const { rerender } = render(<ChatConversation conversation={acpConversation} />);
    expect(screen.getByTestId('mock-runtime-restart').getAttribute('data-availability')).toBe('initializing');

    runtimeReady.current = true;
    rerender(<ChatConversation conversation={acpConversation} />);
    expect(screen.getByTestId('mock-runtime-restart').getAttribute('data-availability')).toBe('ready');
  });

  it('says where an imported conversation came from, above its messages and where a new one greets', () => {
    const mark = { tool: 'codex', source: '/tmp/rollout.jsonl', user: 2, assistant: 3, toolCalls: 4 };
    const conversation = (extra: Record<string, unknown>) =>
      ({
        id: 'conv-imported',
        user_id: 'user-1',
        name: 'Imported',
        type: 'acp',
        model: {},
        extra: { workspace: '/tmp/project', backend: 'kyrn', ...extra },
        status: 'finished',
        created_at: 1,
        modified_at: 1,
        pinned: false,
      }) as TChatConversation;
    type Slots = { headerSlot?: React.ReactElement<Record<string, unknown>> | null; emptySlot?: React.ReactElement };

    render(<ChatConversation conversation={conversation({ mu_import: mark })} />);
    const imported = acpChatMock.mock.calls[0]?.[0] as Slots | undefined;
    expect(imported?.headerSlot?.props).toEqual({ conversationId: 'conv-imported', mark, inline: true });
    expect(imported?.emptySlot?.props).toEqual({ conversationId: 'conv-imported', mark });

    acpChatMock.mockClear();
    render(<ChatConversation conversation={conversation({})} />);
    const plain = acpChatMock.mock.calls[0]?.[0] as Slots | undefined;
    expect(plain?.headerSlot).toBeNull();
  });
});
