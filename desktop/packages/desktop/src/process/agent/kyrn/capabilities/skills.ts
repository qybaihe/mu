import { lstatSync, readdirSync, statSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isSkillName, type MuSkill, type MuSkills, type SkillSource } from '../../../../common/kyrn/capabilities';
import { KyrnError } from '../../../../common/kyrn/errors';
import { text } from '../piRpc';
import {
  INHERIT_DEFAULTS,
  MAX_SKILL_BYTES,
  canonical,
  featureOptions,
  frontmatter,
  readMuConfig,
  readName,
  readPath,
  readSmall,
} from './files';

/*
 * The skills mu loads in every conversation, where each comes from, and the two changes the settings page makes: a
 * skill folder copied into mu's skills folder, and one of mu's own moved to the trash. In the order mu loads them, the
 * first of a name wins (pi keeps the first and drops the others):
 *
 *   <agentDir>/skills           pi's own folder: SKILL.md folders, and Markdown files right in it
 *   ~/.agents/skills            the folder agents share: SKILL.md folders, and Markdown files below it
 *   <mu>/skills                 the skills that come with mu, each with the feature that brings it
 *   ~/.claude/skills            taken over from Claude Code (mu's `features.inherit`)
 *   ~/.codex/skills             taken over from Codex
 *
 * A project's folders (`.mu/skills`, `.agents/skills`, `.claude/skills`) and pi packages are not read: they depend on
 * the project and on mu's trust in it. Ignore files in a skills folder are not applied.
 */

export type SkillRoots = {
  agentDir: string;
  /** The person's home: `.agents`, `.claude` and `.codex` are looked for there. */
  home: string;
  /** The skills that come with mu: `skills` next to the harness's manifest. */
  builtinDir?: string;
};

/** The features that bring a skill that comes with mu; a skill not named here comes whenever mu runs. */
const BUILTIN_FEATURES: Record<string, (config: Parameters<typeof featureOptions>[0]) => boolean> = {
  'mu-browser': (config) => Boolean(featureOptions(config, 'browser', { enabled: true }).enabled),
  'mu-github': (config) => {
    const packs = featureOptions(config, 'packs', { enabled: true, github: true });
    return Boolean(packs.enabled) && Boolean(packs.github);
  },
};

/** A skill file pi takes: frontmatter that parses and a description; the name from it, else the folder's. */
function readSkill(file: string): { name: string; description: string } | undefined {
  const content = readSmall(file, MAX_SKILL_BYTES);
  if (content === undefined) return undefined;
  let fields: ReturnType<typeof frontmatter>;
  try {
    fields = frontmatter(content);
  } catch {
    return undefined;
  }
  const description = text(fields.description).trim();
  if (!description) return undefined;
  const name = text(fields.name).trim() || basename(dirname(file));
  return { name, description };
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Entry names of a folder, sorted, without hidden ones and node_modules; none when it cannot be read. */
function entries(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => !name.startsWith('.') && name !== 'node_modules')
      .toSorted();
  } catch {
    return [];
  }
}

/**
 * The skill files below `root` as pi collects them (`collectSkillEntries`): a folder with a SKILL.md is one skill and
 * is not searched further; Markdown files count right in the root for pi's own folder (`pi`), below it for the shared
 * one (`agents`). Links are followed, each folder once.
 */
function collect(root: string, mode: 'pi' | 'agents', dir = root, seen = new Set<string>()): string[] {
  const real = canonical(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  if (isFile(join(dir, 'SKILL.md'))) return [join(dir, 'SKILL.md')];
  const files: string[] = [];
  for (const name of entries(dir)) {
    const path = join(dir, name);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue;
    }
    if (stats.isDirectory()) files.push(...collect(root, mode, path, seen));
    else if (stats.isFile() && name.endsWith('.md') && (mode === 'pi') === (dir === root)) files.push(path);
  }
  return files;
}

/** Skill folders below `root` as mu takes them over (`skillsBelow`): a folder with a SKILL.md, three levels deep. */
function inherited(root: string, depth = 3): string[] {
  const files: string[] = [];
  for (const name of entries(root)) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const file = join(dir, 'SKILL.md');
    if (isFile(file) && readSkill(file)) files.push(file);
    else if (depth > 0) files.push(...inherited(dir, depth - 1));
  }
  return files;
}

/** mu's skills folder. */
export const skillsFolder = (roots: Pick<SkillRoots, 'agentDir'>): string => join(roots.agentDir, 'skills');

/** Whether `path` is `folder` or anything below it. */
function isInside(folder: string, path: string): boolean {
  const within = relative(folder, path);
  return !(within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within));
}

/** Whether anything, a dangling link too, already has this name. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** What the app moves to the trash to remove a skill of mu's folder: its folder, or its file when it is one. */
function removableTarget(folder: string, file: string): string | undefined {
  const target = basename(file) === 'SKILL.md' ? dirname(file) : file;
  return target !== folder && isInside(folder, target) ? target : undefined;
}

export function listSkills(roots: SkillRoots): MuSkills {
  const folder = skillsFolder(roots);
  const { config } = readMuConfig(roots.agentDir);
  const inherit = featureOptions(config, 'inherit', INHERIT_DEFAULTS);
  const takesOver = Boolean(inherit.enabled) && Boolean(inherit.skills);
  const sources: Array<{ source: SkillSource; files: string[] }> = [
    { source: 'mu', files: collect(folder, 'pi') },
    { source: 'agents', files: collect(join(roots.home, '.agents', 'skills'), 'agents') },
    {
      source: 'builtin',
      files: roots.builtinDir
        ? entries(roots.builtinDir)
            .filter((name) => BUILTIN_FEATURES[name]?.(config) ?? true)
            .map((name) => join(roots.builtinDir as string, name, 'SKILL.md'))
            .filter(isFile)
        : [],
    },
    { source: 'claude', files: takesOver && inherit.claude ? inherited(join(roots.home, '.claude', 'skills')) : [] },
    { source: 'codex', files: takesOver && inherit.codex ? inherited(join(roots.home, '.codex', 'skills')) : [] },
  ];
  const names = new Set<string>();
  const files = new Set<string>();
  const skills: MuSkill[] = [];
  for (const { source, files: found } of sources) {
    for (const file of found) {
      const skill = readSkill(file);
      const real = canonical(file);
      if (!skill || names.has(skill.name) || files.has(real)) continue;
      names.add(skill.name);
      files.add(real);
      skills.push({ ...skill, file, source, removable: source === 'mu' && !!removableTarget(folder, file) });
    }
  }
  return { folder, skills };
}

/** Files and bytes a skill folder may hold: a folder past them is not a skill. */
const MOST_FILES = 2000;
const MOST_BYTES = 50 * 1024 * 1024;
/** Left out of a copy: a repository's history and installed packages are no part of a skill. */
const NOT_COPIED = new Set(['.git', 'node_modules']);

/** Throws `skillTooLarge` when the folder holds more than a skill would. Links are not followed. */
async function checkSize(dir: string): Promise<void> {
  let files = 0;
  let bytes = 0;
  const walk = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (NOT_COPIED.has(entry.name)) continue;
      const child = join(path, entry.name);
      // oxlint-disable-next-line no-await-in-loop -- one entry after the other: the walk stops at the limit
      if (entry.isDirectory()) await walk(child);
      else {
        files += 1;
        // oxlint-disable-next-line no-await-in-loop -- as above
        bytes += entry.isFile() ? (await lstat(child)).size : 0;
        if (files > MOST_FILES || bytes > MOST_BYTES)
          throw new KyrnError('skillTooLarge', `${dir} holds more than a skill would`);
      }
    }
  };
  await walk(dir);
}

/**
 * Copies a skill into mu's skills folder, as a folder named after the skill: `path` is the skill's folder or its
 * SKILL.md. The name must be one a folder can have, and no skill of mu's folder or the shared one may have it.
 */
export async function addSkill(roots: SkillRoots, path: unknown): Promise<MuSkills> {
  const given = readPath(path);
  const dir = basename(given) === 'SKILL.md' && isFile(given) ? dirname(given) : given;
  const file = join(dir, 'SKILL.md');
  const skill = isFile(file) ? readSkill(file) : undefined;
  if (!skill) throw new KyrnError('skillInvalid', `${dir} has no SKILL.md with a description`);
  if (!isSkillName(skill.name))
    throw new KyrnError('skillName', `"${skill.name}" cannot be a skill's folder name`, { name: skill.name });
  const folder = skillsFolder(roots);
  const target = join(folder, skill.name);
  // A skill of that name in mu's folder or the shared one would win over the copy, which then would never load.
  const known = listSkills(roots).skills.some(
    (each) => each.name === skill.name && (each.source === 'mu' || each.source === 'agents')
  );
  if (known || isInside(canonical(folder), canonical(dir)) || occupied(target))
    throw new KyrnError('skillExists', `mu already has a skill named ${skill.name}`, { name: skill.name });
  await checkSize(dir);
  try {
    await mkdir(folder, { recursive: true });
    await cp(dir, target, {
      recursive: true,
      errorOnExist: true,
      force: false,
      filter: (source) => source === dir || !NOT_COPIED.has(basename(source)),
    });
  } catch (error) {
    // Half a skill is worse than none.
    await rm(target, { recursive: true, force: true }).catch((): undefined => undefined);
    throw new KyrnError('unwritable', error instanceof Error ? error.message : String(error), { file: target });
  }
  return listSkills(roots);
}

/**
 * Moves a skill of mu's own folder to the trash. A skill from anywhere else is never touched: the failure says where
 * it comes from instead.
 */
export async function removeSkill(
  roots: SkillRoots,
  name: unknown,
  trash: (path: string) => Promise<void>
): Promise<MuSkills> {
  const wanted = readName(name);
  const folder = skillsFolder(roots);
  const skill = listSkills(roots).skills.find((each) => each.name === wanted);
  if (!skill) throw new KyrnError('notFound', `No skill named ${wanted}`, { name: wanted });
  const target = skill.source === 'mu' ? removableTarget(folder, skill.file) : undefined;
  if (!target)
    throw new KyrnError('notMine', `${wanted} is not in mu's skills folder`, { name: wanted, source: skill.source });
  try {
    await trash(target);
  } catch (error) {
    throw new KyrnError('unwritable', error instanceof Error ? error.message : String(error), { file: target });
  }
  return listSkills(roots);
}
