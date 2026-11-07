/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { layoutState } = vi.hoisted(() => ({
  layoutState: { isMobile: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      listAvailableSkills: { invoke: vi.fn().mockResolvedValue([]) },
      listWorkspaceFiles: { invoke: vi.fn().mockResolvedValue([]) },
    },
  },
}));

vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({
    conversation_id: 'sendbox-active-focus-conversation',
    type: 'acp',
  }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: layoutState.isMobile }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: [],
    removeDomSnippet: vi.fn(),
    clearDomSnippets: vi.fn(),
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
}));

vi.mock('@/renderer/hooks/file/useConversationExport', () => ({
  useConversationExport: () => ({
    isOpen: false,
    showMenu: false,
    step: 'menu',
    filename: '',
    pathPreview: '',
    menuItems: [],
    activeIndex: 0,
    loading: false,
    openExportFlow: vi.fn(),
    closeExportFlow: vi.fn(),
    handleKeyDown: vi.fn(),
    onSelectMenuItem: vi.fn(),
    setActiveIndex: vi.fn(),
    setFilename: vi.fn(),
    submitFilename: vi.fn(),
  }),
}));

vi.mock('@/renderer/components/chat/BtwOverlay/useBtwCommand', () => ({
  useBtwCommand: () => ({
    answer: '',
    question: '',
    isLoading: false,
    isOpen: false,
    ask: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@/renderer/hooks/file/useDragUpload', () => ({
  useDragUpload: () => ({ isFileDragging: false, dragHandlers: {} }),
}));

vi.mock('@/renderer/hooks/file/usePasteService', () => ({
  usePasteService: () => ({ onPaste: vi.fn(), onFocus: vi.fn() }),
}));

vi.mock('@/renderer/hooks/file/useUploadState', () => ({
  useUploadState: () => ({ isUploading: false }),
}));

vi.mock('@/renderer/hooks/file/useAbortUploadsOnConversationChange', () => ({
  useAbortUploadsOnConversationChange: vi.fn(),
}));

vi.mock('@/renderer/utils/emitter', () => ({
  emitter: { emit: vi.fn() },
  useAddEventListener: vi.fn(),
}));

vi.mock('@/renderer/components/chat/BtwOverlay', () => ({ default: () => null }));
vi.mock('@/renderer/components/media/UploadProgressBar', () => ({ default: () => null }));

import SendBox from '@/renderer/components/chat/SendBox';

const SendBoxHarness = ({
  active,
  onFocused,
  disabled,
  initialValue = '',
  onSend = vi.fn().mockResolvedValue(undefined),
  onAddToDraft,
  onStop,
  loading,
}: {
  active?: boolean;
  onFocused?: () => void;
  disabled?: boolean;
  initialValue?: string;
  onSend?: (message: string) => Promise<void | false>;
  onAddToDraft?: () => void;
  onStop?: () => Promise<void>;
  loading?: boolean;
}) => {
  const [value, setValue] = useState(initialValue);
  return (
    <SendBox
      value={value}
      onChange={setValue}
      onSend={onSend}
      active={active}
      onFocused={onFocused}
      disabled={disabled}
      onAddToDraft={onAddToDraft}
      onStop={onStop}
      loading={loading}
      allowSendWhileLoading={loading}
      compactActions={false}
    />
  );
};

describe('SendBox while a run is going', () => {
  it('keeps stop beside send once a message is written, so the run can be stopped without losing it', () => {
    layoutState.isMobile = false;
    const { rerender } = render(<SendBoxHarness loading onStop={vi.fn().mockResolvedValue(undefined)} />);
    expect(screen.getByTestId('sendbox-stop-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('sendbox-send-btn')).toBeNull();

    rerender(<SendBoxHarness loading initialValue='steer this' onStop={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.change(screen.getByTestId('sendbox-input'), { target: { value: 'steer this' } });
    expect(screen.getByTestId('sendbox-stop-btn')).toBeInTheDocument();
    expect(screen.getByTestId('sendbox-send-btn')).toBeInTheDocument();
  });

  it('stops on Esc when the box is empty, and keeps Esc for a written message', () => {
    layoutState.isMobile = false;
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(<SendBoxHarness loading onStop={onStop} />);
    const textarea = screen.getByTestId('sendbox-input');

    fireEvent.change(textarea, { target: { value: 'half written' } });
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.keyDown(textarea, { key: 'Escape', code: 'Escape' });
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('does nothing on Esc when nothing is running', () => {
    layoutState.isMobile = false;
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(<SendBoxHarness onStop={onStop} />);
    fireEvent.keyDown(screen.getByTestId('sendbox-input'), { key: 'Escape', code: 'Escape' });
    expect(onStop).not.toHaveBeenCalled();
  });

  it('gives focus back to the text after stop is clicked', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness loading active={false} onStop={vi.fn().mockResolvedValue(undefined)} />);
    const stop = screen.getByTestId('sendbox-stop-btn');
    stop.focus();
    await act(async () => {
      fireEvent.click(stop);
    });
    await waitFor(() => expect(screen.getByTestId('sendbox-input')).toHaveFocus());
  });

  it('gives focus back to the text after a message is sent with the button', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness active={false} initialValue='hello' />);
    const send = screen.getByTestId('sendbox-send-btn');
    send.focus();
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByTestId('sendbox-input')).toHaveFocus());
  });
});

describe('SendBox active-controlled focus', () => {
  it('keeps Enter mapped to Send while Draft box has its own icon action', async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onAddToDraft = vi.fn();

    render(<SendBoxHarness initialValue='queued draft' onSend={onSend} onAddToDraft={onAddToDraft} />);
    fireEvent.click(screen.getByTestId('sendbox-add-to-draft-btn'));

    expect(onAddToDraft).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();

    const textarea = screen.getByTestId('sendbox-input');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('queued draft');
  });

  it('restores the input when the parent blocks sending', async () => {
    const onSend = vi.fn().mockResolvedValue(false);

    render(<SendBoxHarness initialValue='blocked message' onSend={onSend} />);

    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('blocked message');
    await waitFor(() => expect(textarea.value).toBe('blocked message'));
  });

  it('uses the platform primary Enter shortcut for Draft box without sending', () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    const onAddToDraft = vi.fn();

    render(<SendBoxHarness initialValue='save this for later' onSend={onSend} onAddToDraft={onAddToDraft} />);

    const textarea = screen.getByTestId('sendbox-input');
    fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', ctrlKey: true });

    expect(onAddToDraft).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('focuses the textarea on mount when active is true (desktop)', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness active={true} />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('focuses on mount when active is omitted (default true, preserves single-conversation behavior)', async () => {
    layoutState.isMobile = false;
    render(<SendBoxHarness />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('does NOT focus on mount when active is false', async () => {
    layoutState.isMobile = false;
    render(
      <div>
        <button type='button'>outside</button>
        <SendBoxHarness active={false} />
      </div>
    );
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'outside' }).focus();
    await waitFor(() => expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus());
    expect(textarea).not.toHaveFocus();
  });

  it('does not force focus on mobile even when active', async () => {
    layoutState.isMobile = true;
    render(
      <div>
        <button type='button'>outside</button>
        <SendBoxHarness active={true} />
      </div>
    );
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'outside' }).focus();
    expect(textarea).not.toHaveFocus();
  });

  it('calls onFocused when the textarea gains focus', () => {
    layoutState.isMobile = false;
    const onFocused = vi.fn();
    render(<SendBoxHarness active={false} onFocused={onFocused} />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
    });
    expect(onFocused).toHaveBeenCalledTimes(1);
  });
});

describe('SendBox selection→focus downward effect', () => {
  it('focuses when active transitions false→true', async () => {
    layoutState.isMobile = false;
    const { rerender } = render(<SendBoxHarness active={false} />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    expect(textarea).not.toHaveFocus();
    rerender(<SendBoxHarness active={true} />);
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('focuses once textarea becomes enabled while active (warmup recovery)', async () => {
    layoutState.isMobile = false;
    const { rerender } = render(<SendBoxHarness active={true} disabled={true} />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    expect(textarea).not.toHaveFocus();
    rerender(<SendBoxHarness active={true} disabled={false} />);
    await waitFor(() => expect(textarea).toHaveFocus());
  });

  it('does not move the caret if the box is already focused when it becomes active', async () => {
    layoutState.isMobile = false;
    const { rerender } = render(<SendBoxHarness active={false} initialValue='hello world' />);
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    act(() => {
      textarea.focus();
      textarea.setSelectionRange(2, 2);
    });
    rerender(<SendBoxHarness active={true} initialValue='hello world' />);
    await waitFor(() => expect(textarea).toHaveFocus());
    expect(textarea.selectionStart).toBe(2);
  });

  it('never focuses while active stays false', async () => {
    layoutState.isMobile = false;
    render(
      <div>
        <button type='button'>outside</button>
        <SendBoxHarness active={false} />
      </div>
    );
    const textarea = screen.getByTestId('sendbox-input') as HTMLTextAreaElement;
    screen.getByRole('button', { name: 'outside' }).focus();
    await waitFor(() => expect(screen.getByRole('button', { name: 'outside' })).toHaveFocus());
    expect(textarea).not.toHaveFocus();
  });
});

describe('SendBox stop button', () => {
  it('is named while a reply runs, and stops it', async () => {
    // Its only mark is a square: without a name a screen reader announced just "button".
    const onStop = vi.fn().mockResolvedValue(undefined);
    render(
      <SendBox value='' onChange={vi.fn()} onSend={vi.fn().mockResolvedValue(undefined)} loading onStop={onStop} />
    );

    const stop = screen.getByRole('button', { name: 'conversation.sendbox.stop' });
    expect(stop).toHaveAttribute('data-testid', 'sendbox-stop-btn');
    fireEvent.click(stop);
    await waitFor(() => expect(onStop).toHaveBeenCalledTimes(1));
  });
});
