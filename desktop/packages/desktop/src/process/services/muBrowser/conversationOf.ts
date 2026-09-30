/**
 * The app conversation a run of mu's browser belongs to, by the session name mu reports with it: a native
 * conversation's by the name the app gave its mu (MU_DESKTOP_SESSION, answered with the id the conversation has now,
 * a draft's having given way to its session's), else the AionCore conversation an ACP session is bound to. Undefined
 * when neither knows it (or the binding cannot be read): the panel then opens the tab beside the conversation on screen.
 */
export function browserConversationOf(
  session: string,
  lookups: { native: (session: string) => string | undefined; classic: (session: string) => string }
): string | undefined {
  const native = lookups.native(session);
  if (native) return native;
  try {
    return lookups.classic(session) || undefined;
  } catch {
    return undefined;
  }
}
