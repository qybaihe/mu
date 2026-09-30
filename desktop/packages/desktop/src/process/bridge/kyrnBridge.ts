import { basename, dirname, join } from 'node:path';
import { app, net, shell, utilityProcess } from 'electron';
import { kyrnBridge } from '../../common/kyrn/bridge';
import { KyrnError, kyrnFailure, type KyrnResult } from '../../common/kyrn/errors';
import { kyrnFolderBridge } from '../../common/kyrn/folderBridge';
import type { KyrnCatalog } from '../../common/kyrn/types';
import { httpRequest } from '../../common/adapter/httpBridge';
import { SettingsStore } from '../agent/kyrn/settings';
import { availableModels } from '../agent/kyrn/config/available';
import { LoginManager, openable, spawnAuth } from '../agent/kyrn/login';
import { testProvider } from '../agent/kyrn/config/connection';
import { envFileOf, expectedHarness, findHarness, launcherOf, manifestOf } from '../agent/kyrn/harness';
import { checkClmServer } from '../agent/kyrn/clmServer';
import { LocalJudge } from '../agent/kyrn/localJudge';
import { OnnxLocalJudge, openFolder, usesOnnxJudge } from '../agent/kyrn/localJudgeOnnx';
import { importCli, importService } from '../agent/kyrn/importChats';
import { LessonsStore, lessonsProject, type LessonsProject } from '../agent/kyrn/lessons';
import { listFolder, readFolder } from '../agent/kyrn/folderFiles';
import { activityPage, modelLevels } from '../agent/kyrn/telemetry';
import { findRegistration, initializeKyrn, recheckKyrn, type OwnCommand } from '../agent/kyrn/product';
import { ownLauncher } from '../agent/kyrn/windows/launcherCommand';
import { muEnv, muHome } from '../agent/kyrn/naming';
import { asRecord, text } from '../agent/kyrn/piRpc';
import { sessionBinding } from '../agent/kyrn/sessionBinding';
import { conversationSessions } from '../agent/kyrn/conversationSession';
import { getDataPath } from '../utils/utils';

/**
 * `out/main/localJudgeOnnx.js`, next to the main entry even when this module sits in `out/main/chunks/`. Found from
 * `__dirname`: `require.main.filename` is the string "electron" in Electron 44, so a path built from it is relative.
 */
function localJudgeEntry(): string {
  return join(basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname, 'localJudgeOnnx.js');
}

// Always answer IPC, including failure: the generic bridge otherwise only logs exceptions.
async function result<T>(work: () => T | Promise<T>): Promise<KyrnResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return kyrnFailure(error);
  }
}

const isKindName = (kind: unknown): kind is string => typeof kind === 'string' && /^[\w.-]{1,64}$/.test(kind);

/** The event kinds an activity reader may ask for: a few names, never a pattern. */
function activityKinds(kinds: unknown): string[] | undefined {
  if (kinds === undefined) return undefined;
  if (!Array.isArray(kinds) || kinds.length > 16 || !kinds.every(isKindName))
    throw new KyrnError('invalid', 'Invalid activity kinds');
  return kinds;
}

/**
 * An app conversation as mu sees it: its `extra` (the workspace among it), and the mu session behind it, '' when mu
 * does not run it (another agent, or not started yet). `sessionOf` asks the backend only the first time.
 */
const { conversation: conversationOf, session: sessionOf } = conversationSessions(
  async (conversationId) => {
    if (!/^[a-zA-Z0-9-]{1,80}$/.test(conversationId)) throw new KyrnError('invalid', 'Invalid conversation');
    const conversation = await httpRequest<Record<string, unknown>>('GET', `/api/conversations/${conversationId}`);
    return asRecord(conversation.extra);
  },
  (conversationId, agentId) => sessionBinding(getDataPath(), conversationId, agentId)
);

export function initKyrnBridge(): void {
  const desktopRoot = process.env.KYRN_DESKTOP_ROOT || process.cwd();
  // KYRN_ROOT / MU_ROOT, the copy the packaged app carries, a checkout beside this one, or mu-agent from npm. A
  // packaged app runs from no checkout, so nothing is looked for beside the folder it happens to start in.
  const checkout = app.isPackaged && !process.env.KYRN_DESKTOP_ROOT ? undefined : desktopRoot;
  // None found: where it should be, which then reads as no harness (no manifest) and mu offline. For a packaged app
  // that is its own copy, which only a broken build lacks.
  const found = findHarness(checkout);
  const harness = found ?? expectedHarness(checkout, process.resourcesPath);
  console.log(
    `[mu] harness: ${found ? `${found.source}, ${found.layout}` : 'none found, expected'} at ${harness.root}`
  );
  const root = harness.root;
  const home = muHome();
  const agentDir = muEnv('AGENT_DIR') || join(home, 'agent');
  const store = join(home, 'acp-sessions');
  const settings = new SettingsStore(agentDir, root, {
    env: envFileOf(harness, home, process.platform),
    manifest: manifestOf(harness, process.platform),
  });
  // The registration is found by this path, so it stays `acp` where it always was. Windows cannot start a bash
  // script: there the command is acp.cmd, which runs the same adapter with Node. The packaged app has no sources:
  // it carries the adapter bundled (out/main/mu-acp.js) and its launchers in resources/mu.
  const launchers = app.isPackaged ? join(process.resourcesPath, 'mu') : join(desktopRoot, 'scripts', 'kyrn');
  const launcher = join(launchers, process.platform === 'win32' ? 'acp.cmd' : 'acp');
  // What is registered: the launcher, or on Windows a spelling of it without spaces (windows/launcherCommand.ts).
  // Worked out once per start, again after a failure.
  let owning: Promise<OwnCommand> | undefined;
  const own = (): Promise<OwnCommand> => {
    owning ??= ownLauncher(launcher).then(
      (registered) => {
        if (registered.command !== launcher)
          console.log(`[mu] launcher: ${launcher}, registered as ${registered.command}`);
        return registered;
      },
      (error: unknown) => {
        owning = undefined;
        throw error;
      }
    );
    return owning;
  };
  let initialization: Promise<KyrnCatalog> | undefined;
  const catalog = (): Promise<KyrnCatalog> => {
    initialization ??= own()
      .then((command) => initializeKyrn(httpRequest, command))
      .catch((error) => {
        initialization = undefined;
        throw error;
      });
    return initialization;
  };
  kyrnBridge.catalog.provider(() => result(catalog));
  kyrnBridge.settings.provider(() => result(() => settings.read()));
  kyrnBridge.save.provider((input) => result(() => settings.save(input)));
  kyrnBridge.availableModels.provider(() =>
    result(async () => {
      const agents = await httpRequest<Parameters<typeof findRegistration>[0]>('GET', '/api/agents/management');
      return availableModels(findRegistration(agents, await own()));
    })
  );
  // After the start's own check, and one at a time: a change saved while a check runs is checked after it, so the
  // last check sees the last change.
  const recheck = async (): Promise<void> => {
    await catalog().catch((): undefined => undefined);
    await recheckKyrn(httpRequest, await own());
  };
  let rechecked = Promise.resolve();
  kyrnBridge.recheck.provider(() => {
    rechecked = rechecked.catch((): undefined => undefined).then(recheck);
    return result(() => rechecked);
  });
  // Chromium's network stack, not Node's: it goes through the system's proxy like a browser, and like mu (systemProxy.ts).
  kyrnBridge.testProvider.provider((input) =>
    result(() => testProvider(input, settings.storedKey(input.id), { fetch: (url, init) => net.fetch(url, init) }))
  );
  const login = new LoginManager(spawnAuth(launcherOf(harness, process.platform), agentDir), (url) => {
    if (openable(url)) void shell.openExternal(url);
  });
  kyrnBridge.loginStart.provider(({ provider }) => result(() => login.start(provider)));
  kyrnBridge.loginState.provider(() => result(() => login.state()));
  kyrnBridge.loginAnswer.provider(({ id, value }) => result(() => login.answer(id, value)));
  kyrnBridge.loginCancel.provider(() => result(() => login.cancel()));
  kyrnBridge.loginStatus.provider(() => result(() => login.status()));
  kyrnBridge.loginLogout.provider(({ provider }) => result(() => login.logout(provider)));
  // A sign-in, or a look at who is signed in, still running when the app quits is ended with it.
  app.once('will-quit', () => login.dispose());
  // Core ML on Apple Silicon Macs, the app's own ONNX judge on Windows and Linux: the same state and actions.
  const localJudge = usesOnnxJudge(process.platform, process.arch, process.env)
    ? new OnnxLocalJudge({
        fork: (env) =>
          utilityProcess.fork(localJudgeEntry(), [], { env, stdio: 'pipe', serviceName: 'mu local judge' }),
        open: (folder) => openFolder(folder, (path) => shell.openPath(path)),
      })
    : new LocalJudge(
        root,
        harness.layout === 'package' ? { stateDir: muEnv('LOCAL_JUDGE_RUN_DIR') || join(home, 'local-judge') } : {}
      );
  if (localJudge instanceof OnnxLocalJudge)
    void localJudge.autoStart(agentDir).catch((error: unknown) => console.warn('[mu] local judge autostart:', error));
  kyrnBridge.localJudgeState.provider(() => result(() => localJudge.state()));
  kyrnBridge.localJudgeRun.provider(({ action, consent }) => result(() => localJudge.run(action, consent === true)));
  kyrnBridge.clmCheck.provider(({ baseUrl }) =>
    result(() => checkClmServer(typeof baseUrl === 'string' ? baseUrl : ''))
  );
  kyrnBridge.activity.provider((input) =>
    result(async () => {
      const kinds = activityKinds(input.kinds);
      const sessionId = await sessionOf(input.conversationId);
      if (!sessionId) return { sessionId: '', cursor: 0, more: false, events: [] };
      return activityPage(store, sessionId, input.sessionId === sessionId ? input.cursor : 0, kinds);
    })
  );
  kyrnBridge.modelLevels.provider((input) =>
    result(async () => {
      const sessionId = await sessionOf(input.conversationId);
      return sessionId ? modelLevels(store, sessionId) : {};
    })
  );
  const lessons = new LessonsStore(agentDir);
  const projectOf = async (conversationId: string): Promise<LessonsProject> => {
    const { extra, sessionId } = await conversationOf(conversationId);
    return lessonsProject(store, sessionId, text(extra.workspace));
  };
  kyrnBridge.lessons.provider(({ conversationId }) =>
    result(async () => lessons.view(await projectOf(conversationId)))
  );
  kyrnBridge.lessonsChange.provider((change) =>
    result(async () => lessons.change(await projectOf(change.conversationId), change))
  );
  // A native conversation's panel reads by its folder: it has no AionCore conversation (common/kyrn/folderBridge.ts).
  const folderProject = (cwd: unknown): LessonsProject => lessonsProject(store, '', readFolder(cwd));
  kyrnFolderBridge.lessons.provider(({ cwd }) => result(() => lessons.view(folderProject(cwd))));
  kyrnFolderBridge.lessonsChange.provider(({ cwd, ...change }) =>
    result(() => lessons.change(folderProject(cwd), change))
  );
  kyrnFolderBridge.files.provider(({ cwd, path }) => result(() => listFolder(readFolder(cwd), path)));
  const imports = importService({
    cli: importCli(harness),
    // A conversation deleted since it was made is no error here: the import makes a new one.
    request: <T>(method: string, path: string, body?: unknown) =>
      httpRequest<T>(method, path, body, { silentStatuses: [404] }),
    store,
    assistant: async () => {
      const { assistants } = await catalog();
      const assistant = assistants.find((row) => row.enabled !== false) ?? assistants[0];
      if (!assistant) throw new KyrnError('runtimeOffline', 'mu has no assistant to start a conversation with');
      return assistant.id;
    },
  });
  kyrnBridge.importList.provider(({ cwd }) => result(() => imports.list(cwd)));
  kyrnBridge.importRun.provider(({ paths, locale }) => result(() => imports.run(paths, locale)));
  kyrnBridge.importHistory.provider(({ conversationId }) => result(() => imports.history(conversationId)));
}
