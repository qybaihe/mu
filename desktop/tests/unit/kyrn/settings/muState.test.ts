import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../../../../packages/desktop/src/process/agent/kyrn/settings';
import manifest from './manifest.fixture.json';
import { withOwnPlaces } from './muState.fixture';

type Json = Record<string, unknown>;

/** A harness root with a manifest, and an agent directory with the given mu.json and files under `mu/`. */
function fixture(config: Json | undefined, own: { permissions?: string; board?: string } = {}, harness: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'mu-own-'));
  const dir = join(root, 'agent');
  mkdirSync(join(dir, 'mu'), { recursive: true });
  if (config) writeFileSync(join(dir, 'mu.json'), JSON.stringify(config, null, '\t'));
  if (own.permissions !== undefined) writeFileSync(join(dir, 'mu', 'permissions.json'), own.permissions);
  if (own.board !== undefined) writeFileSync(join(dir, 'mu', 'board.json'), own.board);
  mkdirSync(join(root, 'packages', 'kyrn-judge'), { recursive: true });
  writeFileSync(join(root, 'packages', 'kyrn-judge', 'manifest.json'), JSON.stringify(harness));
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  return {
    dir,
    store: new SettingsStore(dir, root),
    read,
    json: (name: string) => JSON.parse(read(name)) as Json,
    write: (name: string, text: string) => writeFileSync(join(dir, name), text),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function using(
  config: Json | undefined,
  own: { permissions?: string; board?: string },
  work: (f: ReturnType<typeof fixture>) => void,
  harness: unknown = withOwnPlaces(manifest)
): void {
  const f = fixture(config, own, harness);
  try {
    work(f);
  } finally {
    f.cleanup();
  }
}

const picked = (mode: string, version = 1) => JSON.stringify({ version, mode });
const board = (patch: Json = {}) => JSON.stringify({ version: 1, projects: { '/work/app': true }, ...patch });

describe('the permission mode of a new conversation', () => {
  it('is the last pick, else what mu.json says, else the harness default', () => {
    using(undefined, {}, (f) => expect(f.store.read().permissions).toEqual({ mode: 'judge', from: 'default' }));
    const config = { features: { permissions: { mode: 'ask' } } };
    using(config, {}, (f) => expect(f.store.read().permissions).toEqual({ mode: 'ask', from: 'config' }));
    using(config, { permissions: picked('full') }, (f) =>
      expect(f.store.read().permissions).toEqual({ mode: 'full', from: 'picked' })
    );
    // A file mu would not read does not count, as in mu.
    for (const permissions of [picked('full', 2), picked('root'), '{not json'])
      using(config, { permissions }, (f) =>
        expect(f.store.read().permissions).toEqual({ mode: 'ask', from: 'config' })
      );
    // A harness without permission modes has nothing to show.
    using(
      undefined,
      { permissions: picked('full') },
      (f) => expect(f.store.read().permissions.mode).toBe(''),
      manifest
    );
  });

  it('is saved where /permissions keeps it, owner-only, and only when it changes', () => {
    using({ tiers: ['jev'] }, {}, (f) => {
      const read = f.store.read();
      // Saving something else writes no permission file.
      f.store.save({ ...read, mode: 'off' });
      expect(() => f.read('mu/permissions.json')).toThrow();

      const saved = f.store.save({ ...f.store.read(), permissions: { mode: 'full' } });
      expect(saved.permissions).toEqual({ mode: 'full', from: 'picked' });
      expect(f.json('mu/permissions.json')).toEqual({ version: 1, mode: 'full' });
      // Windows has no mode bits: a file in the user's profile is theirs through the folder's access rules.
      if (process.platform !== 'win32') {
        expect(statSync(join(f.dir, 'mu', 'permissions.json')).mode & 0o777).toBe(0o600);
      }
      // mu.json is not where it goes.
      expect(f.json('mu.json')).toEqual({ tiers: ['jev'], modes: { default: 'off' } });

      expect(() => f.store.save({ ...saved, permissions: { mode: 'root' } })).toThrow('Invalid permission mode');
      expect(f.json('mu/permissions.json')).toEqual({ version: 1, mode: 'full' });
    });
  });

  it('makes a save stale once it is switched elsewhere', () => {
    using(undefined, { permissions: picked('judge') }, (f) => {
      const read = f.store.read();
      // A switch in a conversation, typed while the settings were open.
      f.write('mu/permissions.json', picked('ask'));
      expect(() => f.store.save({ ...read, permissions: { mode: 'full' } })).toThrow('Configuration changed');
      expect(f.json('mu/permissions.json')).toEqual({ version: 1, mode: 'ask' });
    });
  });
});

describe('the model that writes the board', () => {
  it('is the one picked for the board, unless mu.json names one, which mu reads first', () => {
    using(undefined, {}, (f) => expect(f.store.read().boardModel).toEqual({ supported: true, model: '' }));
    using(undefined, { board: board({ model: 'anthropic/claude-opus-4-6' }) }, (f) =>
      expect(f.store.read().boardModel.model).toBe('anthropic/claude-opus-4-6')
    );
    using(undefined, { board: board({ model: 'no-slash' }) }, (f) => expect(f.store.read().boardModel.model).toBe(''));
    using({ features: { board: { model: 'google/gemini-3.8-flash' } } }, { board: board({ model: 'session' }) }, (f) =>
      expect(f.store.read().boardModel.model).toBe('google/gemini-3.8-flash')
    );
    using(undefined, {}, (f) => expect(f.store.read().boardModel.supported).toBe(false), manifest);
  });

  it('is saved into board.json with every project switch kept, and takes over from mu.json', () => {
    const config = { features: { board: { model: 'google/gemini-3.8-flash', defaultOn: true } } };
    using(config, { board: board({ model: 'session' }) }, (f) => {
      const saved = f.store.save({ ...f.store.read(), boardModel: { model: 'openrouter/anthropic/claude-opus-4.6' } });
      expect(saved.boardModel.model).toBe('openrouter/anthropic/claude-opus-4.6');
      expect(f.json('mu/board.json')).toEqual({
        version: 1,
        projects: { '/work/app': true },
        model: 'openrouter/anthropic/claude-opus-4.6',
      });
      expect(f.json('mu.json')).toEqual({ features: { board: { defaultOn: true } } });

      f.store.save({ ...f.store.read(), boardModel: { model: 'session' } });
      expect(f.json('mu/board.json').model).toBe('session');
      // None: asked again the first time the board is switched on.
      f.store.save({ ...f.store.read(), boardModel: { model: '' } });
      expect(f.json('mu/board.json')).toEqual({ version: 1, projects: { '/work/app': true } });
    });
  });

  it('refuses what mu would not read, and a harness that cannot be told', () => {
    using(undefined, {}, (f) => {
      const read = f.store.read();
      for (const model of ['no-slash', 'a b/c', '/model'])
        expect(() => f.store.save({ ...read, boardModel: { model } })).toThrow('Invalid board model');
      expect(() => f.read('mu/board.json')).toThrow();
    });
    using(
      undefined,
      {},
      (f) =>
        expect(() => f.store.save({ ...f.store.read(), boardModel: { model: 'session' } })).toThrow(
          'cannot be told which model writes the board'
        ),
      manifest
    );
  });

  it('keeps a save fresh when a project is switched, but not when the model is changed elsewhere', () => {
    using(undefined, { board: board({ model: 'session' }) }, (f) => {
      const read = f.store.read();
      f.write('mu/board.json', board({ model: 'session', projects: { '/work/app': false, '/work/site': true } }));
      const saved = f.store.save({ ...read, mode: 'off' });
      f.write('mu/board.json', board({ model: 'anthropic/claude-opus-4-6' }));
      expect(() => f.store.save({ ...saved, mode: 'active' })).toThrow('Configuration changed');
    });
  });
});
