import type { BoardNote } from './board';

/**
 * A fixed line of the board's account in the reader's language. The harness writes most lines from fixed sentences
 * (`by: 'rules'`), in Chinese or English only: the rules' lines stay coded, and the app words them in its own language
 * (what the board's model writes follows the language the person writes in, and is shown as written). Each line names
 * its sentence (`code`) and what fills it (`params`), so it is worded again here. A line whose sentence this build does
 * not know, or whose params do not fit it, keeps the harness's sentence; a line the board's model wrote is its own words
 * and stays. The contract is the harness's `board.note` (kyrn/docs/features/plain-language-board.md).
 *
 * A sentence that names a helper (`name`, `who`) names it by its label when the board has one (board v2.1): the params
 * carry the helper's exact name, which identifies it, and the label is what the person reads.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
/** Whether the app has a wording for a key. */
type Has = (key: string) => boolean;

const KEY = 'common.kyrn.boardView.notes';

/** Each fixed sentence and what fills it. */
export const NOTE_SENTENCES: ReadonlyMap<string, readonly string[]> = new Map([
  ['looked', ['count']],
  ['changed_file', ['file']],
  ['wrote_file', ['file']],
  ['ran_command', ['command']],
  ['command_failed', ['command']],
  ['check_passed', ['command']],
  ['check_failed', ['command']],
  ['item_done', ['item']],
  ['item_added', ['item']],
  ['helpers_sent', ['count', 'titles']],
  ['helpers_back', ['count']],
  ['permission_allowed', ['summary']],
  ['permission_denied', ['summary']],
  ['goal_round', ['round', 'reason']],
  ['goal_met', ['text']],
  ['goal_paused', ['reason']],
  ['trouble_loop', ['detail']],
  ['trouble', ['detail']],
  ['did', ['tool', 'what']],
  ['said_quote', ['text']],
  ['ended', []],
  ['waiting_reply', []],
  // Board v2. A helper's `still_running` (with `who`), `helpers_back` with `failed` and `helper_failed` have their
  // own sentences: see `codeWords`.
  ['still_running', ['what', 'minutes']],
  ['helper_done', ['name', 'summary']],
]);

/** Why a helper stopped short, each with its own sentence. */
export const HELPER_FAILURES = ['failed', 'timed_out', 'stopped'] as const;

/** Counts, which also pick the plural; everything else is text. */
export const NOTE_NUMBERS: ReadonlySet<string> = new Set(['count', 'round', 'minutes', 'failed']);
/** Text that arrives already formatted, and empty when there is none (": the tests fail" or ''). */
const MAY_BE_EMPTY: ReadonlySet<string> = new Set(['reason']);

const fits = (name: string, value: string | number | undefined) =>
  NOTE_NUMBERS.has(name)
    ? typeof value === 'number'
    : typeof value === 'string' && (value !== '' || MAY_BE_EMPTY.has(name));

type Params = Readonly<Record<string, string | number>> | undefined;

/** What the board calls a helper, by its exact name; undefined when it has no label. */
export type LabelOf = (who: string) => string | undefined;

/** The params with each helper they name (`name`, `who`) called by its label, where it has one. */
export function withLabels(params: Params, labelOf: LabelOf | undefined): Params {
  if (!params || !labelOf) return params;
  let named: Record<string, string | number> | undefined;
  for (const key of ['name', 'who']) {
    const value = params[key];
    const label = typeof value === 'string' && value ? labelOf(value) : undefined;
    if (label) (named ??= { ...params })[key] = label;
  }
  return named ?? params;
}

/**
 * One fixed sentence in the app's language: undefined when the app has no wording for `key` or a param it names does
 * not fit. Only what the sentence names is passed on: nothing else in the params reaches the translator's options.
 */
export function wordSentence(
  key: string,
  names: readonly string[],
  params: Params,
  t: Translate,
  has: Has
): string | undefined {
  if (!has(key)) return undefined;
  const values: Record<string, string | number> = {};
  for (const name of names) {
    const value = params?.[name];
    if (!fits(name, value)) return undefined;
    values[name] = value as string | number;
  }
  return t(key, values);
}

const text = (value: string | number | undefined): string => (typeof value === 'string' ? value.trim() : '');

/** A fixed sentence of the account named by its code, in the app's language; undefined to keep the harness's. */
export function codeWords(code: string, params: Params, t: Translate, has: Has): string | undefined {
  switch (code) {
    case 'still_running':
      // A helper's long run: who has run what with no output.
      if (text(params?.who))
        return wordSentence(`${KEY}.still_running_who`, ['who', 'what', 'minutes'], params, t, has);
      break;
    case 'helpers_back': {
      const failed = params?.failed;
      if (typeof failed === 'number' && failed > 0)
        return wordSentence(`${KEY}.helpers_back_failed`, ['count', 'failed'], params, t, has);
      break;
    }
    case 'helper_failed': {
      const reason = HELPER_FAILURES.find((known) => known === params?.reason);
      if (!reason) return undefined;
      const said = wordSentence(`${KEY}.helper_failed.${reason}`, ['name'], params, t, has);
      const detail = text(params?.detail);
      return said && detail && has(`${KEY}.with_detail`) ? t(`${KEY}.with_detail`, { line: said, detail }) : said;
    }
    default:
      break;
  }
  const names = NOTE_SENTENCES.get(code);
  return names ? wordSentence(`${KEY}.${code}`, names, params, t, has) : undefined;
}

/** What the board calls the helper a line is about: the line's own label, else the board's; undefined for none. */
export const noteLabel = (note: BoardNote, labelOf?: LabelOf): string | undefined =>
  note.who ? (note.label ?? labelOf?.(note.who)) : undefined;

/**
 * The line in the app's language, or undefined when it keeps the harness's (or the model's) sentence. The helper the
 * line is about is called by its label (`noteLabel`); another name in its params stays as it is.
 */
export function noteWords(note: BoardNote, t: Translate, has: Has, labelOf?: LabelOf): string | undefined {
  if (note.by !== 'rules' || !note.code) return undefined;
  const label = noteLabel(note, labelOf);
  const params = label ? withLabels(note.params, (name) => (name === note.who ? label : undefined)) : note.params;
  return codeWords(note.code, params, t, has);
}
