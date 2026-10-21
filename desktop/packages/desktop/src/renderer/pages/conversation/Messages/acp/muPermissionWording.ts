/**
 * mu's permission question in the reader's language. mu writes the card in Chinese or English only; beside it the
 * bridge puts mu's codes (`rawInput.mu`: what kind of call, why mu asks, what makes a command risky) and names the
 * answers by id (`mu:once`, `mu:session`, `mu:deny`). A code this app does not know keeps mu's own sentence.
 * The contract is the harness's kyrn/docs/features/presentation-codes.md (permissions.request).
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;
/** Whether the app has a wording for a key; without one the card keeps mu's own sentence. */
type Has = (key: string) => boolean;

type MuPermissionCodes = { kind?: string; reason?: string; flagCode?: string; grantLabel?: string };

const KINDS: ReadonlySet<string> = new Set(['edit', 'shell', 'run', 'outside', 'delegate', 'other']);
/**
 * `flagged` is worded by the flag. `nojudge`: no judge could be asked, so every step asks; `judgedown`: the judge did
 * not answer this time.
 */
const REASONS: ReadonlySet<string> = new Set([
  'ask',
  'unsure',
  'beyond',
  'unrelated',
  'protected',
  'nojudge',
  'judgedown',
]);
const FLAGS: ReadonlySet<string> = new Set([
  'recursive_or_forced_delete',
  'discards_git_work',
  'force_push',
  'drops_database_objects',
  'overwrites_device',
  'opens_permissions_recursively',
  'runs_downloaded_script',
  'runs_as_administrator',
  'runs_as_root',
]);
const ANSWERS: ReadonlySet<string> = new Set(['once', 'session', 'deny']);
const ANSWER_PREFIX = 'mu:';

const KEY = 'mu.permissionsCard';

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function readCodes(rawInput: unknown): MuPermissionCodes | undefined {
  const mu = rawInput && typeof rawInput === 'object' ? (rawInput as { mu?: unknown }).mu : undefined;
  if (!mu || typeof mu !== 'object' || Array.isArray(mu)) return undefined;
  const codes = mu as Record<string, unknown>;
  // The backend's relay snake-cases every key it passes on (`flag_code`); a stored card may have either spelling.
  return {
    kind: str(codes.kind),
    reason: str(codes.reason),
    flagCode: str(codes.flagCode) ?? str(codes.flag_code),
    grantLabel: str(codes.grantLabel) ?? str(codes.grant_label),
  };
}

export type MuPermissionWording = {
  /** What mu wants to do, or undefined to keep mu's title. */
  title?: string;
  /** Why it asks, or undefined to keep mu's reason. */
  description?: string;
  /** An answer's name by its option id, or undefined for an option that is not one of mu's answers. */
  answer: (optionId: string) => string | undefined;
  /**
   * What an answer decided about the call (`summary`, the command or path it names), said on the card once the answer
   * went through; undefined for an option that is not one of mu's answers.
   */
  decided: (optionId: string, summary: string | undefined) => string | undefined;
};

/** The card's wording from mu's codes, or undefined when the card has none (another agent, or an older mu). */
export function muPermissionWording(rawInput: unknown, t: Translate, has: Has): MuPermissionWording | undefined {
  const codes = readCodes(rawInput);
  if (!codes) return undefined;
  const { kind, reason, flagCode, grantLabel } = codes;
  const worded = (key: string, known: ReadonlySet<string>, value: string | undefined): value is string =>
    Boolean(value && known.has(value) && has(`${KEY}.${key}.${value}`));
  const title = worded('kind', KINDS, kind) ? t(`${KEY}.kind.${kind}`) : undefined;
  const description =
    reason === 'flagged'
      ? worded('flag', FLAGS, flagCode) && has(`${KEY}.flagged`)
        ? t(`${KEY}.flagged`, { flag: t(`${KEY}.flag.${flagCode}`) })
        : undefined
      : worded('reason', REASONS, reason)
        ? t(`${KEY}.reason.${reason}`)
        : undefined;
  const answer = (optionId: string): string | undefined => {
    if (!optionId.startsWith(ANSWER_PREFIX)) return undefined;
    const id = optionId.slice(ANSWER_PREFIX.length);
    // What "for this conversation" covers is data (a command's first words, a path, a tool) and stays as sent.
    const key = id === 'session' && grantLabel ? `${KEY}.answer.sessionFor` : `${KEY}.answer.${id}`;
    if (!ANSWERS.has(id) || !has(key)) return undefined;
    return t(key, grantLabel ? { grant: grantLabel } : undefined);
  };
  const decided = (optionId: string, summary: string | undefined): string | undefined => {
    // The call is data, shown as sent; a card that names none says which answer was picked.
    if (!summary || !optionId.startsWith(ANSWER_PREFIX)) return undefined;
    const id = optionId.slice(ANSWER_PREFIX.length);
    const key = `${KEY}.decided.${id}`;
    if (!ANSWERS.has(id) || !has(key)) return undefined;
    return t(key, { summary });
  };
  return { title, description, answer, decided };
}
