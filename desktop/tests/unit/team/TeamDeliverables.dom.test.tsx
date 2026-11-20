/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The deliverables entry and its modal: the entry sits by the identity strip,
 * one click reads the team's conversations (the bridge is mocked) and lists
 * every `present` call's files across both wire shapes — newest first, with
 * the delivering member and the time; a file that no longer exists reads
 * greyed and unopenable; a deliverable from the open conversation also offers
 * the jump to its source message.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';

const opened = vi.hoisted(() => [] as string[]);
const jumps = vi.hoisted(() => [] as unknown[]);

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (params === undefined) return key;
      return `${key}:${Object.entries(params)
        .map(([name, value]) => `${name}=${value}`)
        .join(',')}`;
    },
    i18n: { language: 'zh-CN' },
  }),
}));
vi.mock('@/renderer/hooks/context/ConversationContext', () => ({
  useConversationContextSafe: () => ({ conversation_id: 'lead-conv' }),
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));
vi.mock('@/renderer/pages/conversation/Preview/hooks/useLocalFilePreview', () => ({
  useOptionalLocalFilePreview: () => async (path: string) => {
    opened.push(path);
  },
}));
vi.mock('@renderer/utils/chat/chatMinimapEvents', () => ({
  dispatchChatMessageJump: (detail: unknown) => jumps.push(detail),
}));
vi.mock('@renderer/utils/chat/messagePagination', () => ({
  loadConversationMessagePage: vi.fn(async (conversationId: string) => ({
    items: pages[conversationId] ?? [],
    oldest_cursor: null,
    newest_cursor: null,
    has_more_before: false,
    has_more_after: false,
  })),
}));
vi.mock('@/common/chat/fileRefs/fileRefBridge', () => ({
  FILE_REF_BATCH_LIMIT: 200,
  fileRefBridge: {
    resolve: {
      invoke: async ({ refs }: { refs: string[] }) => ({
        ok: true as const,
        data: refs.map((path) =>
          missing.has(path) ? { state: 'missing' } : { state: 'found', path, kind: 'file', size: 1 }
        ),
      }),
    },
  },
}));
import TeamDeliverables, { deliverablesFromRows } from '@renderer/pages/team/components/TeamDeliverables';
import type { TTeam } from '@/common/types/team/teamTypes';

const pages: Record<string, unknown[]> = {};
const missing = new Set<string>();

afterEach(() => {
  cleanup();
  opened.length = 0;
  jumps.length = 0;
  for (const key of Object.keys(pages)) delete pages[key];
  missing.clear();
});

const team: TTeam = {
  id: 't1',
  user_id: 'u1',
  name: '货代小队',
  workspace: 'C:/w',
  workspace_mode: 'shared',
  leader_assistant_id: 's1',
  assistants: [
    {
      slot_id: 's1',
      conversation_id: 'lead-conv',
      role: 'leader',
      assistant_backend: 'acp',
      assistant_name: '货代',
      status: 'idle',
      context_reset: { supported: false },
    },
    {
      slot_id: 's2',
      conversation_id: 'mate-conv',
      role: 'teammate',
      assistant_backend: 'acp',
      assistant_name: '货代 2',
      status: 'idle',
      context_reset: { supported: false },
    },
  ],
  created_at: 1,
  updated_at: 1,
};

/** A stored present row: `shape` picks where the relay put the files. */
const presentRow = (id: string, at: number, files: unknown[], shape: 'nested' | 'flat', note?: string): unknown => ({
  id,
  type: 'acp_tool_call',
  created_at: at,
  content: {
    session_id: 'c',
    update: {
      session_update: 'tool_call_update',
      tool_call_id: id,
      title: 'present',
      status: 'completed',
      raw_output:
        shape === 'nested'
          ? { content: [], details: { files, ...(note ? { note } : {}) }, status: 'completed' }
          : { files, status: 'completed' },
    },
  },
});

describe('deliverablesFromRows', () => {
  it('reads both wire shapes, finished calls only, and carries the source', () => {
    const rows = [
      presentRow('p1', 100, [{ path: 'C:/w/a.html', name: 'a', bytes: 5 }], 'nested', '成稿'),
      presentRow('p2', 200, [{ path: 'C:/w/b.pdf', name: 'b', bytes: 6 }], 'flat'),
      presentRow('p3', 300, [{ path: 'C:/w/c.md', name: 'c' }], 'nested'),
      {
        id: 'p4',
        type: 'acp_tool_call',
        created_at: 400,
        content: {
          update: { title: 'present', status: 'in_progress', raw_output: { files: [{ path: 'x', name: 'x' }] } },
        },
      },
      { id: 'p5', type: 'text', created_at: 500 },
    ];
    const list = deliverablesFromRows(rows, 'lead-conv');
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({
      path: 'C:/w/a.html',
      name: 'a',
      bytes: 5,
      note: '成稿',
      createdAt: 100,
      conversationId: 'lead-conv',
      messageId: 'p1',
    });
    expect(list[1]).toMatchObject({ path: 'C:/w/b.pdf', bytes: 6, messageId: 'p2' });
    expect(list[2]).not.toHaveProperty('note');
  });
});

describe('TeamDeliverables', () => {
  it('lists the team’s deliverables newest first, with member and time', async () => {
    pages['lead-conv'] = [presentRow('p1', 100, [{ path: 'C:/w/old.html', name: '旧稿', bytes: 5 }], 'nested')];
    pages['mate-conv'] = [presentRow('p2', 200, [{ path: 'C:/w/new.pdf', name: '新稿', bytes: 6 }], 'nested')];
    render(<TeamDeliverables team={team} />);
    fireEvent.click(screen.getByTestId('team-deliverables-entry'));
    const rows = await screen.findAllByTestId('team-deliverables-file');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('新稿');
    expect(rows[0].textContent).toContain('货代 2');
    expect(rows[1].textContent).toContain('货代'); // the lead's own name, unprefixed
  });

  it('greys a file that no longer exists and refuses to open it', async () => {
    missing.add('C:/w/gone.pdf');
    pages['lead-conv'] = [presentRow('p1', 100, [{ path: 'C:/w/gone.pdf', name: '没了', bytes: 5 }], 'nested')];
    render(<TeamDeliverables team={team} />);
    fireEvent.click(screen.getByTestId('team-deliverables-entry'));
    await screen.findByTestId('team-deliverables-file');
    expect(screen.getByTestId('team-deliverables-file').dataset.missing).toBe('true');
    expect(screen.getByTestId('team-deliverables-missing-tag')).toBeInTheDocument();
    expect(screen.getByTestId('team-deliverables-open')).toBeDisabled();
    expect(opened).toEqual([]);
  });

  it('opens an existing file in the preview, and jumps to the source message of the open conversation', async () => {
    pages['lead-conv'] = [presentRow('p1', 100, [{ path: 'C:/w/there.pdf', name: '在的', bytes: 5 }], 'nested')];
    pages['mate-conv'] = [presentRow('p2', 200, [{ path: 'C:/w/mate.pdf', name: '成员稿', bytes: 6 }], 'nested')];
    render(<TeamDeliverables team={team} />);
    fireEvent.click(screen.getByTestId('team-deliverables-entry'));
    await screen.findAllByTestId('team-deliverables-file');
    // Only the open conversation's row carries the jump.
    expect(screen.getAllByTestId('team-deliverables-jump')).toHaveLength(1);
    fireEvent.click(screen.getAllByTestId('team-deliverables-open')[0]); // newest first: the mate's file
    await waitFor(() => expect(opened).toEqual(['C:/w/mate.pdf']));
    fireEvent.click(screen.getByTestId('team-deliverables-jump'));
    expect(jumps).toEqual([{ conversation_id: 'lead-conv', messageId: 'p1' }]);
  });

  it('shows the empty state when no member ever presented', async () => {
    pages['lead-conv'] = [];
    pages['mate-conv'] = [];
    render(<TeamDeliverables team={team} />);
    fireEvent.click(screen.getByTestId('team-deliverables-entry'));
    expect(await screen.findByTestId('team-deliverables-empty')).toBeInTheDocument();
  });
});
