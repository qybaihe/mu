import { JUDGE_TYPES } from '../../../../common/kyrn/types';
import { array, asRecord, text } from '../piRpc';

/*
 * Laya, the local judge mu had until 0.2.4: a third-party model that `kyrn-judge-local` ran on a Mac and the app ran
 * itself on Windows and Linux. mu no longer has it, but a mu.json written by an older mu may still name it: the
 * built-in `laya`, or a judge of type `local`. mu moves such a file on in the first session it can say so in (the
 * harness's laya-migration.ts, with a `judge.notice` the conversation words, code `laya_removed`). Until then the app
 * reads it as mu will leave it, and writes nothing for it:
 *
 * - in the judge order, Laya becomes mude when mude 1.0 is set up here (installed, its Python environment ready, its
 *   key set), and is left out otherwise. An order left empty is Jev's, as for a mu.json that has none. ['laya'] reads as
 *   ['mude'] or ['jev'], ['laya', 'clm'] as ['mude', 'clm'] or ['clm'].
 * - Laya's profiles are not among the judges. A save keeps them in mu.json for mu to drop, and writes the order only
 *   when it was changed.
 *
 * The files Laya downloaded stay where they are: they are the person's to delete.
 */

/** How long the settings wait for mude's status where mu.json still names Laya. */
export const MUDE_STATUS_WAIT_MS = 5000;

const KNOWN_TYPES: ReadonlySet<string> = new Set(JUDGE_TYPES);

/**
 * Whether a judge of mu.json is Laya: any judge of the `local` type only Laya had, and `laya` itself unless an entry of
 * a type mu runs took that name, as the harness tells them (`retiredJudges`).
 */
export function isLaya(name: string, judge: unknown): boolean {
  const type = text(asRecord(judge).type);
  return type === 'local' || (name === 'laya' && !KNOWN_TYPES.has(type));
}

/** Where Laya stands in mu.json's judge order: first (it was the judge), later (behind another), or nowhere. */
export function layaInOrder(config: Record<string, unknown>): 'first' | 'later' | undefined {
  const judges = asRecord(config.judges);
  const at = array(config.tiers)
    .map(text)
    .findIndex((name) => isLaya(name, judges[name]));
  return at < 0 ? undefined : at === 0 ? 'first' : 'later';
}

/** mu.json's judge order as mu leaves it without Laya (see above); mude is never asked twice. */
export function orderWithoutLaya(config: Record<string, unknown>, mudeReady: boolean): string[] {
  const judges = asRecord(config.judges);
  const order = array(config.tiers)
    .map(text)
    .flatMap((name) => (isLaya(name, judges[name]) ? (mudeReady ? ['mude'] : []) : [name]));
  const left = mudeReady ? order.filter((name, at) => name !== 'mude' || order.indexOf(name) === at) : order;
  return left.length ? left : ['jev'];
}

/**
 * What `ask` answers within `waitMs`, else `otherwise`: mude's status (`mu judge mude status`), which says whether mude
 * 1.0 is installed for an order that names Laya. A command that fails or does not answer in time counts as no mude, as
 * on a machine without it: the judge behind Laya, or Jev, then answers, and the settings never wait long.
 */
export async function within<T>(ask: () => Promise<T>, waitMs: number, otherwise: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(otherwise), waitMs);
  });
  try {
    return await Promise.race([ask().catch(() => otherwise), late]);
  } finally {
    clearTimeout(timer);
  }
}
