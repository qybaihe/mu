/**
 * Who put something in the work panel, which decides what the panel does with it.
 *
 * - `user`: the person opened it (a file link, the explorer, a diff, a web link, the browser's plus). The panel comes
 *   up on the tab that shows it.
 * - `agent`: the agent opened it (mu's browser starting a run, a page a tool opened). That tab only gets its dot: the
 *   agent does not open the panel.
 * - `agent-watched`: mu's browser is about to type into its page, or asks the person to confirm a step on it. That
 *   work is done where the person can see it (a page out of view cannot even take the keyboard), so this one agent
 *   action brings the panel up on the browser.
 */
export type PreviewOpener = 'user' | 'agent' | 'agent-watched';

/** Which tab shows what was opened: 预览 for files and other previews, 浏览器 for web pages. */
export type OpenedIn = 'preview' | 'browser';

const listeners = new Set<(by: PreviewOpener, where: OpenedIn) => void>();

/** Hear every open, with who made it and where it shows. */
export function onPreviewOpened(listener: (by: PreviewOpener, where: OpenedIn) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Say that something was opened. `openPreview` says it for every preview, the browser's store for every page it
 * opens; mu's browser also says it when it brings an existing page forward, which changes what the browser shows
 * without opening anything.
 */
export function announcePreviewOpened(by: PreviewOpener, where: OpenedIn = 'preview'): void {
  for (const listener of listeners) listener(by, where);
}
