/**
 * Electron main of the browser bridge check: ONLY the bridge, plus one window whose page holds `<webview>` tabs.
 * No backend, no conversations, no real data: `HOME` is a throw-away directory, so the advert lands in a
 * throw-away mu home. The product's renderer is not part of this check; `openTab` below stands in for it.
 *
 * Besides the bridge it serves a small loopback control endpoint for the driver: it plays the person at the app
 * (pause, resume, stop, answering a confirmation, touching the page, opening DevTools) and reports what the
 * bridge published. That endpoint exists in this check only.
 */
import { app, BrowserWindow, session, type WebContents } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { MU_BROWSER_PARTITION, type BrowserRunEvent } from '@/common/kyrn/browserRun';
import { muHome } from '@process/agent/kyrn/naming';
import { removeAdvert, writeAdvert } from '@process/services/muBrowser/advert';
import { BrowserBridge } from '@process/services/muBrowser/bridge';
import { blankAndPainted, electronPage } from '@process/services/muBrowser/electronPage';
import { guardAgentPage, hardenAgentSession, lockWebviewPreferences } from '@process/services/muBrowser/pageGuards';
import { startBridgeServer } from '@process/services/muBrowser/server';

const controlFile = process.env.MU_CHECK_CONTROL_FILE ?? '';
const hostPage = process.env.MU_CHECK_HOST_PAGE ?? '';
if (!controlFile || !hostPage) {
  console.error('MU_CHECK_CONTROL_FILE and MU_CHECK_HOST_PAGE are required: start this through run.mjs');
  app.exit(2);
}
// The advert goes into the mu home of whatever HOME says. Never the person's real one.
if (!process.env.MU_CHECK_HOME || homedir() !== process.env.MU_CHECK_HOME) {
  console.error('Refusing to run outside the throw-away home that run.mjs prepares');
  app.exit(2);
}

const profile = mkdtempSync(join(tmpdir(), 'mu-bridge-check-profile-'));
app.setPath('userData', profile);
const guard = setTimeout(
  () => {
    console.error('[check] timed out');
    app.exit(2);
  },
  Number(process.env.MU_CHECK_TIMEOUT_MS ?? 120_000)
);

type Tab = { tabId: string; contents: WebContents };

async function run(): Promise<void> {
  const window = new BrowserWindow({
    width: 1000,
    height: 760,
    show: false,
    title: 'mu browser bridge check',
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  if (process.env.MU_CHECK_SHOW !== '0') window.showInactive();

  const agentSession = session.fromPartition(MU_BROWSER_PARTITION);
  const isAgentPage = (contents: WebContents) => contents.session === agentSession;
  const events: BrowserRunEvent[] = [];
  const tabs = new Map<string, Tab>();
  const tabOf = (contents: WebContents | null) => [...tabs.values()].find((tab) => tab.contents === contents)?.tabId;

  // The same locks the product puts on agent webviews, exercised for real: the host page below asks for Node
  // integration and popups on purpose, and the driver proves it got neither.
  window.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    if (params.partition === MU_BROWSER_PARTITION) lockWebviewPreferences(webPreferences, params);
  });
  hardenAgentSession(agentSession, (contents, refusal) => {
    const tabId = tabOf(contents);
    if (tabId) bridge.notice(tabId, refusal);
  });

  const attached: ((contents: WebContents) => void)[] = [];
  window.webContents.on('did-attach-webview', (_event, contents) => attached.shift()?.(contents));

  let opened = 0;
  let handOutAgain: string | undefined;
  const bridge = new BrowserBridge({
    openTab: async ({ conversation, url }) => {
      // The product's panel hands a conversation's finished mu tab out again; here the driver says when.
      const again = handOutAgain ? tabs.get(handOutAgain) : undefined;
      handOutAgain = undefined;
      if (again) {
        await blankAndPainted(again.contents);
        return {
          tabId: again.tabId,
          conversationId: conversation ?? 'focused-conversation',
          page: electronPage(again.contents, isAgentPage),
        };
      }
      const tabId = `tab-${++opened}`;
      const contents = await new Promise<WebContents>((resolve) => {
        attached.push(resolve);
        void window.webContents.executeJavaScript(
          `window.openTab(${JSON.stringify(tabId)}, ${JSON.stringify(url)}, ${JSON.stringify(MU_BROWSER_PARTITION)})`
        );
      });
      tabs.set(tabId, { tabId, contents });
      contents.once('destroyed', () => tabs.delete(tabId));
      guardAgentPage(contents, (refusal) => bridge.notice(tabId, refusal));
      await blankAndPainted(contents);
      return {
        tabId,
        conversationId: conversation ?? 'focused-conversation',
        page: electronPage(contents, isAgentPage),
      };
    },
    publish: (event) => events.push(event),
    keyboard: async (tabId) =>
      process.env.MU_CHECK_NO_KEYBOARD_GUARD === '1' ||
      ((await window.webContents.executeJavaScript(`window.keyboardTo(${JSON.stringify(tabId)})`)) as boolean),
  });

  await window.loadFile(hostPage);
  const server = await startBridgeServer(bridge);
  const home = muHome();
  const advert = writeAdvert(home, { url: server.url, pid: process.pid });

  const page = (tabId: string) => tabs.get(tabId)?.contents;
  const actions: Record<string, (body: Record<string, unknown>) => unknown> = {
    state: async () => ({
      runs: bridge.snapshot(),
      events,
      tabs: await Promise.all(
        [...tabs.values()].map(async ({ tabId, contents }) => ({
          tabId,
          url: contents.getURL(),
          debuggerAttached: contents.debugger.isAttached(),
          width: (await window.webContents.executeJavaScript(`window.tabWidth(${JSON.stringify(tabId)})`)) as number,
        }))
      ),
    }),
    control: ({ tabId, action }) => bridge.control(String(tabId), action as 'pause' | 'resume' | 'stop' | 'takeover'),
    confirm: ({ tabId, id, allowed }) => bridge.answerConfirm(String(tabId), String(id), allowed === true),
    // The person's own mouse on the page: through the same input path as a real click, not through the debugger.
    touch: ({ tabId }) => {
      const contents = page(String(tabId));
      contents?.sendInputEvent({ type: 'mouseDown', x: 4, y: 4, button: 'left', clickCount: 1 });
      contents?.sendInputEvent({ type: 'mouseUp', x: 4, y: 4, button: 'left', clickCount: 1 });
    },
    devtools: ({ tabId, open }) => {
      const contents = page(String(tabId));
      if (open === false) contents?.closeDevTools();
      else contents?.openDevTools({ mode: 'detach', activate: false });
    },
    host: async ({ tabId, focusDraft }) => {
      if (focusDraft === true) await window.webContents.executeJavaScript('window.focusDraft()');
      return {
        ...((await window.webContents.executeJavaScript('window.hostState()')) as Record<string, unknown>),
        pageFocused: page(String(tabId))?.isFocused() ?? false,
        windowFocused: window.isFocused(),
      };
    },
    // What the address bar above the page does: a navigation started by the app, not by the page.
    load: ({ tabId, url }) => {
      void page(String(tabId))
        ?.loadURL(String(url))
        .catch((): void => undefined);
    },
    reuse: ({ tabId }) => {
      handOutAgain = String(tabId);
    },
    detachDebugger: ({ tabId }) => page(String(tabId))?.debugger.detach(),
    resize: ({ tabId, width, height }) =>
      window.webContents.executeJavaScript(
        `window.resizeTab(${JSON.stringify(tabId)}, ${Number(width)}, ${Number(height)})`
      ),
    closeTab: ({ tabId }) => window.webContents.executeJavaScript(`window.closeTab(${JSON.stringify(tabId)})`),
    quit: () => {
      setTimeout(() => app.quit(), 50);
    },
  };

  const control = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const action = actions[(request.url ?? '/').slice(1)];
      Promise.resolve()
        .then(() =>
          action
            ? action(raw ? (JSON.parse(raw) as Record<string, unknown>) : {})
            : Promise.reject(new Error('unknown'))
        )
        .then(
          (result) => response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result ?? {})),
          (error) => response.writeHead(500).end(String(error))
        );
    });
  });
  await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
  writeFileSync(
    controlFile,
    JSON.stringify({
      port: (control.address() as AddressInfo).port,
      advert,
      pid: process.pid,
      electron: process.versions.electron,
    })
  );

  app.once('will-quit', () => {
    clearTimeout(guard);
    removeAdvert(home, server.url);
    bridge.dispose();
    void server.close();
    control.close();
    rmSync(profile, { recursive: true, force: true });
  });
}

app.on('window-all-closed', () => app.quit());
// No top-level await: `ready` is not delivered while an ESM entry is still evaluating (Electron 44).
void app.whenReady().then(run, (error) => {
  console.error(error);
  app.exit(2);
});
