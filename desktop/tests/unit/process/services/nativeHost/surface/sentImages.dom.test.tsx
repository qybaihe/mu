import React from 'react';
import { render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';
import { fromEntries, reduceAll } from '@/common/utils/nativeHost';
import MessageText from '@/renderer/pages/conversation/Messages/components/MessageText';
import { toMessages } from '@/renderer/pages/native/utils/toMessages';
import enMu from '@/renderer/services/i18n/locales/en-US/mu.json';
import { ended, text } from './records';

/**
 * The images a person sent as themselves in a native conversation: pi keeps them as image blocks of the user message,
 * live and in the session file, and the person's row shows them as a sent image file shows (60 px, whole on a click),
 * above the text, or alone. A classic row, which carries files by path, is drawn exactly as before.
 */

const filePreview = vi.fn(({ path }: { path: string }) => <div data-testid='file-preview'>{path}</div>);

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getFileMetadata: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
      readFile: { invoke: vi.fn() },
      getContentMetadata: { invoke: vi.fn() },
      readContent: { invoke: vi.fn() },
    },
    conversation: { fork: { invoke: vi.fn() }, ensureRuntime: { invoke: vi.fn() } },
  },
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));
vi.mock('@/renderer/components/media/FilePreview', () => ({
  __esModule: true,
  default: (props: { path: string }) => filePreview(props),
}));
vi.mock('@/renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

const i18n = createInstance();
void i18n.init({ lng: 'en', resources: { en: { translation: { mu: enMu } } }, interpolation: { escapeValue: false } });

const PNG = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
const JPEG = { mimeType: 'image/jpeg', data: '/9j/4AAQ' };

const row = (content: IMessageText['content'], position: 'left' | 'right' = 'right'): IMessageText => ({
  id: 'm1',
  msg_id: 'm1',
  conversation_id: 'c1',
  type: 'text',
  position,
  created_at: 1,
  content,
});

const show = (message: IMessageText) =>
  render(
    <I18nextProvider i18n={i18n}>
      <MessageText message={message} />
    </I18nextProvider>
  );

describe('the images in a person’s row', () => {
  it('shows each image the person sent above the text', () => {
    show(row({ content: 'what is on these?', images: [PNG, JPEG] }));
    const pictures = screen.getAllByTestId('native-message-image');
    expect(pictures.map((picture) => picture.getAttribute('data-mime'))).toEqual(['image/png', 'image/jpeg']);
    const first = pictures[0].querySelector('img');
    expect(first).toHaveAttribute('src', `data:image/png;base64,${PNG.data}`);
    expect(first).toHaveAttribute('alt', 'Image 1');
    expect(screen.getByTestId('message-text-content')).toHaveTextContent('what is on these?');
  });

  it('shows an image sent without a word, with no empty bubble', () => {
    show(row({ content: '', images: [PNG] }));
    expect(screen.getAllByTestId('native-message-image')).toHaveLength(1);
    expect(screen.queryByTestId('message-text-content')).toBeNull();
  });

  it('draws a classic row as before: files by path, nothing for an empty row, no images on mu’s side', () => {
    show(row({ content: 'look\n\n[[AION_FILES]]\n/work/shot.png' }));
    expect(screen.getByTestId('file-preview')).toHaveTextContent('/work/shot.png');
    expect(screen.queryByTestId('native-message-image')).toBeNull();
    expect(screen.getByTestId('message-text-content')).toHaveTextContent('look');
    const empty = show(row({ content: '' }));
    expect(empty.container).toBeEmptyDOMElement();
    show(row({ content: 'a reply', images: [PNG] }, 'left'));
    expect(screen.queryByTestId('native-message-image')).toBeNull();
  });
});

describe('the person’s row from the view', () => {
  const words = { retried: (count: number) => `${count}`, compacted: () => '' };
  const withImage = { role: 'user', content: [text('see'), { type: 'image', ...PNG }], timestamp: 1 };

  it('carries the images live and from the session file alike, and none when there are none', () => {
    const live = toMessages(reduceAll([ended(withImage, 'u1')]), { conversationId: 'c1', words });
    const file = toMessages(
      fromEntries([{ type: 'message', id: 'u1', parentId: null, timestamp: 'x', message: withImage }]),
      { conversationId: 'c1', words }
    );
    for (const rows of [live, file]) expect(rows[0].content).toEqual({ content: 'see', images: [PNG] });
    const plain = toMessages(reduceAll([ended({ role: 'user', content: [text('hi')], timestamp: 1 })]), {
      conversationId: 'c1',
      words,
    });
    expect(plain[0].content).toEqual({ content: 'hi' });
  });

  it('shows the images of a message on its way', () => {
    const rows = toMessages(reduceAll([]), {
      conversationId: 'c1',
      words,
      outgoing: { id: 'outgoing-1', text: 'this one', at: 5, images: [JPEG] },
    });
    expect(rows.at(-1)?.content).toEqual({ content: 'this one', images: [JPEG] });
  });
});
