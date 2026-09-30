/**
 * mu's experience library as it lies on disk: `<agentDir>/mu/lessons.jsonl`, one JSON object per line, only ever
 * appended to. A line is a whole lesson or only the fields that changed (`{ id, status }`, `{ id, uses }`,
 * `{ id, updated }`); reading folds the lines of one id in order, later fields over earlier ones, and keeps the lessons
 * in the order each id first appeared. A line that does not parse is skipped, a malformed field is dropped without the
 * rest of its line, and an id that still has no trigger or no lesson once folded is left out.
 *
 * Lines of the first version (`{ id, trigger, lesson, cwd?, created }`) read as active corrections of the project in
 * `cwd`.
 *
 * The rules are the harness's (`packages/kyrn-judge/src/memory/store.ts` in the KYRN repository), copied rather than
 * imported: the two repositories are separate.
 */

export const LESSON_KINDS = ['correction', 'preference', 'pitfall', 'workaround', 'fact'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

/** Where a lesson was learned: the user's word, the agent's own way out, the model, a sub-agent, `/remember`. */
export const LESSON_ORIGINS = ['user', 'outcome', 'model', 'subagent', 'command'] as const;
export type LessonOrigin = (typeof LESSON_ORIGINS)[number];

export const LESSON_STATUSES = ['active', 'retired', 'superseded'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export type LessonUses = { recalled: number; applied: number; lastRecalled?: string };

/** `cwd`: the project the lesson belongs to. Without one it applies everywhere. */
export type LessonScope = { cwd?: string };

export type LessonSource = { origin: LessonOrigin; session?: string; turn?: number };

export type StoredLesson = {
  id: string;
  kind: LessonKind;
  /** When it applies: the situation the judge holds a new message against. */
  trigger: string;
  /** What to do then: the one line that is brought into a turn. */
  lesson: string;
  scope: LessonScope;
  source: LessonSource;
  status: LessonStatus;
  /** The lesson this one replaced. */
  supersedes?: string;
  uses: LessonUses;
  created: string;
  /** When it was written, confirmed again or changed. Counting a use does not touch it. */
  updated: string;
};

/** One line of the file: a whole lesson, or the fields of one that changed. */
export type LessonLine = { id: string } & Partial<Omit<StoredLesson, 'id'>>;

/** The well-formed fields of one line. `cwd` is where the first version kept the project. */
type Draft = {
  id: string;
  trigger?: string;
  lesson?: string;
  kind?: LessonKind;
  scope?: LessonScope;
  cwd?: string;
  source?: LessonSource;
  status?: LessonStatus;
  supersedes?: string;
  uses?: LessonUses;
  created?: string;
  updated?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const oneOf = <T extends string>(options: readonly T[], value: unknown): T | undefined =>
  options.find((option) => option === value);

function draftOf(value: unknown): Draft | undefined {
  if (!isRecord(value) || !isText(value.id)) return undefined;
  const draft: Draft = { id: value.id };
  if (isText(value.trigger)) draft.trigger = value.trigger;
  if (isText(value.lesson)) draft.lesson = value.lesson;
  const kind = oneOf(LESSON_KINDS, value.kind);
  if (kind) draft.kind = kind;
  const status = oneOf(LESSON_STATUSES, value.status);
  if (status) draft.status = status;
  if (isRecord(value.scope)) draft.scope = isText(value.scope.cwd) ? { cwd: value.scope.cwd } : {};
  if (isText(value.cwd)) draft.cwd = value.cwd;
  if (isRecord(value.source)) {
    const origin = oneOf(LESSON_ORIGINS, value.source.origin);
    if (origin) {
      draft.source = {
        origin,
        ...(isText(value.source.session) ? { session: value.source.session } : {}),
        ...(isCount(value.source.turn) ? { turn: value.source.turn } : {}),
      };
    }
  }
  if (isText(value.supersedes)) draft.supersedes = value.supersedes;
  if (isRecord(value.uses) && isCount(value.uses.recalled) && isCount(value.uses.applied)) {
    draft.uses = {
      recalled: value.uses.recalled,
      applied: value.uses.applied,
      ...(isText(value.uses.lastRecalled) ? { lastRecalled: value.uses.lastRecalled } : {}),
    };
  }
  if (isText(value.created)) draft.created = value.created;
  if (isText(value.updated)) draft.updated = value.updated;
  return draft;
}

function complete(draft: Draft): StoredLesson | undefined {
  if (draft.trigger === undefined || draft.lesson === undefined) return undefined;
  const created = draft.created ?? draft.updated ?? new Date(0).toISOString();
  const cwd = draft.scope ? draft.scope.cwd : draft.cwd;
  return {
    id: draft.id,
    kind: draft.kind ?? 'correction',
    trigger: draft.trigger,
    lesson: draft.lesson,
    scope: cwd === undefined ? {} : { cwd },
    source: draft.source ?? { origin: 'user' },
    status: draft.status ?? 'active',
    ...(draft.supersedes ? { supersedes: draft.supersedes } : {}),
    uses: draft.uses ?? { recalled: 0, applied: 0 },
    created,
    updated: draft.updated ?? created,
  };
}

/**
 * Parsed lines, folded by id: later fields over earlier ones, in the order each id first appeared. An id whose folded
 * fields still lack a trigger or a lesson (a tombstone for a lesson that is not there) is left out.
 */
export function foldLessons(lines: readonly unknown[]): StoredLesson[] {
  const drafts = new Map<string, Draft>();
  for (const line of lines) {
    const draft = draftOf(line);
    if (!draft) continue;
    const earlier = drafts.get(draft.id);
    // Setting a key that is there keeps its place: lessons stay in the order they were first written.
    drafts.set(draft.id, earlier ? { ...earlier, ...draft } : draft);
  }
  const lessons: StoredLesson[] = [];
  for (const draft of drafts.values()) {
    const lesson = complete(draft);
    if (lesson) lessons.push(lesson);
  }
  return lessons;
}

/** One line of text as JSON; undefined for a blank or corrupt one, which must not cost the rest of the file. */
function parseLine(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The file's text, folded. A last line without its newline counts: it is a whole line once it parses. */
export function parseLessons(text: string): StoredLesson[] {
  return foldLessons(text.split('\n').map(parseLine));
}

/** Whether a lesson applies in a project known by these paths: the project's own lessons, and those for everywhere. */
export function inScope(lesson: StoredLesson, places: readonly string[]): boolean {
  return lesson.scope.cwd === undefined || places.includes(lesson.scope.cwd);
}

/** The longest lesson the harness keeps; it cuts its own there too. */
export const LESSON_CHARS = 300;

/** A lesson's text as the harness keeps it: one line, runs of whitespace as one space, at most {@link LESSON_CHARS}. */
export function flatLesson(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length <= LESSON_CHARS ? line : `${line.slice(0, LESSON_CHARS - 1)}…`;
}

/** A conversation's lessons as the lessons tab shows them: its project's and those for everywhere, in any state. */
export type LessonsView = {
  /** The folder of the conversation's project lessons; '' without one, when only the lessons for everywhere apply. */
  project: string;
  lessons: StoredLesson[];
};

/** One change to one lesson, written as one appended line: its new text, or its retirement. */
export type LessonEdit = { id: string; action: 'edit'; lesson: string } | { id: string; action: 'retire' };

/** One change the lessons tab makes to one lesson of an app conversation's project. */
export type LessonChange = LessonEdit & { conversationId: string };
