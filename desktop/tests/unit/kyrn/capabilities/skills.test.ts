/**
 * The skills page reads what mu loads from mu's own folders and the tools it takes skills over from, by the harness's
 * rules, and changes only mu's own folder. Every home here is a temporary folder: never the real ~/.mu or ~/.claude.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KyrnError } from '@/common/kyrn/errors';
import { addSkill, listSkills, removeSkill, type SkillRoots } from '@/process/agent/kyrn/capabilities/skills';
import { muAgentDir } from '@/process/agent/kyrn/naming';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'mu-skills-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill file: frontmatter with these fields (a description unless left out), then a line of text. */
function skill(path: string, fields: Record<string, string> = {}, body = 'How to do it.'): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const lines = Object.entries({ description: 'Does a thing.', ...fields })
    .filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}: ${value}`);
  writeFileSync(path, `---\n${lines.join('\n')}\n---\n\n${body}\n`);
}

/** A home with mu's agent folder in it, and a harness's folder of the skills that come with mu. */
function roots(): SkillRoots & { muJson: (value: unknown) => void } {
  const home = temp();
  const agentDir = join(home, '.mu', 'agent');
  mkdirSync(agentDir, { recursive: true });
  const builtinDir = join(temp(), 'skills');
  skill(join(builtinDir, 'mu-browser', 'SKILL.md'), { name: 'mu-browser' });
  skill(join(builtinDir, 'mu-github', 'SKILL.md'), { name: 'mu-github' });
  return {
    home,
    agentDir,
    builtinDir,
    muJson: (value) => writeFileSync(join(agentDir, 'mu.json'), JSON.stringify(value)),
  };
}

/** Name and source of each listed skill, in order. */
const names = (where: SkillRoots) => listSkills(where).skills.map((each) => `${each.source}:${each.name}`);

/** The code and params a call failed with. */
async function failure(work: () => unknown): Promise<{ code: string; params: unknown }> {
  try {
    await work();
  } catch (error) {
    if (error instanceof KyrnError) return { code: error.code, params: error.params };
    throw error;
  }
  throw new Error('it did not fail');
}

describe('the skills mu loads', () => {
  it('lists every folder in the order mu loads them, and of two with one name only the first', () => {
    const where = roots();
    const own = join(where.agentDir, 'skills');
    skill(join(own, 'review', 'SKILL.md'));
    // pi takes a Markdown file right in its folder too; its name is then the folder's unless it gives one.
    skill(join(own, 'notes.md'), { name: 'quick-notes' });
    skill(join(own, 'group', 'deep', 'SKILL.md'), { name: 'deep' });
    skill(join(where.home, '.agents', 'skills', 'shared', 'SKILL.md'));
    // In the shared folder a Markdown file counts below the root, not in it.
    skill(join(where.home, '.agents', 'skills', 'loose.md'), { name: 'loose' });
    skill(join(where.home, '.agents', 'skills', 'more', 'nested.md'), { name: 'nested' });
    skill(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'));
    skill(join(where.home, '.claude', 'skills', 'review', 'SKILL.md'));
    skill(join(where.home, '.claude', 'skills', 'team', 'a', 'b', 'SKILL.md'), { name: 'deep-claude' });
    skill(join(where.home, '.codex', 'skills', 'slides', 'SKILL.md'));
    // Codex's own skills, and one without a description, are not loaded.
    skill(join(where.home, '.codex', 'skills', '.system', 'installer', 'SKILL.md'));
    skill(join(where.home, '.codex', 'skills', 'empty', 'SKILL.md'), { description: '' });
    expect(names(where)).toEqual([
      'mu:deep',
      'mu:quick-notes',
      'mu:review',
      'agents:nested',
      'agents:shared',
      'builtin:mu-browser',
      'builtin:mu-github',
      'claude:pdf',
      'claude:deep-claude',
      'codex:slides',
    ]);
    const review = listSkills(where).skills.find((each) => each.name === 'review');
    expect(review).toMatchObject({ description: 'Does a thing.', file: join(own, 'review', 'SKILL.md') });
  });

  it('lists a skill reached through several links once, and skips one whose frontmatter does not parse', () => {
    const where = roots();
    const store = join(temp(), 'store');
    skill(join(store, 'linked', 'SKILL.md'));
    mkdirSync(join(where.home, '.claude', 'skills'), { recursive: true });
    mkdirSync(join(where.home, '.codex', 'skills'), { recursive: true });
    symlinkSync(join(store, 'linked'), join(where.home, '.claude', 'skills', 'linked'));
    symlinkSync(join(store, 'linked'), join(where.home, '.codex', 'skills', 'also-linked'));
    mkdirSync(join(where.home, '.codex', 'skills', 'broken'), { recursive: true });
    writeFileSync(join(where.home, '.codex', 'skills', 'broken', 'SKILL.md'), '---\ndescription: [unclosed\n---\n');
    expect(names(where).filter((name) => !name.startsWith('builtin:'))).toEqual(['claude:linked']);
  });

  it('follows mu.json: what it takes over, and the features that bring the skills that come with mu', () => {
    const where = roots();
    skill(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'));
    skill(join(where.home, '.codex', 'skills', 'slides', 'SKILL.md'));
    where.muJson({ features: { inherit: { claude: false }, browser: false, packs: { github: false } } });
    expect(names(where)).toEqual(['codex:slides']);
    where.muJson({ features: { inherit: false, packs: false } });
    expect(names(where)).toEqual(['builtin:mu-browser']);
    where.muJson({ features: { inherit: { skills: false } } });
    expect(names(where)).toEqual(['builtin:mu-browser', 'builtin:mu-github']);
    // A mu.json that does not parse is mu's defaults, as the harness takes it.
    writeFileSync(join(where.agentDir, 'mu.json'), '{ not json');
    expect(names(where)).toEqual(['builtin:mu-browser', 'builtin:mu-github', 'claude:pdf', 'codex:slides']);
  });

  it('lets only a skill of its own in mu’s folder be removed', () => {
    const where = roots();
    skill(join(where.agentDir, 'skills', 'review', 'SKILL.md'));
    skill(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'));
    const removable = Object.fromEntries(listSkills(where).skills.map((each) => [each.name, each.removable]));
    expect(removable).toEqual({ review: true, 'mu-browser': false, 'mu-github': false, pdf: false });
    // A SKILL.md right in the folder makes the folder itself one skill: that is not removed from here.
    skill(join(where.agentDir, 'skills', 'SKILL.md'), { name: 'whole' });
    expect(listSkills(where).skills.find((each) => each.name === 'whole')?.removable).toBe(false);
  });

  it('finds the agent folder as mu’s launcher does', () => {
    const home = temp();
    expect(muAgentDir({}, home)).toBe(join(home, '.mu', 'agent'));
    expect(muAgentDir({ MU_CODING_AGENT_DIR: '/x/coding' }, home)).toBe('/x/coding');
    expect(muAgentDir({ MU_AGENT_DIR: '/x/agent', MU_CODING_AGENT_DIR: '/x/coding' }, home)).toBe('/x/agent');
    expect(muAgentDir({ KYRN_AGENT_DIR: '/x/old' }, home)).toBe('/x/old');
  });
});

describe('adding a skill', () => {
  it('copies the folder under the skill’s name, without its history or packages, from the folder or its SKILL.md', async () => {
    const where = roots();
    const source = join(temp(), 'downloaded-folder');
    skill(join(source, 'SKILL.md'), { name: 'my-skill' });
    writeFileSync(join(source, 'helper.py'), 'print(1)\n');
    mkdirSync(join(source, '.git'), { recursive: true });
    writeFileSync(join(source, '.git', 'HEAD'), 'ref\n');
    mkdirSync(join(source, 'node_modules', 'x'), { recursive: true });
    const after = await addSkill(where, join(source, 'SKILL.md'));
    const target = join(where.agentDir, 'skills', 'my-skill');
    expect(after.skills.find((each) => each.name === 'my-skill')).toMatchObject({ source: 'mu', removable: true });
    expect(readFileSync(join(target, 'helper.py'), 'utf8')).toBe('print(1)\n');
    expect(existsSync(join(target, '.git'))).toBe(false);
    expect(existsSync(join(target, 'node_modules'))).toBe(false);
    // The source is left as it was.
    expect(existsSync(join(source, '.git', 'HEAD'))).toBe(true);
  });

  it('names what is wrong: no description, a name no folder can have, a name mu has, a folder too large', async () => {
    const where = roots();
    const base = temp();
    skill(join(base, 'plain', 'SKILL.md'), { description: '' });
    expect(await failure(() => addSkill(where, join(base, 'plain')))).toMatchObject({ code: 'skillInvalid' });
    expect(await failure(() => addSkill(where, join(base, 'nothing-here')))).toMatchObject({ code: 'skillInvalid' });
    skill(join(base, 'bad', 'SKILL.md'), { name: '../escape' });
    expect(await failure(() => addSkill(where, join(base, 'bad')))).toEqual({
      code: 'skillName',
      params: { name: '../escape' },
    });
    skill(join(base, 'Upper', 'SKILL.md'));
    expect(await failure(() => addSkill(where, join(base, 'Upper')))).toMatchObject({ code: 'skillName' });
    skill(join(where.home, '.agents', 'skills', 'shared', 'SKILL.md'));
    skill(join(base, 'shared', 'SKILL.md'));
    expect(await failure(() => addSkill(where, join(base, 'shared')))).toEqual({
      code: 'skillExists',
      params: { name: 'shared' },
    });
    expect(await failure(() => addSkill(where, 'relative/folder'))).toMatchObject({ code: 'invalid' });
    const big = join(base, 'big');
    skill(join(big, 'SKILL.md'));
    mkdirSync(join(big, 'data'));
    for (let index = 0; index < 2001; index++) writeFileSync(join(big, 'data', `${index}.txt`), '');
    expect(await failure(() => addSkill(where, big))).toMatchObject({ code: 'skillTooLarge' });
    expect(existsSync(join(where.agentDir, 'skills', 'big'))).toBe(false);
  });

  it('adds a skill of a name another tool has: mu’s copy is then the one loaded', async () => {
    const where = roots();
    skill(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'));
    const source = join(temp(), 'pdf');
    skill(join(source, 'SKILL.md'));
    const after = await addSkill(where, source);
    expect(after.skills.filter((each) => each.name === 'pdf').map((each) => each.source)).toEqual(['mu']);
  });
});

describe('removing a skill', () => {
  it('moves a skill of mu’s folder to the trash, and refuses any other, saying where it comes from', async () => {
    const where = roots();
    skill(join(where.agentDir, 'skills', 'review', 'SKILL.md'));
    skill(join(where.agentDir, 'skills', 'notes.md'), { name: 'quick-notes' });
    skill(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'));
    const trashed: string[] = [];
    const trash = vi.fn(async (path: string) => {
      trashed.push(path);
      rmSync(path, { recursive: true, force: true });
    });
    const after = await removeSkill(where, 'review', trash);
    expect(trashed).toEqual([join(where.agentDir, 'skills', 'review')]);
    expect(after.skills.some((each) => each.name === 'review')).toBe(false);
    await removeSkill(where, 'quick-notes', trash);
    expect(trashed[1]).toBe(join(where.agentDir, 'skills', 'notes.md'));
    expect(await failure(() => removeSkill(where, 'pdf', trash))).toEqual({
      code: 'notMine',
      params: { name: 'pdf', source: 'claude' },
    });
    expect(await failure(() => removeSkill(where, 'mu-browser', trash))).toMatchObject({
      code: 'notMine',
      params: { source: 'builtin' },
    });
    expect(await failure(() => removeSkill(where, 'gone', trash))).toEqual({
      code: 'notFound',
      params: { name: 'gone' },
    });
    expect(trash).toHaveBeenCalledTimes(2);
    expect(existsSync(join(where.home, '.claude', 'skills', 'pdf', 'SKILL.md'))).toBe(true);
  });
});
