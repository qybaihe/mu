import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AcpBindings,
  boundFile,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/acpBindings.ts';
import { canSymlink } from '../symlinks.ts';

const linking = canSymlink();

/**
 * The session files AionCore's mu conversations use, from the ACP adapter's records (`<mu home>/acp-sessions`) and
 * the import records beside them: what binds a file, what does not, and that a record is read again only when it
 * changed.
 */

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-acp-bindings-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const ADAPTER_ID = '0b5b2f36-6f0e-4d1e-9d55-2b9f2c7d1a01';
const OTHER_ID = '7c1d9a4e-3f52-4b8e-a6d0-5e2f1b3c4d02';

let worlds = 0;
function world() {
  const home = join(root, `world-${++worlds}`);
  const store = join(home, '.mu', 'acp-sessions');
  const sessions = join(home, 'agent', 'sessions', '--project--');
  mkdirSync(join(store, 'imports'), { recursive: true });
  mkdirSync(sessions, { recursive: true });
  const record = (name: string, value: unknown, folder = store) => {
    const file = join(folder, name);
    writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  return { home, store, sessions, record, bindings: new AcpBindings(() => store) };
}

describe('AcpBindings', () => {
  it('binds the files the adapter’s and the imports’ records name, and nothing else', async () => {
    const { store, sessions, record, bindings } = world();
    const run = join(sessions, '2026_run.jsonl');
    const imported = join(sessions, '2026_imported.jsonl');
    record(`${ADAPTER_ID}.json`, { cwd: '/project', file: run, permissions: 'full' });
    record(
      'conversation-7.json',
      { version: 1, file: imported, cwd: '/project', tool: 'claude', source: '/x.jsonl' },
      join(store, 'imports')
    );
    // Not records: telemetry, a half-written record, a record without a file, a relative path, a broken one.
    record(`${OTHER_ID}.events.jsonl`, '{"file":"/elsewhere/a.jsonl"}\n');
    record(`${OTHER_ID}.json.tmp`, { file: join(sessions, 'tmp.jsonl') });
    record(`${OTHER_ID}.json`, { cwd: '/project', permissions: 'ask' });
    record('conversation-8.json', { file: 'relative.jsonl' }, join(store, 'imports'));
    record('conversation-9.json', '{"file":', join(store, 'imports'));
    const bound = await bindings.files();
    expect([...bound].toSorted()).toEqual([imported, run].toSorted());
    const hidden = boundFile(bound);
    expect(hidden(run)).toBe(true);
    expect(hidden(join(sessions, '..', '--project--', '2026_run.jsonl'))).toBe(true);
    expect(hidden(join(sessions, '2026_free.jsonl'))).toBe(false);
  });

  it('lets a file go when its record goes, and reads a record again only when it changed', async () => {
    const { sessions, record, bindings } = world();
    // Names of one length: the record's size stays the same when it names the other.
    const first = join(sessions, '2026_one.jsonl');
    const second = join(sessions, '2026_two.jsonl');
    const file = record(`${ADAPTER_ID}.json`, { cwd: '/project', file: first });
    // A whole second, which every file system keeps exactly.
    const second0 = 1_790_000_000;
    utimesSync(file, second0, second0);
    expect([...(await bindings.files())]).toEqual([first]);
    // Same size and time: the record is not read again.
    record(`${ADAPTER_ID}.json`, { cwd: '/project', file: second });
    utimesSync(file, second0, second0);
    expect([...(await bindings.files())]).toEqual([first]);
    utimesSync(file, second0 + 5, second0 + 5);
    expect([...(await bindings.files())]).toEqual([second]);
    rmSync(file);
    expect([...(await bindings.files())]).toEqual([]);
  });

  it.skipIf(!linking)(
    'matches a file listed through a linked folder, and binds nothing without a record folder',
    async () => {
      const { home, sessions, record, bindings } = world();
      const run = join(sessions, '2026_run.jsonl');
      writeFileSync(run, '');
      record(`${ADAPTER_ID}.json`, { cwd: '/project', file: run });
      const linked = join(home, 'linked-sessions');
      symlinkSync(sessions, linked);
      expect(boundFile(await bindings.files())(join(linked, '2026_run.jsonl'))).toBe(true);
      await expect(new AcpBindings(() => join(home, 'missing')).files()).resolves.toEqual(new Set());
      await expect(new AcpBindings(() => undefined).files()).resolves.toEqual(new Set());
    }
  );
});
