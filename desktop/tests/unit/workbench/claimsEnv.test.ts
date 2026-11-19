/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { missingPathsOf, resetClaimsEnvForTest, teamInfoOf } from '@/renderer/pages/workbench/team/claimsEnv';

const wire = vi.hoisted(() => ({
  fsMetadata: { invoke: vi.fn() },
  conversationGet: { invoke: vi.fn() },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: { getFileMetadata: wire.fsMetadata },
    conversation: { get: wire.conversationGet },
  },
}));

// A 400 answer means "not there"; everything else means "could not check".
const httpErrorOf = vi.hoisted(() => {
  class BackendHttpError extends Error {
    status: number;
    constructor(status: number) {
      super(`backend ${status}`);
      this.status = status;
    }
  }
  return BackendHttpError;
});
vi.mock('@/common/adapter/httpBridge', () => ({
  isBackendHttpError: (error: unknown) => error instanceof httpErrorOf,
  BackendHttpError: httpErrorOf,
}));

const gone = () => new httpErrorOf(400);

describe('claimsEnv.missingPathsOf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaimsEnvForTest();
  });

  it('flags paths the file service answers 400 for and keeps the rest', async () => {
    wire.fsMetadata.invoke.mockImplementation(async (params: { path: string }) => {
      if (params.path === 'E:/gone.md') throw gone();
      return { name: 'ok' };
    });
    const missing = await missingPathsOf(['E:/gone.md', 'E:/here.md']);
    expect(missing).toEqual(['E:/gone.md']);
  });

  it('counts a check that could not run as existing (no false marker)', async () => {
    wire.fsMetadata.invoke.mockRejectedValue(new Error('network down'));
    expect(await missingPathsOf(['E:/any.md'])).toEqual([]);
  });

  it('counts a 5xx as not-missing too', async () => {
    wire.fsMetadata.invoke.mockRejectedValue(Object.assign(new Error('500'), { status: 500 }));
    expect(await missingPathsOf(['E:/any.md'])).toEqual([]);
  });

  it('answers from the cache on the second ask (one call per path)', async () => {
    wire.fsMetadata.invoke.mockResolvedValue({ name: 'ok' });
    await missingPathsOf(['E:/a.md']);
    await missingPathsOf(['E:/a.md']);
    expect(wire.fsMetadata.invoke).toHaveBeenCalledTimes(1);
  });
});

describe('claimsEnv.teamInfoOf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetClaimsEnvForTest();
  });

  it('reads teamId, role and workspace from the conversation once', async () => {
    wire.conversationGet.invoke.mockResolvedValue({
      id: 'c1',
      extra: { teamId: 't1', role: 'lead', workspace: 'E:/w' },
    });
    await expect(teamInfoOf('c1')).resolves.toEqual({ teamId: 't1', role: 'lead', workspace: 'E:/w' });
    await teamInfoOf('c1');
    expect(wire.conversationGet.invoke).toHaveBeenCalledTimes(1);
  });

  it('settles deleted conversations as no-team', async () => {
    wire.conversationGet.invoke.mockRejectedValue(new Error('404'));
    await expect(teamInfoOf('gone')).resolves.toBeNull();
  });

  it('answers no-team for conversations without a teamId', async () => {
    wire.conversationGet.invoke.mockResolvedValue({ id: 'c2', extra: { workspace: 'E:/w' } });
    await expect(teamInfoOf('c2')).resolves.toEqual({ teamId: undefined, role: undefined, workspace: 'E:/w' });
  });
});
