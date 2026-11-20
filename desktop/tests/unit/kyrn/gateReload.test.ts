import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_FILE_NAME, watchGate } from '../../../packages/desktop/src/process/agent/kyrn/gateReload.ts';

/** A gate watch on a fake file: what the file says next, and every reload it caused. */
function fakeGate(initial: string | undefined, settleMs = 5) {
  let content = initial;
  const reads: (string | undefined)[] = [];
  const reloads: string[] = [];
  const gate = watchGate(
    'C:/workspaces/position',
    async () => {
      reads.push(content);
      return content;
    },
    () => reloads.push(String(content)),
    initial,
    settleMs
  );
  return {
    gate,
    reads,
    reloads,
    /** The file comes to say something else (or nothing, when `next` is undefined). */
    write: (next: string | undefined) => {
      content = next;
    },
  };
}
const waits = async (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('gate reload', () => {
  it('reloads once for a burst of events, not once per event', async () => {
    const f = fakeGate('v1');
    try {
      f.write('v2');
      f.gate.changed();
      f.gate.changed();
      f.gate.changed();
      f.gate.changed();
      await waits(60);
      expect(f.reloads).toEqual(['v2']);
      expect(f.reads).toHaveLength(1); // what the session started with came as `initial`; the burst settled into one read
    } finally {
      f.gate.close();
    }
  });

  it('reloads per content change, and not for a rewrite of the same words', async () => {
    const f = fakeGate('v1');
    try {
      f.write('v2');
      f.gate.changed();
      await waits(60);
      f.write('v2'); // an ensure that found nothing changed
      f.gate.changed();
      await waits(60);
      f.write('v3');
      f.gate.changed();
      await waits(60);
      expect(f.reloads).toEqual(['v2', 'v3']);
    } finally {
      f.gate.close();
    }
  });

  it('reloads when the gate file appears or goes away: the context changed either way', async () => {
    const f = fakeGate(undefined);
    try {
      f.write('v1');
      f.gate.changed();
      await waits(60);
      f.write(undefined);
      f.gate.changed();
      await waits(60);
      expect(f.reloads).toEqual(['v1', 'undefined']);
    } finally {
      f.gate.close();
    }
  });

  it('watches the real working directory and notices only the gate file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-watch-'));
    writeFileSync(join(dir, GATE_FILE_NAME), 'v1\n');
    const reloads: string[] = [];
    const gate = watchGate(
      dir,
      async (file) => {
        try {
          return await readFile(file, 'utf8');
        } catch {
          return undefined;
        }
      },
      () => reloads.push('reload'),
      'v1\n',
      50
    );
    try {
      writeFileSync(join(dir, 'TEAMS.md'), 'not the gate file\n');
      writeFileSync(join(dir, GATE_FILE_NAME), 'v2\n'); // one burst, one content
      for (let i = 0; i < 40 && reloads.length === 0; i++) await waits(50);
      expect(reloads).toEqual(['reload']);
    } finally {
      gate.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops watching at close: a later change reloads nothing', async () => {
    const f = fakeGate('v1');
    f.gate.close();
    f.write('v2');
    await f.gate.settle();
    f.gate.changed();
    await waits(60);
    expect(f.reloads).toEqual([]);
  });
});
