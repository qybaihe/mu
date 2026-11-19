/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/**
 * The supervisor workspace's roster script (common/chat/supervisor/
 * positions.cjs), run for real against temp position libraries: the read-only
 * listing behind the supervisor's new-project dedup gate. The parsing mirrors
 * positionLibraryCore.ts — these runs are the cross-check that the script
 * side of that contract still holds (the same arrangement teamsScript.test
 * has with supervisorCore's TEAMS.md format).
 */

const SCRIPT_SRC = fileURLToPath(
  new URL('../../../packages/desktop/src/common/chat/supervisor/positions.cjs', import.meta.url)
);
const run = promisify(execFile);

const dirs: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mu-positions-script-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const positionFile = (name: string, description: string, body = '', displayName = ''): string =>
  `---\nname: ${name}${displayName ? `\ndisplay_name: ${displayName}` : ''}\ndescription: ${description}\n---\n\n${name} 说明书。\n${body}`;

const list = async (library: string) => {
  const { stdout } = await run('node', [SCRIPT_SRC, 'list'], {
    env: { ...process.env, MU_POSITION_LIBRARY: library },
  });
  return stdout;
};

describe('positions.cjs list', () => {
  it('lists every position with its project root, skipping README and non-positions', async () => {
    const library = join(temp(), 'library');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, 'a-forwarder.md'),
      positionFile('forwarder', '货代岗', '- 项目根：`E:/Projects/forwarder`（单仓）\n')
    );
    writeFileSync(join(library, 'b-worker.md'), positionFile('worker', '通用执行岗'));
    writeFileSync(join(library, 'README.md'), '# 岗位库文档\n\n不是岗位。');
    writeFileSync(join(library, 'note.md'), '# 无 frontmatter 的笔记');

    const stdout = await list(library);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('POSITION forwarder | 货代岗 | project=E:/Projects/forwarder');
    expect(lines[1]).toBe('POSITION worker | 通用执行岗 | project=-');
    expect(lines[2]).toBe('COUNT 2');
  });

  it('lists a display_name position with the id beside it, and a plain one bare', async () => {
    const library = join(temp(), 'library');
    mkdirSync(library, { recursive: true });
    writeFileSync(join(library, 'a-forwarder.md'), positionFile('forwarder', '货代岗', '', '货代'));
    writeFileSync(join(library, 'b-worker.md'), positionFile('worker', '通用执行岗'));

    const stdout = await list(library);
    const lines = stdout.trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('POSITION 货代(forwarder) | 货代岗 | project=-');
    expect(lines[1]).toBe('POSITION worker | 通用执行岗 | project=-');
    expect(lines[2]).toBe('COUNT 2');
  });

  it('treats a missing library directory as an empty roster, not an error', async () => {
    const stdout = await list(join(temp(), 'not-there'));
    expect(stdout.trim()).toBe('COUNT 0');
  });

  it('refuses an unknown command with ERROR and a non-zero exit, like teams.cjs', async () => {
    await expect(
      run('node', [SCRIPT_SRC, 'create'], { env: { ...process.env, MU_POSITION_LIBRARY: join(temp(), 'x') } })
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('ERROR usage: positions.cjs <list>'),
    });
  });

  it('mirrors the core parser: no project root outside the backtick form', async () => {
    const library = join(temp(), 'library');
    mkdirSync(library, { recursive: true });
    writeFileSync(
      join(library, 'a-lab.md'),
      positionFile('image-lab', '图片岗', '常设负责项目 E:/Projects/image-lab（无反引号写法）\n')
    );
    const stdout = await list(library);
    expect(stdout).toContain('POSITION image-lab | 图片岗 | project=-');
  });

  it('is the file the service ships: read-only, never writes the library', async () => {
    const source = readFileSync(SCRIPT_SRC, 'utf8');
    expect(source).toContain('read-only');
    expect(source).not.toMatch(/writeFile|appendFile|rmSync|unlink/);
  });
});
