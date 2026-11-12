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
import { render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/common', () => ({ ipcBridge: { fs: { getImageBase64: { invoke } } } }));

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
