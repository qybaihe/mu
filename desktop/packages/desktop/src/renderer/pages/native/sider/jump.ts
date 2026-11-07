/**
 * Going to a native conversation from the keyboard, anywhere in the app (useConversationShortcuts.ts): Cmd/Ctrl+1 to 9
 * open the conversation in that place of the sidebar's list as it shows it, Ctrl+Tab and Ctrl+Shift+Tab the one under
 * or above the one on screen, and Cmd/Ctrl+Shift+A the next one that wants its person (marked unread: a run ended or
 * failed, or pi asks something, while another one was on screen).
 *
 * The sidebar's group publishes its order as it renders (NativeSiderGroup.tsx): the rows on screen, and every
 * conversation it lists, those in a folded project or past a project's first few included; the archived ones are not
 * in either. The order stays when the list goes away (the sidebar folded to its rail, the settings), so the keys keep
 * the order it showed last.
 */

let shown: readonly string[] = [];
let listed: readonly string[] = [];

/** The sidebar's rows on screen, top to bottom, and every conversation it lists, in its order. */
export function publishNativeSiderOrder(rows: readonly string[], all: readonly string[]): void {
  shown = rows;
  listed = all;
}

/** The conversation in this place (1 to 9) of the rows on screen; of all the list holds when none is on screen. */
export function nativeConversationAt(place: number): string | undefined {
  return (shown.length > 0 ? shown : listed)[place - 1];
}

/** The row under (1) or above (-1) the conversation on screen, round to the other end; the first one from elsewhere. */
export function nativeConversationBeside(current: string | undefined, direction: 1 | -1): string | undefined {
  const rows = shown.length > 0 ? shown : listed;
  if (rows.length === 0) return undefined;
  const at = current ? rows.indexOf(current) : -1;
  if (at < 0) return direction === 1 ? rows[0] : rows.at(-1);
  const next = rows[(at + direction + rows.length) % rows.length];
  return next === current ? undefined : next;
}

/**
 * The next conversation after `current` that is marked unread, in the list's order and round to its start (from the
 * start when `current` is not in it). Before the list has published an order, the marks' own order.
 */
export function nextWaitingConversation(unread: ReadonlySet<string>, current?: string): string | undefined {
  const order = listed.length > 0 ? listed : [...unread];
  const start = current ? order.indexOf(current) + 1 : 0;
  for (let step = 0; step < order.length; step++) {
    const id = order[(start + step) % order.length];
    if (id !== current && unread.has(id)) return id;
  }
  return undefined;
}

/** Forget the order: a test starts from none. */
export function resetNativeSiderOrderForTest(): void {
  shown = [];
  listed = [];
}
