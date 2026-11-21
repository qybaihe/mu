/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The creation wizard's third source, pure: the "I'll describe it" flavour.
 * The user pastes a free-text description of the position they want; these
 * functions extract — with no model calls, just marker tables — which of the
 * three load-bearing information dimensions the text is missing (project
 * root, duty boundary, acceptance criteria), as the checklist the wizard
 * shows to guide a supplement, and the review-step draft the text yields
 * (first sentence as the description, the project root the text names).
 * The wizard stays light on purpose: one pass, no interview loop — a
 * description that stays unclear is the supervisor conversation's job (it
 * interviews the user), not the wizard's.
 */

/** The information dimensions a pasted description may be missing. */
export type DescribeGapKey = 'project-root' | 'duty-boundary' | 'acceptance';

/** Every gap key, in the order the checklist shows them. */
export const DESCRIBE_GAP_KEYS: readonly DescribeGapKey[] = ['project-root', 'duty-boundary', 'acceptance'];

/**
 * A path-like token: a Windows drive path, a `~/` home path, or a POSIX
 * absolute path under the usual roots. A description naming one names its
 * project root; the draft also lifts it into the body's 项目根 line.
 */
const PATH_TOKEN_RE = /[A-Za-z]:[\\/][\w.\-\\/ ]+|~\/[\w.\-/. ]+|\/(?:home|Users|mnt|opt|srv)\/[\w.\-/. ]+/;

/** Words that mark a duty boundary: what the position owns, does or refuses. */
const DUTY_WORD_RE =
  /负责|职责|管理|维护|处理|产出|交付|审核|跟进|监控|不做|严禁|拒绝|responsib|manage|maintain|handle|produce|own/i;

/** Words that mark an acceptance bar: how done is judged. */
const ACCEPTANCE_WORD_RE = /验收|标准|合格|算完成|算好|质量要求|做到什么|acceptance|definition of done|quality bar/i;

/** Words that already name the project root explicitly. */
const PROJECT_ROOT_WORD_RE = /项目根|项目目录|project root/i;

/**
 * The missing-information dimensions of a pasted description, in checklist
 * order: a dimension drops out as soon as its markers show up. An empty or
 * very short text is missing all three — exactly the checklist the wizard
 * wants to surface then.
 */
export function describeGapQuestions(text: string): DescribeGapKey[] {
  const gaps: DescribeGapKey[] = [];
  if (!PATH_TOKEN_RE.test(text) && !PROJECT_ROOT_WORD_RE.test(text)) gaps.push('project-root');
  if (!DUTY_WORD_RE.test(text)) gaps.push('duty-boundary');
  if (!ACCEPTANCE_WORD_RE.test(text)) gaps.push('acceptance');
  return gaps;
}

/** What the wizard's review step edits, as the description yields it. */
export type DescribeDraft = {
  /** The frontmatter `description`: the text's first sentence, capped. */
  description: string;
  /** The body below the frontmatter: the text, plus the 项目根 line it implies. */
  body: string;
  /** The project root the text names, when it names one. */
  projectRoot: string;
};

/** How long the extracted description may run; the rest of the sentence drops. */
const DESCRIPTION_MAX_CHARS = 120;

/** The first sentence of the text: up to the first sentence end or line break, capped. */
const firstSentenceOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const cut = flat.split(/[。！？!?;\n]/)[0] ?? flat;
  return cut.length > DESCRIPTION_MAX_CHARS ? `${cut.slice(0, DESCRIPTION_MAX_CHARS - 1)}…` : cut;
};

/**
 * The review-step draft a pasted description yields: the first sentence as
 * the description, the whole text as the body, and a path token lifted into
 * the body's 项目根 line the library parser reads back — unless the text
 * already writes that line itself.
 */
export function describeDraft(text: string): DescribeDraft {
  const body = text.trim();
  const match = PATH_TOKEN_RE.exec(text);
  const projectRoot = match ? match[0].trim().replace(/[，。、；,.;：:\s]+$/, '') : '';
  const rootLine =
    projectRoot && !PROJECT_ROOT_WORD_RE.test(text) ? `\n\n## 项目事实（开工必读）\n- 项目根：\`${projectRoot}\`` : '';
  return { description: firstSentenceOf(text), body: `${body}${rootLine}`, projectRoot };
}
