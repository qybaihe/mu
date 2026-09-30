import { app, BrowserWindow, session, webContents, type WebContents } from 'electron';
import { kyrnBrowserBridge } from '../../common/kyrn/browserBridge';
import { MU_BROWSER_PARTITION } from '../../common/kyrn/browserRun';
import { muHome } from '../agent/kyrn/naming';
import { conversationOfSession } from '../agent/kyrn/sessionBinding';
import { removeAdvert, writeAdvert } from '../services/muBrowser/advert';
import { BrowserBridge } from '../services/muBrowser/bridge';
import { browserConversationOf } from '../services/muBrowser/conversationOf';
import { blankAndPainted, electronPage } from '../services/muBrowser/electronPage';
import { guardAgentPage, hardenAgentSession, lockWebviewPreferences } from '../services/muBrowser/pageGuards';
import { PanelHost } from '../services/muBrowser/panelHost';
import { startBridgeServer } from '../services/muBrowser/server';
import { getDataPath } from '../utils/utils';
import { nativeConversationOf } from './nativeBridge';

/**
 * Offers the app's browser panel to a mu harness on this machine (kyrn/docs/features/embedded-browser.md in the
 * harness repository): a loopback socket with a random token as its path, advertised in the mu home for the user
 * alone. The app never opens `--remote-debugging-port`; the debugger is attached to agent tabs only.
 *
 * Never in the way of startup: if anything here fails, mu simply keeps using its own browser.
 */
export function initKyrnBrowserBridge(): void {
  void start().catch((error) => {
    console.warn('[mu browser] not offered:', error instanceof Error ? error.message : error);
  });
}

async function start(): Promise<void> {
  const agentSession = session.fromPartition(MU_BROWSER_PARTITION);
  const isAgentPage = (contents: WebContents) => contents.getType() === 'webview' && contents.session === agentSession;
  const tabOfPage = new Map<number, string>();
  const guarded = new WeakSet<WebContents>();

  const host = new PanelHost({
    request: (request) => kyrnBrowserBridge.request.emit(request),
    publish: (event) => kyrnBrowserBridge.events.emit(event),
    // A native conversation's mu names it by the name the app gave it (MU_DESKTOP_SESSION); an ACP session by its own.
    conversationOf: (adapterSession) =>
      browserConversationOf(adapterSession, {
        native: nativeConversationOf,
        classic: (named) => conversationOfSession(getDataPath(), named),
      }),
    nudge: (waiting) => {
      // A question is waiting and the person may be looking elsewhere: the taskbar or dock entry asks for them.
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.flashFrame(waiting && !window.isFocused());
      }
    },
    page: async (tabId, webContentsId) => {
      const contents = webContents.fromId(webContentsId);
      if (!contents || contents.isDestroyed() || !isAgentPage(contents)) {
        throw new Error("That is not a tab of the app's agent browser");
      }
      tabOfPage.set(contents.id, tabId);
      if (!guarded.has(contents)) {
        guarded.add(contents);
        const id = contents.id;
        contents.once('destroyed', () => tabOfPage.delete(id));
        guardAgentPage(contents, (refusal) => {
          const owner = tabOfPage.get(id);
          if (owner) bridge.notice(owner, refusal);
        });
      }
      await blankAndPainted(contents);
      return electronPage(contents, isAgentPage);
    },
  });
  const bridge = new BrowserBridge(host);

  hardenAgentSession(agentSession, (contents, refusal) => {
    const owner = contents ? tabOfPage.get(contents.id) : undefined;
    if (owner) bridge.notice(owner, refusal);
  });
  // Whatever the tag asked for, a webview in the agent's partition gets no Node, no preload and no popups.
  const lock = (embedder: WebContents) => {
    embedder.on('will-attach-webview', (_event, webPreferences, params) => {
      if (params.partition === MU_BROWSER_PARTITION) lockWebviewPreferences(webPreferences, params);
    });
  };
  for (const existing of webContents.getAllWebContents()) lock(existing);
  app.on('web-contents-created', (_event, created) => lock(created));

  kyrnBrowserBridge.snapshot.provider(async () => bridge.snapshot());
  kyrnBrowserBridge.control.provider(async ({ tabId, action }) => bridge.control(tabId, action));
  kyrnBrowserBridge.confirm.provider(async ({ tabId, id, allowed }) =>
    bridge.answerConfirm(tabId, id, allowed === true)
  );
  kyrnBrowserBridge.answer.provider(async (answer) => host.answer(answer));
  kyrnBrowserBridge.panel.provider(async ({ available }) => host.setAvailable(available === true));
  kyrnBrowserBridge.ready.provider(async ({ tabId, webContentsId }) => {
    if (typeof tabId === 'string' && Number.isInteger(webContentsId)) host.ready(tabId, webContentsId);
  });

  const server = await startBridgeServer(bridge);
  const home = muHome();
  writeAdvert(home, { url: server.url, pid: process.pid });
  // The port is no secret; the token in the path is, and is never logged.
  console.log(`[mu browser] offered to the harness on 127.0.0.1:${server.port}`);
  app.once('will-quit', () => {
    removeAdvert(home, server.url);
    bridge.dispose();
    void server.close();
  });
}
