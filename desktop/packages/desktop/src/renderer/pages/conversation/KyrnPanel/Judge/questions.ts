import type { DECISIONS } from './activity';

/**
 * One question a decision point asks the judge, as the ledger records its answer. The words are in
 * `common.kyrn.judgeView.answerWords.<stage>`: `questions.<key>` names the question, `answers.<answer>` says each answer
 * a choice offers (shared by the choices of one decision point, which never give one answer two meanings), and
 * `levels.<key>.<n>` says each step of a score.
 */
export type JudgeQuestion = {
  /** The question id; for a question asked once per item, the id before the item's number (`skill_`, `k`). */
  id: string;
  /** Where the question's words are, when not under its id (a question asked once per item). */
  key?: string;
  /** Asked once per item: the id ends in the item's index, counted from 0 or 1. A person counts from 1. */
  from?: 0 | 1;
} & (
  | { type: 'boolean' }
  | { type: 'score'; levels: number }
  /** `open`: the judge may also answer with something named at run time (an element, a role, an item), shown as recorded. */
  | { type: 'choice'; answers: readonly string[]; open?: true }
);

const ADMISSION_KINDS = ['error', 'result', 'progress', 'warning', 'passing', 'other'] as const;
const PHASES = [
  'understanding',
  'planning',
  'changing',
  'checking',
  'fixing',
  'waiting',
  'wrapping_up',
  'stuck',
  'other',
] as const;

/**
 * What each decision point of the harness asks, by ledger spec id: the questions of its `defineDecision`, and for one
 * built per input (`questionsFor`) the pattern of its ids (the harness's packages/kyrn-judge/src/decisions/*.ts and
 * admission/test-log.ts).
 */
export const JUDGE_QUESTIONS: Record<keyof typeof DECISIONS, readonly JudgeQuestion[]> = {
  'input.preflight': [
    {
      id: 'turn_type',
      type: 'choice',
      answers: [
        'chat',
        'chat_question',
        'quick_lookup',
        'single_edit',
        'multi_step_task',
        'research',
        'design_discussion',
        'other',
      ],
    },
    { id: 'is_side_question', type: 'boolean' },
    { id: 'needs_clarification', type: 'boolean' },
    { id: 'needs_files_changed', type: 'boolean' },
    { id: 'needs_memory', type: 'boolean' },
    { id: 'swarm_worthy', type: 'boolean' },
    { id: 'plan_first', type: 'boolean' },
    { id: 'task_complexity', type: 'score', levels: 4 },
    { id: 'reasoning_depth', type: 'score', levels: 4 },
    { id: 'tool_complexity', type: 'score', levels: 4 },
  ],
  'input.interjection': [{ id: 'kind', type: 'choice', answers: ['correction', 'addition', 'side_question', 'other'] }],
  'tool.admission': [
    { id: 'kind', type: 'choice', answers: ADMISSION_KINDS },
    { id: 'k', key: 'chunk', from: 1, type: 'choice', answers: ADMISSION_KINDS },
  ],
  'tool.admission.test-log': [
    { id: 'part_', key: 'part', from: 0, type: 'choice', answers: ['needed', 'not_needed', 'unclear'] },
  ],
  'context.forget': [{ id: 'still_needed', type: 'boolean' }],
  'context.compact': [
    { id: 'kind', type: 'choice', answers: ['error', 'listing', 'content', 'log', 'data', 'other'] },
    { id: 'result_needed', type: 'boolean' },
    { id: 'call_matters', type: 'boolean' },
  ],
  'skills.disclosure': [{ id: 'skill_', key: 'skill', from: 0, type: 'boolean' }],
  'files.locate': [{ id: 'path_', key: 'path', from: 0, type: 'boolean' }],
  'swarm.routing': [
    { id: 'agent', type: 'choice', answers: ['other'], open: true },
    { id: 'difficulty', type: 'score', levels: 4 },
    { id: 'reasoning', type: 'score', levels: 4 },
  ],
  'hive.publish': [
    { id: 'share_worthy', type: 'boolean' },
    { id: 'kind', type: 'choice', answers: ['finding', 'dead_end', 'decision', 'blocker', 'other'] },
  ],
  'hive.deliver': [{ id: 'useful', type: 'boolean' }],
  'browser.step': [
    {
      id: 'operation',
      type: 'choice',
      answers: ['CLICK', 'TYPE_TEXT', 'SELECT', 'SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'DONE', 'other'],
    },
    { id: 'click_target', type: 'choice', answers: ['none'], open: true },
    { id: 'type_text_target', type: 'choice', answers: ['none'], open: true },
    { id: 'select_target', type: 'choice', answers: ['none'], open: true },
  ],
  'memory.recall': [{ id: 'lesson_', key: 'lesson', from: 0, type: 'boolean' }],
  'memory.capture': [
    { id: 'correction', type: 'boolean' },
    { id: 'preference', type: 'boolean' },
  ],
  'memory.outcome': [{ id: 'way_out', type: 'boolean' }],
  'memory.worth': [
    {
      id: 'worth_',
      key: 'lesson',
      from: 1,
      type: 'choice',
      answers: ['reusable', 'one_off', 'already_known', 'unclear'],
    },
  ],
  'memory.merge': [
    {
      id: 'merge_',
      key: 'kept',
      from: 1,
      type: 'choice',
      answers: ['same', 'refines', 'contradicts', 'unrelated', 'unclear'],
    },
  ],
  'memory.applied': [{ id: 'applied_', key: 'lesson', from: 1, type: 'boolean' }],
  'tool.risk': [
    { id: 'destructive', type: 'boolean' },
    { id: 'requested', type: 'boolean' },
  ],
  'turn.drift': [{ id: 'course', type: 'choice', answers: ['on_track', 'detour', 'drift', 'loop', 'other'] }],
  'turn.completion': [
    { id: 'claims_done', type: 'boolean' },
    { id: 'needs_check', type: 'boolean' },
  ],
  'turn.continue': [
    { id: 'promised', type: 'boolean' },
    { id: 'asks_go_ahead', type: 'boolean' },
    { id: 'work_requested', type: 'boolean' },
    { id: 'irreversible', type: 'boolean' },
  ],
  'tool.injection': [
    { id: 'injected', type: 'boolean' },
    { id: 'i', key: 'passage', from: 1, type: 'boolean' },
  ],
  'judge.items': [{ id: 'q', key: 'item', from: 1, type: 'boolean' }],
  'notify.routing': [{ id: 'urgency', type: 'choice', answers: ['now', 'next_turn', 'drop', 'other'] }],
  'cache.warming': [
    { id: 'finished', type: 'boolean' },
    { id: 'open', type: 'boolean' },
  ],
  'turn.rewind': [
    { id: 'dead_end', type: 'boolean' },
    { id: 'progress', type: 'boolean' },
  ],
  'goal.met': [
    { id: 'achieved', type: 'boolean' },
    { id: 'needs_user', type: 'boolean' },
  ],
  'output.drift': [{ id: 'rule_', key: 'rule', from: 0, type: 'boolean' }],
  'task.frame': [
    { id: 'change', type: 'choice', answers: ['new_task', 'constraint', 'correction', 'subgoal', 'none'] },
  ],
  'tool.constraint': [{ id: 'constraint_', key: 'constraint', from: 0, type: 'boolean' }],
  'capability.disclosure': [{ id: 'capability_', key: 'capability', from: 0, type: 'boolean' }],
  'diagnostics.delivery': [
    { id: 'more_edits_coming', type: 'boolean' },
    { id: 'warnings_are_style', type: 'boolean' },
  ],
  'swarm.patch': [
    { id: 'within_task', type: 'boolean' },
    { id: 'file_', key: 'file', from: 0, type: 'boolean' },
  ],
  'review.triage': [
    { id: 'is_bug_', key: 'bug', from: 0, type: 'boolean' },
    { id: 'in_scope_', key: 'inScope', from: 0, type: 'boolean' },
  ],
  'board.read': [
    { id: 'phase', type: 'choice', answers: PHASES },
    { id: 'needs_user', type: 'boolean' },
    { id: 'focus', type: 'choice', answers: ['none'], open: true },
    { id: 'event_', key: 'event', from: 0, type: 'choice', answers: ['key', 'routine', 'unclear'] },
    { id: 'changed', type: 'boolean' },
  ],
  'hive.relate': [{ id: 'relation', type: 'choice', answers: ['supersedes', 'contradicts', 'supports', 'none'] }],
  'tool.approval': [{ id: 'verdict', type: 'choice', answers: ['needed', 'beyond', 'unrelated', 'unclear'] }],
};

/** Where a question's words are: its key, or its id. */
export const questionKey = (question: JudgeQuestion): string => question.key ?? question.id;

/**
 * The question an answer id belongs to, and for one asked once per item the item's number as a person counts it
 * (`skill_0` is skill 1, `worth_1` is lesson 1).
 */
export function findQuestion(
  questions: readonly JudgeQuestion[],
  answerId: string
): { question: JudgeQuestion; number?: number } | undefined {
  for (const question of questions) {
    if (question.from === undefined) {
      if (question.id === answerId) return { question };
      continue;
    }
    const index = answerId.startsWith(question.id) ? answerId.slice(question.id.length) : '';
    if (/^\d+$/.test(index)) return { question, number: Number(index) - question.from + 1 };
  }
  return undefined;
}
