import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrowserPanelRequest } from '@/common/kyrn/browserBridge';
import { browserConversationOf } from '@process/services/muBrowser/conversationOf';
import { PanelHost } from '@process/services/muBrowser/panelHost';
import { NativeConversations } from '@process/services/nativeHost/conversations/NativeConversations';
import { FakePi } from '../conversations/fakePi';

/**
 * mu's browser tool names the conversation it works for by the session name the app gave its mu (MU_DESKTOP_SESSION);
 * the app's browser panel opens the run's tab beside that conversation (process/bridge/kyrnBrowserBridge.ts). For a
 * native conversation the name is the one the app handed its host, and the conversation is answered by the id it has
 * now: a draft's id gives way to its session's once pi names it.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'mu-native-browser-')));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const sessionsDir = join(agentDir, 'sessions');
  const project = join(root, 'project');
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(project);
  const pi = new FakePi(sessionsDir);
  const conversations = new NativeConversations({
    events: { records: () => {}, status: () => {}, replaced: () => {}, changed: () => {}, attention: () => {} },
    startHost: pi.startHost,
    folders: () => ({ agentDir, sessionsDir }),
    env: (conversation) => ({ MU_DESKTOP_SESSION: conversation.desktopSession }),
    trash: async () => {},
    log: () => {},
  });
  return { pi, conversations, project };
}

/** The real clock's timer: session files are read on it. */
const realTimeout = globalThis.setTimeout;
const quiet = () => new Promise((resolve) => realTimeout(resolve, 20));

describe('the conversation a run of mu’s browser belongs to', () => {
  it('is a native conversation by the name its mu was given, else the ACP session’s, else none', () => {
    const lookups = {
      native: (session: string) => (session === 'n-1' ? 'session-1' : undefined),
      classic: (session: string) => (session === 'acp-1' ? 'conv-1' : ''),
    };
    expect(browserConversationOf('n-1', lookups)).toBe('session-1');
    expect(browserConversationOf('acp-1', lookups)).toBe('conv-1');
    expect(browserConversationOf('nobody', lookups)).toBeUndefined();
    // A binding that cannot be read is no conversation, not a failure of the run.
    expect(
      browserConversationOf('acp-1', {
        native: () => undefined,
        classic: () => {
          throw new Error('EACCES');
        },
      })
    ).toBeUndefined();
  });

  it('opens the tab beside a native conversation by the id its session gave it', async () => {
    const w = world();
    const draft = await w.conversations.create({ cwd: w.project });
    await w.conversations.request(draft.id, { type: 'prompt', message: 'open a page' });
    await w.pi.last.turn;
    await quiet();
    const session = w.pi.last.session.id;
    const name = w.pi.last.input.env.MU_DESKTOP_SESSION;
    expect(name).toMatch(/^n-/);

    const requests: BrowserPanelRequest[] = [];
    const panel = new PanelHost({
      request: (request) => requests.push(request),
      publish: () => {},
      page: async () => ({}) as never,
      conversationOf: (adapterSession) =>
        browserConversationOf(adapterSession, {
          native: (each) => w.conversations.conversationOf(each),
          classic: () => '',
        }),
      id: () => 'req-1',
      answerTimeoutMs: 50,
    });
    panel.setAvailable(true);
    const opening = panel.openTab({ session: name, url: 'https://example.com' });
    expect(requests).toEqual([{ kind: 'open', requestId: 'req-1', conversation: session, url: 'https://example.com' }]);
    expect(session).not.toBe(draft.id);
    panel.setAvailable(false);
    await expect(opening).rejects.toThrow('The conversation was closed');
    await w.conversations.dispose();
  });
});
