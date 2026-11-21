/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The task-verification badge store (batch L ②): the pure derivations — the
 * claimed paths a task window holds (write/edit plus present rows, window
 * filtered, deduped on separator folds) and the verdict one batch of
 * fileRefs answers settles — and the localStorage store the card, the
 * monitor counts and the E2E share.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TMessage } from '@/common/chat/chatLib';
import {
  claimedPathsFrom,
  clearTaskVerifications,
  recordTaskVerification,
  resetTaskVerificationCache,
  subscribeTaskVerifications,
  taskVerificationSnapshot,
  verificationStateOf,
} from '@renderer/pages/team/core/notes/taskVerificationNotes';
import type { FileRefAnswer } from '@/common/chat/fileRefs/fileRefBridge';

/** One stored tool-call row, the wire shape the conversations API answers. */
const toolRow = (id: string, title: string, path: string | undefined, at: number, status = 'completed'): unknown => ({
  id,
  type: 'acp_tool_call',
  created_at: at,
  content: {
    update: {
      title,
      status,
      ...(path !== undefined ? { raw_input: { path } } : {}),
    },
  },
});

/** One stored `present` row, the ACP shape (files nested under details). */
const presentRow = (id: string, path: string, name: string, at: number): unknown => ({
  id,
  type: 'acp_tool_call',
  created_at: at,
  content: {
    update: {
      title: 'present',
      status: 'completed',
      raw_output: { details: { files: [{ path, name, bytes: 5 }], note: '' } },
    },
  },
});

describe('claimedPathsFrom', () => {
  it('collects the finished writes and presents of a window, deduped on separator folds', () => {
    const rows: readonly unknown[] = [
      toolRow('w1', 'write', 'E:/w/report.md', 1_000),
      toolRow('w2', 'edit', 'E:/w\\report.md', 1_200), // same file, backslashes
      toolRow('w3', 'write', 'E:/w/other.md', 9_000), // outside the window
      toolRow('w4', 'write', 'E:/w/failed.md', 1_400, 'error'), // never landed
      toolRow('p1', undefined, undefined, 1_500), // not a tool row (ignored)
      presentRow('pr1', 'E:/w/report.md', 'report.md', 1_600), // present of an already-counted file
      presentRow('pr2', 'E:/w/table.csv', 'table.csv', 1_700),
    ];
    const paths = claimedPathsFrom(rows as readonly TMessage[], 'conv-1', 0, 2_000);
    expect(paths).toEqual(['E:/w/report.md', 'E:/w/table.csv']);
  });

  it('an empty window claims nothing — itself the 未回查 verdict', () => {
    expect(claimedPathsFrom([], 'conv-1', 0, 2_000)).toEqual([]);
  });
});

describe('verificationStateOf', () => {
  const found: FileRefAnswer = { state: 'found', path: 'E:/w/a', kind: 'file', size: 1 };
  it('every path a regular file (and at least one) = verified', () => {
    expect(verificationStateOf([found, found])).toBe('verified');
  });
  it('a missing or ambiguous path, or nothing to check, = pending', () => {
    expect(verificationStateOf([found, { state: 'missing' }])).toBe('pending');
    expect(verificationStateOf([found, { state: 'ambiguous' }])).toBe('pending');
    expect(verificationStateOf([])).toBe('pending');
  });
});

describe('the store', () => {
  beforeEach(() => {
    localStorage.clear();
    clearTaskVerifications();
  });

  it('records and replaces verdicts by task id, and notifies the listeners', () => {
    let notifications = 0;
    const unsubscribe = subscribeTaskVerifications(() => {
      notifications += 1;
    });
    recordTaskVerification({
      taskId: 'task-1',
      teamId: 'team-1',
      state: 'pending',
      checkedAt: 1,
      pathCount: 1,
      verifiedCount: 0,
    });
    expect(taskVerificationSnapshot().get('task-1')).toMatchObject({ state: 'pending' });
    // A re-done task re-verifies: the fresh verdict replaces the old one.
    recordTaskVerification({
      taskId: 'task-1',
      teamId: 'team-1',
      state: 'verified',
      checkedAt: 5,
      pathCount: 1,
      verifiedCount: 1,
    });
    expect(taskVerificationSnapshot().get('task-1')).toMatchObject({ state: 'verified', checkedAt: 5 });
    expect(notifications).toBe(2);
    unsubscribe();
    clearTaskVerifications();
    expect(taskVerificationSnapshot().size).toBe(0);
  });

  it('survives a reload: the verdicts re-read from localStorage', () => {
    recordTaskVerification({
      taskId: 'task-9',
      teamId: 'team-9',
      state: 'verified',
      checkedAt: 3,
      pathCount: 2,
      verifiedCount: 2,
    });
    // The module cache is dropped (a fresh window's cold start); the storage holds.
    resetTaskVerificationCache();
    expect(taskVerificationSnapshot().get('task-9')).toMatchObject({ state: 'verified' });
  });
});
