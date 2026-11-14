/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The files `present` hands over: a card in the conversation. An image file is shown in its row as a thumbnail, not
 * only named; a video file shows its first frame and plays muted on hover; any other file keeps its row as it was.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import MessageDeliverables, { deliverables } from '@/renderer/pages/conversation/Messages/acp/MessageDeliverables';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; count?: number }) => options?.defaultValue ?? key,
  }),
}));

const { imageInvoke, readInvoke } = vi.hoisted(() => ({
  imageInvoke: vi.fn(async ({ path }: { path: string }) => `data:image/png;base64,${path.replaceAll('/', '_')}`),
  readInvoke: vi.fn(async () => 'AAAA'),
}));
vi.mock('@/common', () => ({
  ipcBridge: { fs: { getImageBase64: { invoke: imageInvoke }, readContent: { invoke: readInvoke } } },
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
    expect(imageInvoke).toHaveBeenCalledWith({ path: 'E:/out/card.png', workspace: undefined });
  });
});

describe('MessageDeliverables video rows', () => {
  it('shows a video as #421 shows a reply’s video: a frame that plays on hover, fetched once', async () => {
    render(
      <MessageDeliverables delivered={{ files: [{ path: 'E:/out/clip.mp4', name: 'clip.mp4', bytes: 4096 }] }} />
    );
    const block = await screen.findByTestId('message-deliverables-video');
    const video = block.querySelector('video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.getAttribute('title')).toBe('clip.mp4');
    expect(imageInvoke).toHaveBeenCalledWith({ path: 'E:/out/clip.mp4', workspace: undefined });
    // Hover play/pause and the click overlay are LocalVideoView's own, covered by its test file.
  });

  it('leaves a loading placeholder when the video does not read', async () => {
    imageInvoke.mockResolvedValueOnce(null);
    render(
      <MessageDeliverables delivered={{ files: [{ path: 'E:/out/gone.mp4', name: 'gone.mp4', bytes: 4096 }] }} />
    );
    const block = await screen.findByTestId('message-deliverables-video');
    // The placeholder stays — no video element, no crash.
    await waitFor(() => expect(block.querySelector('video')).toBeNull());
  });
});
