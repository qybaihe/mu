import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  insideSessionFolders,
  sessionFolders,
} from '../../../../../../packages/desktop/src/process/services/nativeHost/sessions/folders.ts';
import { canSymlink } from '../symlinks.ts';

const linking = canSymlink();

/** Where the sessions are, by the launcher's and pi's rules, without starting anything. */

const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-session-folders-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const noSettings = (): string => {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};

describe('sessionFolders', () => {
  it('is <mu home>/agent/sessions by default', () => {
    const home = join(root, 'plain');
    mkdirSync(home);
    expect(sessionFolders({ env: {}, home, readFile: noSettings })).toEqual({
      agentDir: join(home, '.mu', 'agent'),
      sessionsDir: join(home, '.mu', 'agent', 'sessions'),
    });
  });

  it('follows a home not moved from ~/.kyrn yet', () => {
    const home = join(root, 'legacy');
    mkdirSync(join(home, '.kyrn'), { recursive: true });
    expect(sessionFolders({ env: {}, home, readFile: noSettings }).agentDir).toBe(join(home, '.kyrn', 'agent'));
  });

  it('takes the agent folder the environment names, in the launcher’s order', () => {
    const home = join(root, 'env');
    expect(
      sessionFolders({ env: { MU_AGENT_DIR: '/a', MU_CODING_AGENT_DIR: '/b' }, home, readFile: noSettings })
    ).toEqual({
      agentDir: '/a',
      sessionsDir: '/a/sessions',
    });
    expect(
      sessionFolders({ env: { KYRN_AGENT_DIR: '/k', MU_CODING_AGENT_DIR: '/b' }, home, readFile: noSettings }).agentDir
    ).toBe('/k');
    expect(sessionFolders({ env: { MU_CODING_AGENT_DIR: '/b' }, home, readFile: noSettings }).agentDir).toBe('/b');
  });

  it('adds the session folder the configuration names: the environment first, then the settings', () => {
    const home = join(root, 'custom');
    const agentDir = join(home, 'agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ sessionDir: '~/all-sessions' }));
    expect(sessionFolders({ env: { MU_AGENT_DIR: agentDir }, home }).customDir).toBe(join(home, 'all-sessions'));
    expect(
      sessionFolders({ env: { MU_AGENT_DIR: agentDir, MU_CODING_AGENT_SESSION_DIR: '/elsewhere' }, home }).customDir
    ).toBe('/elsewhere');
    writeFileSync(join(agentDir, 'settings.json'), '{ not json');
    expect(sessionFolders({ env: { MU_AGENT_DIR: agentDir }, home }).customDir).toBeUndefined();
  });
});

describe('insideSessionFolders', () => {
  const agentDir = join(root, 'inside', 'agent');
  const project = join(agentDir, 'sessions', '--project--');
  mkdirSync(project, { recursive: true });
  const folders = { agentDir, sessionsDir: join(agentDir, 'sessions'), customDir: join(root, 'inside', 'flat') };

  it('allows session files in a session folder only', () => {
    expect(insideSessionFolders(folders, join(project, '2026_a.jsonl'))).toBe(true);
    expect(insideSessionFolders(folders, join(root, 'inside', 'flat', '2026_b.jsonl'))).toBe(true);
    expect(insideSessionFolders(folders, join(project, 'notes.txt'))).toBe(false);
    expect(insideSessionFolders(folders, join(agentDir, 'settings.jsonl'))).toBe(false);
    expect(insideSessionFolders(folders, join(project, '..', '..', '..', 'x.jsonl'))).toBe(false);
    expect(insideSessionFolders(folders, join(agentDir, 'sessions'))).toBe(false);
    expect(insideSessionFolders(folders, '/etc/passwd.jsonl')).toBe(false);
  });

  it.skipIf(!linking)('sees through a folder that is a link to somewhere else', () => {
    const outside = join(root, 'inside', 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(agentDir, 'sessions', '--linked--'));
    expect(insideSessionFolders(folders, join(agentDir, 'sessions', '--linked--', '2026_c.jsonl'))).toBe(false);
  });
});
