/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The context steward's pure half: the check line a long-lived session is
 * measured against, the hysteresis that keeps one action from repeating every
 * turn, part naming for a switch, and the conservative direction an
 * undecidable case falls to. Model call, telemetry reads and delivery live in
 * the service (process/services/team/contextSteward/).
 *
 * The line and its constants follow DS-Bot's steward (source-verified, see
 * tmp/dsbot-port/SPEC-P6.md): a session past the line gets ONE small decision
 * — compact (lossy, in place) or switch (lossless, a fresh part) — and every
 * failure falls the LOSSLESS way. The main model never learns any of this
 * happened.
 */

/** Tokens held back from the window before the line is drawn — pi's own compaction reserve (compaction.ts `reserveTokens` default 16384); the steward's line must leave the same room pi's would. */
export const STEWARD_RESERVE_TOKENS = 16384;

/** `usable` never falls below half the window: a reserve may be misconfigured huge, but the line must stay a majority of the window (DS-Bot's floor). */
const USABLE_FLOOR_RATIO = 0.5;

/**
 * The line's default ratio of usable tokens. Below pi's own auto-compaction
 * trigger (which sits near the window's end) so the steward decides FIRST —
 * with the choice between compact and switch — instead of pi compacting by
 * itself.
 */
const CHECK_RATIO_DEFAULT = 0.8;

/** The line's hard ratio: token counts are estimates, so the line never rises past 95% of usable even if the configured ratio is higher. */
const CHECK_RATIO_CEILING = 0.95;

/**
 * The absolute cap on the line, in tokens, whatever the window: prompt-cache
 * economics degrade far before today's largest windows fill, and a part that
 * outlives this cap costs every following turn (DS-Bot's 380k rule).
 */
export const STEWARD_ABS_CAP_TOKENS = 380_000;

/** The window a model that declares none is assumed to have (DS-Bot's rule); a line needs a denominator. */
const DEFAULT_CONTEXT_WINDOW = 500_000;

/** After a steward action, the session must grow by check/4 tokens before the steward is asked again — the same turn would otherwise re-trigger on its own tail. */
const HYSTERESIS_QUARTER = 4;

/**
 * The line, in tokens: `min(usable×0.8, usable×0.95, 380k)` where
 * `usable = max(window − reserve, window/2)`. `ratioOverride` (0<r≤1)
 * replaces the 0.8 default — the setting exists so a test or a cautious
 * machine can move the line, not as a user knob; out-of-range values are
 * ignored for the default.
 */
export function checkLineTokens(contextWindow: number | undefined, ratioOverride?: number): number {
  const window =
    typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : DEFAULT_CONTEXT_WINDOW;
  const usable = Math.max(window - STEWARD_RESERVE_TOKENS, Math.floor(window * USABLE_FLOOR_RATIO));
  const ratio =
    typeof ratioOverride === 'number' && Number.isFinite(ratioOverride) && ratioOverride > 0 && ratioOverride <= 1
      ? ratioOverride
      : CHECK_RATIO_DEFAULT;
  return Math.min(Math.floor(usable * ratio), Math.floor(usable * CHECK_RATIO_CEILING), STEWARD_ABS_CAP_TOKENS);
}

/** What the adapter's `context.usage` telemetry carries for one session (pi's `ContextUsage`; `tokens` is null right after a compaction). */
export type StewardUsage = { tokens: number | null; contextWindow: number; percent: number | null };

/** What the steward remembers per conversation: where its last action left the line, and how often it has compacted. */
export type StewardMemory = {
  /** Tokens at the last steward action; undefined before the first. */
  watermark: number | undefined;
  /** How many compactions this conversation has taken under the steward — the more, the readier the switch (a summary of a summary loses more). */
  compactions: number;
  /** The tail position of the session's activity file, so usage reads are incremental. */
  cursor: number;
};

export const freshStewardMemory = (): StewardMemory => ({ watermark: undefined, compactions: 0, cursor: 0 });

/** Whether the session stands at or over the line. `unknown` — no usable count, e.g. the post-compaction null window — never triggers anything. */
export function standsAtLine(
  usage: Pick<StewardUsage, 'tokens' | 'contextWindow'>,
  memory: Pick<StewardMemory, 'watermark'>,
  ratioOverride?: number
): 'over' | 'below' | 'unknown' {
  if (usage.tokens === null || !Number.isFinite(usage.tokens) || usage.tokens < 0) return 'unknown';
  const line = checkLineTokens(usage.contextWindow, ratioOverride);
  if (usage.tokens < line) return 'below';
  // Hysteresis: after an action, only growth by a quarter of the line re-opens the question.
  if (memory.watermark !== undefined && usage.tokens < memory.watermark + line / HYSTERESIS_QUARTER) return 'below';
  return 'over';
}

/** The steward's own decision vocabulary: compact in place, switch to a fresh part, or leave the session alone. */
export type StewardAction = 'compact' | 'switch' | 'none';

/** A decision as the engine states it, before eligibility narrows it. */
export type StewardDecision = { action: StewardAction; reason: string };

/**
 * The direction an undecided case falls: `switch` — the lossless move — for a
 * conversation that may switch; `compact` for one that may not (a
 * team-bound conversation: its part chain would strand the team's slots, so
 * its only steward action is the in-place one). The engine's answer, if
 * usable, stands as given; this is only where doubt lands.
 */
export const conservativeDecision = (switchAllowed: boolean): StewardDecision =>
  switchAllowed
    ? { action: 'switch', reason: 'steward-undecidable-lossless' }
    : { action: 'compact', reason: 'steward-undecidable' };

/** What a conversation's name becomes across a switch: the next part keeps the clean name, the old one carries the suffix. */
export type PartNaming = { oldTitle: string; newTitle: string; part: number };

/**
 * The wire form of the steward's compact request. The kyrn adapter intercepts a prompt whose whole text is exactly
 * this marker and answers it with pi's own `compact` RPC command — pi's `/compact` is a TUI command and would
 * otherwise reach the model as ordinary text. A person typing the marker gets a compact too: it reads as a command,
 * which is what they asked for.
 */
export const STEWARD_COMPACT_MESSAGE = '[[MU_STEWARD_COMPACT]]';

const PART_SUFFIX = /\s*\(part (\d+)\)\s*$/;

/** What a title's `(part N)` suffix says, when it has one: the chain's base name and the part the title claims. */
export function parsePartSuffix(title: string): { base: string; part: number } | undefined {
  const found = PART_SUFFIX.exec(title.trim());
  if (!found) return undefined;
  const base = title.trim().slice(0, found.index).trim();
  return base ? { base, part: Number.parseInt(found[1], 10) } : undefined;
}

/** Names both sides of the Nth switch: a name already ending `(part 3)` switches to `(part 4)`, a bare name to `(part 1)`. */
export function partNamingFor(name: string): PartNaming {
  const found = PART_SUFFIX.exec(name.trim());
  const base = found ? name.trim().slice(0, found.index) : name.trim();
  const part = found ? Number.parseInt(found[1], 10) + 1 : 1;
  const safeBase = base || 'mu';
  return { oldTitle: `${safeBase} (part ${part})`, newTitle: safeBase, part };
}

/**
 * `partNamingFor`, minus collisions: the old part's `(part N)` keeps bumping
 * while another conversation already holds that exact title. A second switch
 * off a clean-named part would otherwise rename it `(part 1)` — the same title
 * the first switch left behind — and the chain's name-parsed dropdown would
 * show two `part 1` rows. `takenTitles` is every conversation title the backend
 * lists (the collision is confusing whatever the family); a list that lags or
 * truncates only degrades back to the plain numbering.
 */
export function partNamingAvoiding(name: string, takenTitles: ReadonlyArray<string>): PartNaming {
  const naming = partNamingFor(name);
  const taken = new Set(takenTitles.map((title) => title.trim()));
  let { oldTitle, part } = naming;
  while (taken.has(oldTitle)) {
    part += 1;
    oldTitle = `${naming.newTitle} (part ${part})`;
  }
  return { ...naming, oldTitle, part };
}
