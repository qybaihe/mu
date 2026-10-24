import type { BoardCode, BoardUpdate } from './board';
import { codeWords, wordSentence } from './noteWords';

/**
 * A fixed board in the reader's language. The board's model writes in the language the person writes in (detected
 * from their last messages), and what it wrote is shown as written. When the model does not answer in time the harness
 * writes the board from fixed sentences (`by: 'rules'`), in Chinese or English only; those stay coded and are worded
 * here in the app's language. They carry no words of their own beyond the facts, so they are rebuilt from the facts:
 * how far (`done`/`total`), what now (`phase` plus `focusText`, the task's own words) and `confirmCodes`. A rules-built
 * `headline` or `blocked` line (on any board) names its sentence too (`headlineCode`, `blockedCode`). A part with no
 * wording in this language keeps the harness's sentence; a board the model wrote is its own words and stays.
 * The contract is the harness's kyrn/docs/features/presentation-codes.md (board.update).
 *
 * A fixed board's "now" names a stage as going on ("wrapping up", "changing the code"). Once the run has ended the
 * board's state says how it ended, and a stage under it would misread it: a fixed board that ended has no "now".
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
/** Whether the app has a wording for a key. */
type Has = (key: string) => boolean;

export type BoardWords = {
  now: string;
  progress: string;
  confirm: string[];
  /** Board v2's parts, empty when the board has none. */
  headline: string;
  blocked: string;
  next: string;
};

const KEY = 'common.kyrn.boardView.codes';
const HEADLINES = 'common.kyrn.boardView.headlines';

/** The headline's own fixed sentences; any other code is one of the account's (a long run: `still_running`). */
const HEADLINE_SENTENCES: ReadonlyMap<string, readonly string[]> = new Map([
  ['helpers_working', ['count']],
  ['waiting_permission', ['what']],
]);

/** A rules-built headline or blocked line in the app's language; undefined to keep the harness's sentence. */
export function codedLine(found: BoardCode | undefined, t: Translate, has: Has): string | undefined {
  if (!found) return undefined;
  const { code, params } = found;
  // `now_<phase>`: the stage's sentence, as a fixed board says what it does now.
  const phase = /^now_([a-z_]+)$/.exec(code)?.[1];
  if (phase) return has(`${KEY}.now.${phase}`) ? t(`${KEY}.now.${phase}`) : undefined;
  const names = HEADLINE_SENTENCES.get(code);
  if (names) return wordSentence(`${HEADLINES}.${code}`, names, params, t, has);
  return codeWords(code, params, t, has);
}

export function boardWords(update: BoardUpdate, t: Translate, has: Has, number: (value: number) => string): BoardWords {
  const over = update.by === 'rules' && update.ended;
  const said = {
    now: over ? '' : update.now,
    progress: update.progress,
    confirm: update.confirm,
    headline: codedLine(update.headlineCode, t, has) ?? update.headline ?? '',
    blocked: codedLine(update.blockedCode, t, has) ?? update.blocked ?? '',
    next: update.next ?? '',
  };
  // An older harness sends no codes: its sentence may name the item being worked on, which the facts here lack.
  if (update.by !== 'rules' || !update.confirmCodes) return said;

  const { done, total } = update;
  const progressKey =
    total === 0 ? `${KEY}.progress.none` : done === total ? `${KEY}.progress.all` : `${KEY}.progress.some`;
  const progress = has(progressKey)
    ? t(progressKey, { done: number(done), total: number(total), count: total })
    : said.progress;

  const nowKey = `${KEY}.now.${update.phase ?? 'unclear'}`;
  const base = has(nowKey) ? t(nowKey) : undefined;
  const now = over
    ? ''
    : !base
      ? said.now
      : !update.focusText
        ? base
        : has(`${KEY}.now.focus`)
          ? t(`${KEY}.now.focus`, { now: base, focus: update.focusText })
          : // The harness's sentence names the item: without a way to say it here, keep that sentence.
            said.now;

  const confirm = update.confirm.map((line, index) => {
    const code = update.confirmCodes?.[index];
    return code && has(`${KEY}.confirm.${code}`) ? t(`${KEY}.confirm.${code}`) : line;
  });
  return { ...said, now, progress, confirm };
}
