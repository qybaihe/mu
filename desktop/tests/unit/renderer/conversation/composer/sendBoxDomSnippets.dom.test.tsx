/**
 * What the send box sends with the elements picked and the comments written for the message: the text, then each under
 * its own rule, a page's element said with where it is (`about`), the preview's as a DOM snippet, a diff comment with
 * its line in a diff fence.
 */

import { act, fireEvent, render, screen } from '@testing-library/react';
import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomSnippet } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const preview = vi.hoisted(() => ({ snippets: [] as DomSnippet[], clear: vi.fn() }));

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
  useConversationContextSafe: () => ({ conversation_id: 'sendbox-dom-snippets', type: 'acp' }),
}));

vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({
    setSendBoxHandler: vi.fn(),
    domSnippets: preview.snippets,
    removeDomSnippet: vi.fn(),
    clearDomSnippets: preview.clear,
  }),
}));

vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  useMessageList: () => [],
}));

vi.mock('@/renderer/hooks/file/useConversationExport', () => ({
  useConversationExport: () => ({
    isOpen: false,
    showMenu: false,
    step: 'closed',
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
  useBtwCommand: () => ({ answer: '', question: '', isLoading: false, isOpen: false, ask: vi.fn(), dismiss: vi.fn() }),
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

const Harness = ({ onSend }: { onSend: (text: string) => Promise<void> }) => {
  const [value, setValue] = useState('');
  return <SendBox value={value} onChange={setValue} onSend={onSend} />;
};

const input = () => screen.getByTestId('sendbox-input') as HTMLTextAreaElement;

describe('SendBox: the elements picked for the message', () => {
  beforeEach(() => {
    preview.snippets = [];
    preview.clear.mockReset();
  });

  it('sends the text, then each element, a page’s with where it is, and lets them go', async () => {
    preview.snippets = [
      { id: 'a', tag: 'div.card', html: '<div class="card"></div>' },
      {
        id: 'b',
        tag: 'button.primary',
        html: '<button class="primary">Buy</button>',
        about: 'Element on the page http://localhost:5173/ (button.primary):\n- selector: `button.primary`',
      },
    ];
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSend={onSend} />);
    // The chips name each element.
    expect(screen.getByText('div.card')).toBeInTheDocument();
    expect(screen.getByText('button.primary')).toBeInTheDocument();

    fireEvent.change(input(), { target: { value: 'Make this blue' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sendbox-send-btn'));
    });

    expect(onSend).toHaveBeenCalledWith(
      [
        'Make this blue',
        '',
        '---',
        'DOM Snippet (div.card):',
        '```html',
        '<div class="card"></div>',
        '```',
        '',
        '---',
        'Element on the page http://localhost:5173/ (button.primary):',
        '- selector: `button.primary`',
        '```html',
        '<button class="primary">Buy</button>',
        '```',
      ].join('\n')
    );
    expect(preview.clear).toHaveBeenCalled();
  });

  it('fences HTML longer than any run of backticks in it, and sends the pictures of the elements with the message', async () => {
    preview.snippets = [
      {
        id: 'p',
        tag: 'pre',
        html: '<pre>```\nnot the end\n````</pre>',
        about: 'Element on the page https://a.test/ (pre):',
        image: { data: 'cG5n', mimeType: 'image/png' },
      },
    ];
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSend={onSend} />);
    // The chip says it has a picture.
    expect(screen.getByTestId('sendbox-dom-snippet')).toHaveAttribute('data-picture', 'true');
    await act(async () => {
      fireEvent.click(screen.getByTestId('sendbox-send-btn'));
    });
    expect(onSend).toHaveBeenCalledWith(
      '\n\n---\nElement on the page https://a.test/ (pre):\n`````html\n<pre>```\nnot the end\n````</pre>\n`````',
      { images: [{ data: 'cG5n', mimeType: 'image/png' }] }
    );
  });

  it('sends a comment on a diff line in a diff fence', async () => {
    preview.snippets = [
      {
        id: 'c',
        tag: 'app.ts:2',
        html: '+const b = 3;',
        about: 'Comment on `src/app.ts`, added line 2:\nMake it 30.',
        fence: 'diff',
        comment: { file: 'src/app.ts', side: 'new', line: 2, text: 'Make it 30.' },
      },
    ];
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSend={onSend} />);
    expect(screen.getByText('app.ts:2')).toBeInTheDocument();
    fireEvent.change(input(), { target: { value: 'Review' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('sendbox-send-btn'));
    });
    expect(onSend).toHaveBeenCalledWith(
      'Review\n\n---\nComment on `src/app.ts`, added line 2:\nMake it 30.\n```diff\n+const b = 3;\n```'
    );
  });

  it('sends an element with no text of its own', async () => {
    preview.snippets = [
      { id: 'a', tag: 'h1', html: '<h1>Hi</h1>', about: 'Element on the page https://a.test/ (h1):' },
    ];
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Harness onSend={onSend} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('sendbox-send-btn'));
    });
    expect(onSend).toHaveBeenCalledWith(
      '\n\n---\nElement on the page https://a.test/ (h1):\n```html\n<h1>Hi</h1>\n```'
    );
  });
});
