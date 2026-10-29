import { describe, expect, it } from 'vitest';
import { durable, PRESENTATION_STATUS_KEY, reduceAll, type PiRecord } from '@/common/utils/nativeHost/index.ts';
import { JOB_LIMIT } from '@/common/utils/nativeHost/host.ts';

/**
 * The commands mu runs in the background, in the view's live host part: a `background.start` frame adds one that
 * runs, `background.stop` marks it stopping, `background.exit` says how it ended. Only a live host says them.
 */

type Json = Record<string, unknown>;

let sequence = 0;
const frame = (kind: string, payload: Json, at = 1000): PiRecord => {
  sequence += 1;
  return {
    type: 'extension_ui_request',
    id: `f${sequence}`,
    method: 'setStatus',
    statusKey: PRESENTATION_STATUS_KEY,
    statusText: JSON.stringify({ version: 1, sequence, at, kind, payload }),
  };
};
const started = (id: string, at = 1000) =>
  frame(
    'background.start',
    { id, name: `${id}-name`, command: `npm run ${id}`, pid: 7, cwd: '/work', logPath: `/logs/${id}.log` },
    at
  );

describe('the background jobs of a view', () => {
  it('start running, then stop or end, with how', () => {
    const view = reduceAll([
      started('dev', 1000),
      started('build', 2000),
      frame('background.stop', { id: 'dev', name: 'dev-name', command: 'npm run dev' }),
      frame('background.exit', { id: 'dev', exitCode: 143, durationMs: 9000, stoppedBy: 'user', lingering: false }),
      frame('background.exit', { id: 'build', exitCode: 1, durationMs: 4000 }),
    ]);
    expect(view.host.jobs).toEqual([
      {
        id: 'dev',
        name: 'dev-name',
        command: 'npm run dev',
        cwd: '/work',
        logPath: '/logs/dev.log',
        state: 'exited',
        startedAt: 1000,
        exitCode: 143,
        durationMs: 9000,
        stoppedBy: 'user',
      },
      {
        id: 'build',
        name: 'build-name',
        command: 'npm run build',
        cwd: '/work',
        logPath: '/logs/build.log',
        state: 'exited',
        startedAt: 2000,
        exitCode: 1,
        durationMs: 4000,
      },
    ]);
    expect(durable(view).host.jobs).toBeUndefined();
  });

  it('is stopping between the stop and the end, and keeps a job whose processes linger', () => {
    let view = reduceAll([started('dev'), frame('background.stop', { id: 'dev' })]);
    expect(view.host.jobs?.[0].state).toBe('stopping');
    view = reduceAll([frame('background.exit', { id: 'dev', exitCode: 0, durationMs: 5, lingering: true })], view);
    expect(view.host.jobs?.[0]).toMatchObject({ state: 'exited', lingering: true });
    // Stopping it again ends what lingers: mu says so once it is gone, and the job keeps its end.
    view = reduceAll([frame('background.stop', { id: 'dev' })], view);
    expect(view.host.jobs?.[0]).toMatchObject({ state: 'exited', exitCode: 0, durationMs: 5 });
    expect(view.host.jobs?.[0].lingering).toBeUndefined();
  });

  it('keeps a stopped job ended when mu says it was stopped after its end', () => {
    const view = reduceAll([
      started('dev'),
      frame('background.exit', { id: 'dev', exitCode: 143, durationMs: 9000, stoppedBy: 'user', lingering: false }),
      frame('background.stop', { id: 'dev', exitCode: 143 }),
    ]);
    expect(view.host.jobs?.[0]).toMatchObject({ state: 'exited', exitCode: 143, stoppedBy: 'user' });
  });

  it('leaves out a stop or an end for a job it never saw start, and a frame without an id', () => {
    const view = reduceAll([
      frame('background.stop', { id: 'ghost' }),
      frame('background.exit', { id: 'ghost', exitCode: 0 }),
      frame('background.start', { name: 'no id' }),
    ]);
    expect(view.host.jobs).toBeUndefined();
  });

  it('keeps the latest jobs, dropping the oldest that ended first', () => {
    const records: PiRecord[] = [started('keep')];
    for (let n = 0; n < JOB_LIMIT; n++) {
      records.push(started(`j${n}`), frame('background.exit', { id: `j${n}`, exitCode: 0, durationMs: 1 }));
    }
    const jobs = reduceAll(records).host.jobs ?? [];
    expect(jobs).toHaveLength(JOB_LIMIT);
    // The one still running stays, though it is the oldest.
    expect(jobs[0].id).toBe('keep');
    expect(jobs.at(-1)?.id).toBe(`j${JOB_LIMIT - 1}`);
  });
});
