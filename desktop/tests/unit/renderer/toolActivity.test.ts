/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { NormalizedToolCall, NormalizedToolStatus } from '@/common/chat/normalizeToolCall';
import {
  ACTIVITY_FOLD_MIN,
  clipOutput,
  shouldFoldActivity,
  summarizeToolActivity,
  toolActivityDenied,
  toolActivityErrors,
  toolErrorLine,
  toolLabel,
} from '@/renderer/pages/conversation/Messages/components/toolActivity';
import { toolKind } from '@/renderer/pages/conversation/Messages/components/ToolKindIcon';

let seq = 0;
const call = (
  name: string,
  status: NormalizedToolStatus,
  input?: Record<string, unknown>,
  output?: string
): NormalizedToolCall => ({
  key: `${name}-${(seq += 1)}`,
  name,
  status,
  ...(input ? { input: JSON.stringify(input) } : {}),
  ...(output ? { output } : {}),
});

describe('what a folded run of tool calls says', () => {
  it('names the running call, whatever else the run already did', () => {
    const summary = summarizeToolActivity([
      call('read', 'completed', { file_path: 'src/a.ts' }),
      call('bash', 'running', { command: 'npm test' }),
      call('write', 'pending', { file_path: 'src/b.ts' }),
    ]);

    expect(summary).toMatchObject({
      steps: 3,
      status: 'running',
      failed: 0,
      running: { verb: 'bash', target: 'npm test' },
    });
  });

  it('treats an announced-but-unstarted call as the one still to come', () => {
    const summary = summarizeToolActivity([call('read', 'completed'), call('bash', 'pending', { command: 'ls' })]);

    expect(summary.status).toBe('running');
    expect(summary.running).toEqual({ verb: 'bash', target: 'ls' });
  });

  it('counts the failures once nothing is running any more', () => {
    const summary = summarizeToolActivity([
      call('read', 'completed', { file_path: 'src/a.ts' }),
      call('bash', 'error', { command: 'npm test' }, 'FAIL'),
      call('bash', 'error', { command: 'npm run lint' }, 'FAIL'),
    ]);

    expect(summary).toMatchObject({ steps: 3, status: 'error', failed: 2 });
    expect(summary.running).toBeUndefined();
  });

  it('reads as done when every call came back and none failed', () => {
    const summary = summarizeToolActivity([call('read', 'completed'), call('read', 'canceled')]);
    expect(summary).toMatchObject({ status: 'done', failed: 0, steps: 2 });
  });

  it('folds from two calls up, and never a lone one', () => {
    expect(ACTIVITY_FOLD_MIN).toBe(2);
    expect(shouldFoldActivity([call('read', 'completed')])).toBe(false);
    expect(shouldFoldActivity([call('read', 'completed'), call('bash', 'completed')])).toBe(true);
  });
});

describe('a failed step keeps its own words', () => {
  it('lists only the failures, one line each', () => {
    const errors = toolActivityErrors([
      call('read', 'completed', { file_path: 'src/a.ts' }),
      call('bash', 'error', { command: 'npm test' }, '\n\nFAIL src/a.test.ts\n  expected 1 to be 2\n'),
      call('bash', 'running', { command: 'npm run lint' }),
    ]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      label: { verb: 'bash', target: 'npm test' },
      line: 'FAIL src/a.test.ts',
    });
  });

  it('cuts a very long error down to a line a row can hold', () => {
    const line = toolErrorLine(call('bash', 'error', { command: 'x' }, 'e'.repeat(400)));
    expect(line).toHaveLength(160);
    expect(line?.endsWith('…')).toBe(true);
  });

  it('falls back to the call’s description when the failure said nothing', () => {
    expect(toolErrorLine({ key: 'k', name: 'bash', status: 'error', description: 'exit 1' })).toBe('exit 1');
    expect(toolErrorLine({ key: 'k', name: 'bash', status: 'error' })).toBeUndefined();
  });
});

describe('a step the person did not allow', () => {
  const refused = {
    ...call('bash', 'error', { command: 'rm -rf build' }, 'The user did not allow this (rm -rf build).'),
    denied: true as const,
  };

  it('never ran, which is no failure: the run is done, and its line is not an error line', () => {
    const tools = [call('read', 'completed', { file_path: 'src/a.ts' }), refused];
    expect(summarizeToolActivity(tools)).toMatchObject({ steps: 2, status: 'done', failed: 0 });
    expect(toolActivityErrors(tools)).toEqual([]);
  });

  it('is listed on its own, by what it would have run', () => {
    const tools = [call('bash', 'error', { command: 'npm test' }, 'FAIL'), refused];
    expect(summarizeToolActivity(tools)).toMatchObject({ status: 'error', failed: 1 });
    expect(toolActivityDenied(tools)).toEqual([{ key: refused.key, label: { verb: 'bash', target: 'rm -rf build' } }]);
  });
});

describe('what a call line is made of', () => {
  it('reads as a verb and what it was run on', () => {
    expect(toolLabel(call('read', 'completed', { file_path: 'src/a.ts' }))).toEqual({
      verb: 'read',
      target: 'src/a.ts',
      path: true,
    });
    expect(toolLabel(call('bash', 'completed', { command: 'npm test' }))).toEqual({
      verb: 'bash',
      target: 'npm test',
    });
  });

  it('reads the command of the tools other harnesses bring: cmd, and a command line as words', () => {
    // Codex's exec_command, and its shell (the script of `bash -lc`, or the words themselves).
    expect(toolLabel(call('exec_command', 'completed', { cmd: 'git status', workdir: '/p' }))).toEqual({
      verb: 'exec_command',
      target: 'git status',
    });
    expect(toolLabel(call('shell', 'completed', { command: ['bash', '-lc', 'npm test'], workdir: '/p' }))).toEqual({
      verb: 'shell',
      target: 'npm test',
    });
    expect(toolLabel(call('shell', 'completed', { command: ['ls', '-la'] }))).toEqual({
      verb: 'shell',
      target: 'ls -la',
    });
    // A list that is not words says nothing, and the next argument that names the work is used.
    expect(toolLabel(call('shell', 'completed', { command: [1, 2], path: 'src/a.ts' })).target).toBe('src/a.ts');
    expect(toolLabel(call('shell', 'completed', { command: [] })).target).toBeUndefined();
  });

  it('says when the target is a path, which a narrow row cuts in its middle', () => {
    expect(toolLabel(call('edit', 'completed', { path: 'src/b.ts', old_text: 'x' })).path).toBe(true);
    expect(toolLabel(call('grep', 'completed', { pattern: 'useState' })).path).toBeUndefined();
    expect(toolLabel(call('bash', 'completed', { command: 'cat src/a.ts' })).path).toBeUndefined();
  });

  it('keeps the verb alone when the input names nothing worth showing', () => {
    expect(toolLabel(call('ping', 'completed', { retries: 3 }))).toEqual({ verb: 'ping', target: undefined });
  });

  it('marks a call by what it does, and leaves an unknown one neutral', () => {
    expect(toolKind('read')).toBe('read');
    expect(toolKind('Shell Command')).toBe('shell');
    expect(toolKind('WriteFile')).toBe('edit');
    // Codex's write_stdin types into a running command: a shell, not a file edit.
    expect(toolKind('write_stdin')).toBe('shell');
    expect(toolKind('exec_command')).toBe('shell');
    expect(toolKind('rg')).toBe('search');
    expect(toolKind('grep')).toBe('search');
    expect(toolKind('delegate')).toBe('agent');
    expect(toolKind('mcp__weather__forecast')).toBe('other');
  });
});

describe('long output is clipped, not dumped', () => {
  it('cuts on a line boundary and says something was left out', () => {
    const value = Array.from({ length: 40 }, (_, index) => `line ${index}`).join('\n');
    const clip = clipOutput(value, { lines: 5 });
    expect(clip.clipped).toBe(true);
    expect(clip.text.split('\n')).toHaveLength(5);
  });

  it('leaves a short output exactly as it is', () => {
    expect(clipOutput('one\ntwo')).toEqual({ text: 'one\ntwo', clipped: false });
  });

  it('cuts a single enormous line by characters', () => {
    const clip = clipOutput('x'.repeat(5000), { chars: 100 });
    expect(clip).toEqual({ text: 'x'.repeat(100), clipped: true });
  });
});
