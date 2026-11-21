/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The creation wizard's pure half: reading a project directory's context
 * files (AGENTS.md, HANDOFF.md, README, package.json — the files the user's
 * projects all carry) into a project profile, drafting the position the
 * wizard proposes from it (id, Chinese display-name candidates, description,
 * body with the project root line the library parser reads back), checking
 * the draft against the roster for overlap, and building the library
 * document the wizard writes. Everything here is text in, text out — the
 * file reads live in the position service, the fields in the wizard UI.
 *
 * The extraction is deliberately heuristic and cheap: no model calls, no
 * walking the tree — the first screen of each file, seconds at most. When
 * the files say nothing (`empty`), the wizard offers the AI deep analysis
 * instead: a one-shot mu run in the directory whose reply these functions
 * also build the prompt for and parse.
 */
import type { PositionInfo } from './positionLibraryCore';

/** The context files the analyzer reads, by the name it asks for them. */
export const PROJECT_CONTEXT_FILES = ['AGENTS.md', 'HANDOFF.md', 'README.md', 'package.json'] as const;

/** What the analyzer found in one project directory. */
export type ProjectProfile = {
  /** The directory as the picker returned it. */
  directory: string;
  /** The project's name: package.json name, doc heading, or the directory's own name. */
  projectName: string;
  /** What the project is working on, one line, when the files say so. */
  goal: string;
  /** The stack markers the files carry (package.json dependencies, language markers). */
  techStack: string[];
  /** The project's stated hard rules, a few, one line each. */
  constraints: string[];
  /** Which of the context files contributed anything. */
  sources: string[];
  /** True when the files said nothing usable — the wizard's cue to offer the AI deep analysis. */
  empty: boolean;
};

/** The wizard's proposal for the position to create, editable in step two. */
export type PositionDraft = {
  /** The frontmatter `name` and file stem: an English slug. */
  id: string;
  /** 2-3 display-name candidates, Chinese when the files carry Chinese. */
  displayNameCandidates: string[];
  /** The frontmatter `description`: one line of what the position owns. */
  description: string;
  /** The body below the frontmatter. */
  body: string;
  /** The project root the body names, and the library parser reads back. */
  projectRoot: string;
};

/** Why a draft overlaps one roster position. */
export type PositionOverlapReason = 'id' | 'name' | 'project-root' | 'description';

/** One roster position the draft collides with, and how. */
export type PositionOverlap = { position: PositionInfo; reasons: PositionOverlapReason[] };

/** A legal position id: lowercase slug, the library's file stem. */
export const POSITION_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The caps that keep a heuristic answer short: stack entries, constraint lines, name candidates. */
const STACK_CAP = 8;
const CONSTRAINT_CAP = 3;
const CONSTRAINT_MAX_CHARS = 120;
const NAME_CANDIDATE_CAP = 3;
/** How much of each file the analyzer reads: the first screen says enough. */
const FILE_READ_CHARS = 8192;
/** A HANDOFF section the analyzer treats as the goal, other than the dated entries. */
const GOAL_SECTION_RE = /^#{1,2}\s*(当前目标|目标|Current goal)\s*$/;
/** A dated HANDOFF entry heading: `## 2026-11-19 · Some task`, any separator after the date. */
const DATED_HEADING_RE = /^#{1,2}\s*\d{4}-\d{2}-\d{2}\s*[·•—-]\s*(.+)$/;
/** The first `#` heading of a doc, whose text names the project. */
const H1_RE = /^#\s+(.+)$/;

const asLines = (text: string): string[] => text.split(/\r?\n/);

/** One markdown line's plain text: bold marks, links and code spans folded away. */
const plainLine = (line: string): string =>
  line
    .replace(/^[-*]\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();

/** The part of a doc title that names the project: before the em dash, or the whole title. */
const titleNamePart = (title: string): string => {
  const beforeDash = title.split(/[—–|]/)[0].trim();
  return beforeDash || title.trim();
};

/** The leading CJK run of a text, up to `cap` characters, when it starts with one. */
const leadingCjk = (text: string, cap: number): string | undefined => {
  const match = /^[\u4e00-\u9fff\u3400-\u4dbf「」（）()·、，,]+/.exec(text.replace(/\s+/g, ' ').trim());
  if (!match) return undefined;
  const cjkOnly = match[0].replace(/[「」（）()·、，,]/g, '');
  return cjkOnly ? cjkOnly.slice(0, cap) : undefined;
};

/** A package.json name without its scope, when it looks like a name at all. */
const packageName = (raw: string | undefined): string | undefined => {
  const name = raw?.trim().replace(/^@[^/]+\//, '');
  return name && /^[\w.-]+$/.test(name) ? name : undefined;
};

/** The first `#` heading of a markdown text. */
const firstH1 = (markdown: string): string | undefined => {
  for (const line of asLines(markdown)) {
    const match = H1_RE.exec(line);
    if (match) return match[1].trim();
  }
  return undefined;
};

/** The text of a `##` section: its first non-empty, non-heading line. */
const sectionFirstLine = (markdown: string, heading: RegExp): string | undefined => {
  const lines = asLines(markdown);
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,2}\s/.test(line)) {
      inSection = heading.test(line.trim());
      continue;
    }
    if (!inSection) continue;
    const plain = plainLine(line);
    if (plain) return plain;
  }
  return undefined;
};

/** The project's stated hard-rule lines: bold list lines that say a rule, capped and truncated. */
const extractConstraints = (markdown: string): string[] => {
  const found: string[] = [];
  for (const line of asLines(markdown)) {
    if (found.length >= CONSTRAINT_CAP) break;
    if (/^#{1,6}\s/.test(line)) continue; // a heading names a rule section; it is not a rule
    if (!/禁止|不许|红线|铁律|门禁|必须|never|must not/i.test(line)) continue;
    const plain = plainLine(line);
    if (!plain) continue;
    found.push(plain.slice(0, CONSTRAINT_MAX_CHARS));
  }
  return found;
};

/** The stack a package.json declares: dependency names in their written order. */
const packageStack = (pkgText: string | undefined): string[] => {
  if (pkgText === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(pkgText);
  } catch {
    return [];
  }
  const deps = parsed as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const names = [...Object.keys(deps.dependencies ?? {}), ...Object.keys(deps.devDependencies ?? {})];
  return names.slice(0, STACK_CAP);
};

/** The positioning line of an AGENTS.md — `> 定位：…` — when it opens with one. */
const agentsPositioning = (markdown: string): string | undefined => {
  for (const line of asLines(markdown)) {
    if (!line.startsWith('>')) continue;
    const quoted = line.replace(/^>\s?/, '').trim();
    if (!quoted) continue;
    return quoted.replace(/^定位[：:]\s*/, '');
  }
  return undefined;
};

/** One line of prose from a text: the first short-ish paragraph line. */
const firstParagraphLine = (markdown: string): string | undefined => {
  for (const line of asLines(markdown)) {
    const plain = plainLine(line);
    if (!plain || plain.startsWith('#') || plain.startsWith('>')) continue;
    if (plain.length > 200) continue;
    return plain;
  }
  return undefined;
};

/** The directory's own name, the last path segment, whatever the separator. */
const directoryName = (directory: string): string => {
  const parts = directory.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || directory;
};

/**
 * The heuristic profile of one project directory: its context files' first
 * screens read into a name, a goal, a stack and constraints. Zero model
 * calls, zero directory walking beyond the named files — the caller hands
 * their contents in (`undefined` = not there). `empty` is true when nothing
 * contributed, the wizard's cue to offer the AI deep analysis.
 */
export function analyzeProjectProfile(input: {
  directory: string;
  files: { [name in (typeof PROJECT_CONTEXT_FILES)[number]]?: string };
  /** Top-level file names the directory carries, for stack markers beyond package.json. */
  entries?: readonly string[];
}): ProjectProfile {
  const entries = input.entries ?? [];
  const entryNames = new Set(entries.map((name) => name.toLowerCase()));
  const handoff = input.files['HANDOFF.md'];
  const readme = input.files['README.md'];
  const pkg = input.files['package.json'];
  const agents = input.files['AGENTS.md'];

  let parsedPkg: { name?: string } | undefined;
  if (pkg !== undefined) {
    try {
      parsedPkg = JSON.parse(pkg) as { name?: string };
    } catch {
      parsedPkg = undefined;
    }
  }

  // The name: the package's, else the docs' first heading (before its dash), else the directory's.
  const docTitle = firstH1(agents ?? '') ?? firstH1(readme ?? '');
  const pkgName = packageName(parsedPkg?.name);
  const projectName = pkgName ?? (docTitle ? titleNamePart(docTitle) : undefined) ?? directoryName(input.directory);

  // The goal: the HANDOFF's own goal section, else its newest dated entry, else the docs' positioning line.
  let goal: string | undefined = handoff === undefined ? undefined : sectionFirstLine(handoff, GOAL_SECTION_RE);
  if (!goal && handoff !== undefined) {
    for (const line of asLines(handoff)) {
      const match = DATED_HEADING_RE.exec(line);
      if (match) {
        goal = match[1].trim();
        break;
      }
    }
  }
  if (!goal && agents !== undefined) goal = sectionFirstLine(agents, /^#{1,2}\s*(定位|当前目标|目标)\s*$/);
  if (!goal && agents !== undefined) goal = agentsPositioning(agents);
  if (!goal && readme !== undefined) goal = firstParagraphLine(readme);

  // The stack: package.json's dependencies plus any language marker files.
  const stack = packageStack(pkg);
  const markers: Array<[string, string]> = [
    ['pyproject.toml', 'Python'],
    ['requirements.txt', 'Python'],
    ['cargo.toml', 'Rust'],
    ['go.mod', 'Go'],
    ['pom.xml', 'Java'],
    ['composer.json', 'PHP'],
    ['deno.json', 'Deno'],
  ];
  for (const [marker, label] of markers) {
    if (stack.length >= STACK_CAP) break;
    if (entryNames.has(marker) && !stack.includes(label)) stack.push(label);
  }

  // The constraints: the hard-rule lines of AGENTS.md, then of HANDOFF.md, capped together.
  const constraints = [...extractConstraints(agents ?? ''), ...extractConstraints(handoff ?? '')].slice(
    0,
    CONSTRAINT_CAP
  );

  const sources = [
    ...(pkgName !== undefined || stack.length > 0 ? ['package.json'] : []),
    ...(agents !== undefined ? ['AGENTS.md'] : []),
    ...(handoff !== undefined ? ['HANDOFF.md'] : []),
    ...(readme !== undefined ? ['README.md'] : []),
  ];
  return {
    directory: input.directory,
    projectName,
    goal: goal ?? '',
    techStack: stack,
    constraints,
    sources,
    empty: sources.length === 0,
  };
}

/** The slug the wizard proposes as the position id: lowercase, dashes, nothing else. */
export const slugifyPositionId = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || 'position';
};

/** One line of prose: newlines folded to spaces, trimmed, capped. */
const oneLine = (text: string, cap: number): string => {
  const flat = text
    .replace(/\s*\r?\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
};

/**
 * The wizard's proposal from a profile: the id slug, the display-name
 * candidates (Chinese phrases the files actually carry, the project name
 * last), a one-line description in the library's own voice, and a body that
 * names the project root the way the library parser reads it back.
 */
export function buildPositionDraft(profile: ProjectProfile): PositionDraft {
  const docCandidates: string[] = [];

  // Candidate 1: the Chinese phrase of the goal, the way the user's own
  // libraries name positions (货代, MU开发 — short and CJK).
  const goalCjk = leadingCjk(profile.goal, 10);
  if (goalCjk) docCandidates.push(goalCjk);
  // The directory's own name is always a candidate: the user chose the folder.
  docCandidates.push(directoryName(profile.directory));

  const seen = new Set<string>();
  const displayNameCandidates = docCandidates.filter((name) => {
    const key = name.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (displayNameCandidates.length === 0) displayNameCandidates.push(profile.projectName);

  const goalShort = oneLine(profile.goal, 60);
  const stackShort = profile.techStack.slice(0, 3).join('/');
  const descriptionParts = [
    `${profile.projectName} 项目常设岗位`,
    goalShort ? `——${goalShort}` : '',
    stackShort ? `；涉及 ${profile.projectName}${stackShort ? `/${stackShort}` : ''} 相关任务时交给它` : '',
  ];
  const description = oneLine(descriptionParts.join(''), 160);

  const body = [
    `你是「${displayNameCandidates[0]}」岗位的常设负责 Bot（岗位即项目，跨任务常设，持续积累本岗记忆）。以下画像由创建向导从项目文件初始化，请在首次任务中核实并补全。`,
    '',
    '## 项目事实（开工必读）',
    `- 项目根：\`${profile.directory.replace(/\\/g, '/')}\``,
    profile.goal ? `- 当前目标：${goalShort}` : '',
    profile.techStack.length > 0 ? `- 技术栈：${profile.techStack.join('、')}` : '',
    ...(profile.constraints.length > 0
      ? [
          '- 关键约束（自项目文件抽取，开工先读项目 AGENTS.md 核实）：',
          ...profile.constraints.map((line) => `  - ${line}`),
        ]
      : []),
    '',
    '## 岗位职责（草案）',
    `- 负责 ${profile.projectName} 项目的持续开发与运营${goalShort ? `：${goalShort}` : ''}。`,
    '- 收尾时把本次进展压缩追加到项目根的 HANDOFF.md（桌面版注入的收尾规则接管细节）。',
    '',
    '## 归属判据（草案）',
    `- 涉及 ${profile.projectName}${stackShort ? `、${stackShort}` : ''} 相关的任务属于本岗；不属于时按名册转交并附一句理由。`,
    '',
  ].filter((line) => line !== '');

  return {
    id: slugifyPositionId(pkgNameOrDirectory(profile)),
    displayNameCandidates: displayNameCandidates.slice(0, NAME_CANDIDATE_CAP),
    description,
    body: body.join('\n'),
    projectRoot: profile.directory.replace(/\\/g, '/'),
  };
}

/** The id source: the project's name when it is already a slug, else the directory's. */
const pkgNameOrDirectory = (profile: ProjectProfile): string =>
  POSITION_ID_RE.test(profile.projectName) ? profile.projectName : directoryName(profile.directory);

/** A path as the overlap check compares it: forward slashes, no trailing one, case-folded. */
export const normalizeProjectRoot = (root: string): string =>
  root.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** One text's similarity grams: Latin words whole, CJK as bigrams. */
const gramsOf = (text: string): Set<string> => {
  const set = new Set<string>();
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const word of words) set.add(`w:${word}`);
  const cjk = text.match(/[\u4e00-\u9fff]/g) ?? [];
  for (let i = 0; i + 1 < cjk.length; i++) set.add(`c:${cjk[i]}${cjk[i + 1]}`);
  return set;
};

/** Similarity of two short texts: Jaccard over CJK bigrams and Latin words, 0-1. */
const textSimilarity = (a: string, b: string): number => {
  const ga = gramsOf(a);
  const gb = gramsOf(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const gram of ga) if (gb.has(gram)) shared++;
  return shared / (ga.size + gb.size - shared);
};

/** Description-similarity threshold: above this the draft reads as the same job. */
const DESCRIPTION_SIMILARITY_THRESHOLD = 0.6;

/**
 * The roster positions the draft collides with, and how: the same id, the
 * same display name, the same project root, or near-identical descriptions.
 * The wizard shows each as a red warning and demands a deliberate
 * confirmation before it creates anything anyway.
 */
export function findPositionOverlaps(
  draft: { id: string; displayName: string; description: string; projectRoot?: string },
  roster: readonly PositionInfo[]
): PositionOverlap[] {
  const overlaps: PositionOverlap[] = [];
  const draftRoot = draft.projectRoot ? normalizeProjectRoot(draft.projectRoot) : undefined;
  const draftId = draft.id.trim().toLowerCase();
  const draftName = draft.displayName.trim();
  for (const position of roster) {
    const reasons: PositionOverlapReason[] = [];
    if (draftId && position.name.toLowerCase() === draftId) reasons.push('id');
    if (draftName && position.displayName === draftName) reasons.push('name');
    if (draftRoot && position.projectRoot && normalizeProjectRoot(position.projectRoot) === draftRoot)
      reasons.push('project-root');
    if (
      draft.description.length > 0 &&
      position.description.length > 0 &&
      textSimilarity(draft.description, position.description) >= DESCRIPTION_SIMILARITY_THRESHOLD
    )
      reasons.push('description');
    if (reasons.length > 0) overlaps.push({ position, reasons });
  }
  return overlaps;
}

/**
 * The taboos as frontmatter lines: one item inline, several as a `- item`
 * list — both shapes the library parser reads back.
 */
const antiJobFrontmatterLines = (antiJob: readonly string[]): string[] => {
  if (antiJob.length === 0) return [];
  if (antiJob.length === 1) return [`anti_job: ${oneLine(antiJob[0], 200)}`];
  return ['anti_job:', ...antiJob.map((item) => `  - ${oneLine(item, 200)}`)];
};

/** The position document the wizard writes: frontmatter plus body, the library parser's own shape. */
export function buildPositionDocument(draft: {
  id: string;
  displayName: string;
  description: string;
  antiJob?: readonly string[];
  body: string;
}): string {
  return [
    '---',
    `name: ${oneLine(draft.id, 40)}`,
    `display_name: ${oneLine(draft.displayName, 40)}`,
    `description: ${oneLine(draft.description, 200)}`,
    ...antiJobFrontmatterLines(draft.antiJob ?? []),
    '---',
    '',
    draft.body.trimEnd(),
    '',
  ].join('\n');
}

// --- the AI deep analysis: prompt and reply parsing (the run itself lives in the process) ---

/** What the AI deep analysis answers: the same fields the heuristic fills. */
export type DeepAnalysis = {
  projectName: string;
  goal: string;
  techStack: string[];
  constraints: string[];
  displayNameCandidates: string[];
  description: string;
};

/**
 * The prompt the one-shot mu run answers: analyze the working directory and
 * answer as one JSON object, nothing else — the parse is strict and the
 * wizard marks the result as AI-derived.
 */
export const buildDeepAnalysisPrompt = (): string =>
  [
    '分析当前工作目录的项目（可读其中 AGENTS.md、HANDOFF.md、README、package.json 等文件），为它设计一个常设负责岗位。',
    '只输出一个 JSON 对象，不要输出任何其他文字，字段：',
    '{"projectName": "英文短名", "goal": "当前目标一句话(中文)", "techStack": ["最多8项"], "constraints": ["关键约束最多3条,每条一句话"], "displayNameCandidates": ["中文岗位名2-3个,每个2-8字"], "description": "岗位职责一句话(中文,150字内,以「涉及…相关任务时交给它」结尾)"}',
  ].join('\n');

/** The strings of an unknown value, capped; other shapes become nothing. */
const stringArray = (value: unknown, cap: number): string[] =>
  (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [])
    .map((item) => oneLine(item, 80))
    .filter((item) => item.length > 0)
    .slice(0, cap);

/** The string of an unknown value, one line; other shapes become undefined. */
const stringField = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? oneLine(value, 200) : undefined;

/**
 * The AI reply as a deep analysis: the last JSON object of the text (a
 * fenced block when the model follows the prompt), fields coerced and
 * capped. Undefined when the text carries no object — the wizard reports
 * the failure instead of guessing.
 */
export function parseDeepAnalysisReply(text: string): DeepAnalysis | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/g;
  const candidates: string[] = [];
  for (const match of text.matchAll(fenced)) candidates.push(match[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
      const projectName = stringField(parsed.projectName);
      if (!projectName) continue;
      return {
        projectName,
        goal: stringField(parsed.goal) ?? '',
        techStack: stringArray(parsed.techStack, STACK_CAP),
        constraints: stringArray(parsed.constraints, CONSTRAINT_CAP),
        displayNameCandidates: stringArray(parsed.displayNameCandidates, NAME_CANDIDATE_CAP),
        description: stringField(parsed.description) ?? '',
      };
    } catch {
      // Not JSON — the next candidate may be.
    }
  }
  return undefined;
}

/** A deep analysis as a profile the wizard treats like a heuristic one, marked `ai` in its sources. */
export function deepAnalysisAsProfile(analysis: DeepAnalysis, directory: string): ProjectProfile {
  return {
    directory,
    projectName: analysis.projectName,
    goal: analysis.goal,
    techStack: analysis.techStack,
    constraints: analysis.constraints,
    sources: ['ai'],
    empty: false,
  };
}

/** A deep analysis as a draft: like the heuristic draft, but the AI's own candidates and description win. */
export function deepAnalysisAsDraft(analysis: DeepAnalysis, directory: string): PositionDraft {
  const heuristic = buildPositionDraft(deepAnalysisAsProfile(analysis, directory));
  const candidates =
    analysis.displayNameCandidates.length > 0 ? analysis.displayNameCandidates : heuristic.displayNameCandidates;
  const description = analysis.description || heuristic.description;
  const aiBody = [
    `你是「${candidates[0]}」岗位的常设负责 Bot（岗位即项目，跨任务常设，持续积累本岗记忆）。以下画像由创建向导的 AI 深度分析初始化（非人工核对），请在首次任务中核实并补全。`,
    '',
    '## 项目事实（开工必读）',
    `- 项目根：\`${directory.replace(/\\/g, '/')}\``,
    analysis.goal ? `- 当前目标：${oneLine(analysis.goal, 60)}` : '',
    analysis.techStack.length > 0 ? `- 技术栈：${analysis.techStack.join('、')}` : '',
    ...(analysis.constraints.length > 0
      ? ['- 关键约束（AI 提取，开工先读项目 AGENTS.md 核实）：', ...analysis.constraints.map((line) => `  - ${line}`)]
      : []),
    '',
    '## 岗位职责（草案）',
    `- 负责 ${analysis.projectName} 项目的持续开发与运营${analysis.goal ? `：${oneLine(analysis.goal, 60)}` : ''}。`,
    '',
    '## 归属判据（草案）',
    `- 涉及 ${analysis.projectName}${analysis.techStack.slice(0, 3).join('、')} 相关的任务属于本岗；不属于时按名册转交并附一句理由。`,
    '',
  ].filter((line) => line !== '');
  return {
    id: heuristic.id,
    displayNameCandidates: candidates,
    description: oneLine(description, 200),
    body: aiBody.join('\n'),
    projectRoot: directory.replace(/\\/g, '/'),
  };
}

export { FILE_READ_CHARS };
