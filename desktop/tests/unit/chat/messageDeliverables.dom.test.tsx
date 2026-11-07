import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import MessageDeliverables, {
  deliverables,
  fileSize,
} from '@/renderer/pages/conversation/Messages/acp/MessageDeliverables';
import enMessages from '@/renderer/services/i18n/locales/en-US/messages.json';

/** The files mu's present handed over, as the conversation's card: what it shows, and what a click opens. */

const opened = vi.hoisted(() => [] as string[]);
vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => async (path: string) => {
    opened.push(path);
  },
}));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({ useMessageListRun: () => ({ workspace: '/work' }) }));

afterEach(() => {
  cleanup();
  opened.length = 0;
});

const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: { en: { translation: { messages: enMessages } } },
  interpolation: { escapeValue: false },
});

const row = (update: Record<string, unknown>): TMessage =>
  ({
    id: 'r1',
    conversation_id: 'c1',
    type: 'acp_tool_call',
    position: 'left',
    content: { session_id: 'c1', update: { sessionUpdate: 'tool_call', tool_call_id: 'call-1', ...update } },
  }) as unknown as TMessage;

const FILES = [
  { path: '/work/out/report.pdf', name: 'report.pdf', bytes: 2048 },
  { path: '/work/out/deck.pptx', name: 'Slides for Monday', bytes: 3_500_000 },
];

describe('the files mu’s present handed over', () => {
  it('are read from a finished present call, and from nothing else', () => {
    const done = row({ title: 'present', status: 'completed', rawOutput: { files: FILES, note: ' For Monday. ' } });
    expect(deliverables(done)).toEqual({ files: FILES, note: 'For Monday.' });
    // The relay snake-cases the keys it passes on.
    expect(deliverables(row({ title: 'present', status: 'completed', raw_output: { files: FILES } }))).toEqual({
      files: FILES,
    });
    expect(deliverables(row({ title: 'present', status: 'in_progress', rawOutput: { files: FILES } }))).toBeUndefined();
    expect(deliverables(row({ title: 'bash', status: 'completed', rawOutput: { files: FILES } }))).toBeUndefined();
    expect(
      deliverables(row({ title: 'present', status: 'completed', rawOutput: { files: [{ name: 'x' }] } }))
    ).toBeUndefined();
  });

  it('show as a card with each file’s name, folder and size, and open one in the preview with a click', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MessageDeliverables delivered={{ files: FILES, note: 'For Monday.' }} />
      </I18nextProvider>
    );
    expect(screen.getByTestId('message-deliverables')).toHaveTextContent('Files for you (2)');
    expect(screen.getByText('For Monday.')).toBeInTheDocument();
    const files = screen.getAllByTestId('message-deliverables-file');
    expect(files.map((file) => file.textContent)).toEqual([
      'report.pdf/work/out2.0 KB',
      'Slides for Monday/work/out3.3 MB',
    ]);
    expect(files[1]).toHaveAttribute('aria-label', 'Open Slides for Monday');
    await act(async () => {
      fireEvent.click(files[1]);
    });
    expect(opened).toEqual(['/work/out/deck.pptx']);
  });

  it('say sizes as a person reads them', () => {
    expect(fileSize(512)).toBe('512 B');
    expect(fileSize(1536)).toBe('1.5 KB');
    expect(fileSize(20 * 1024 * 1024)).toBe('20 MB');
  });
});
