/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The files `present` hands over: a card in the conversation. An image file is shown in its row as a thumbnail, not
 * only named; any other file keeps its row as it was.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import MessageDeliverables, { deliverables } from '@/renderer/pages/conversation/Messages/acp/MessageDeliverables';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => options?.defaultValue ?? key,
  }),
}));

const { invoke } = vi.hoisted(() => ({
  invoke: vi.fn(async ({ path }: { path: string }) => `data:image/png;base64,${path.replaceAll('/', '_')}`),
}));
vi.mock('@/common', () => ({
  ipcBridge: { fs: { getImageBase64: { invoke }, copyFileToClipboard: { invoke: vi.fn(async () => true) } } },
}));

vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => vi.fn(),
}));

const presentCall = (files: unknown[], note?: unknown): TMessage =>
  ({
    type: 'acp_tool_call',
    content: { update: { title: 'present', status: 'completed', raw_output: { files, note } } },
  }) as unknown as TMessage;

describe('deliverables', () => {
  it('reads the files of a finished present call, with its note', () => {
    expect(
      deliverables(presentCall([{ path: 'E:/out/card.png', name: 'card.png', bytes: 2048 }], '  the deck  '))
    ).toEqual({
      files: [{ path: 'E:/out/card.png', name: 'card.png', bytes: 2048 }],
      note: 'the deck',
    });
  });

  it('keeps at most eight files and skips rows that do not read', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ path: `E:/out/${index}.png`, name: `${index}.png` }));
    const read = deliverables(presentCall([...many, { path: 7 }, 'x']));
    expect(read?.files).toHaveLength(8);
    expect(read?.files[0]).toEqual({ path: 'E:/out/0.png', name: '0.png', bytes: 0 });
  });

  it('reads the files the present tool carries in its result details (the payload the harness sends)', () => {
    const message = {
      type: 'acp_tool_call',
      content: {
        update: {
          title: 'present',
          status: 'completed',
          raw_output: {
            content: [{ type: 'text', text: 'Presented to the user (1 file)' }],
            details: { files: [{ path: 'E:/out/deck.mp4', name: 'deck.mp4', bytes: 2048 }] },
            status: 'completed',
          },
        },
      },
    } as unknown as TMessage;
    expect(deliverables(message)).toEqual({
      files: [{ path: 'E:/out/deck.mp4', name: 'deck.mp4', bytes: 2048 }],
    });
  });

  it('stays away from any other row', () => {
    expect(deliverables(presentCall([]))).toBeUndefined();
    expect(
      deliverables({
        type: 'acp_tool_call',
        content: { update: { title: 'present', status: 'running' } },
      } as unknown as TMessage)
    ).toBeUndefined();
  });
});

describe('MessageDeliverables', () => {
  // https://github.com/qybaihe/mu/issues/417
  it('shows an image file as a thumbnail in its row, and a document only by name', async () => {
    render(
      <MessageDeliverables
        delivered={{
          files: [
            { path: 'E:/out/card.png', name: 'card.png', bytes: 2048 },
            { path: 'E:/out/report.pdf', name: 'report.pdf', bytes: 65536 },
          ],
        }}
      />
    );
    expect(screen.getAllByTestId('message-deliverables-file')).toHaveLength(2);
    const thumbs = screen.getAllByTestId('message-deliverables-thumb');
    expect(thumbs).toHaveLength(1);
    await waitFor(() => expect(screen.getByAltText('card.png')).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith({ path: 'E:/out/card.png', workspace: undefined });
  });
});

describe('MessageDeliverables video rows', () => {
  // A video `present` handed over plays in its row — streamed, not carried whole into memory.
  it('shows a video under its row, streaming it from the backend route', async () => {
    invoke.mockClear();
    render(<MessageDeliverables delivered={{ files: [{ path: 'E:/out/clip.mp4', name: 'clip.mp4', bytes: 4096 }] }} />);
    const block = await screen.findByTestId('message-deliverables-video');
    const video = block.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.getAttribute('title')).toBe('clip.mp4');
    expect(video?.getAttribute('src')).toContain('/api/fs/stream');
    expect(invoke).not.toHaveBeenCalled(); // no base64 read for a video
  });

  it('a video that fails to load shows the error state, never a spinner', async () => {
    render(<MessageDeliverables delivered={{ files: [{ path: 'E:/out/gone.mp4', name: 'gone.mp4', bytes: 4096 }] }} />);
    const block = await screen.findByTestId('message-deliverables-video');
    fireEvent(block.querySelector('video') as Element, new Event('error'));
    const failed = await screen.findByTestId('local-video-error');
    expect(failed.textContent).toContain('gone.mp4');
    expect(block.querySelector('video')).toBeNull();
  });
});
