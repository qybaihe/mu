import { bridge } from '../platform/bridge';
import type { McpServerInput, MuMcpServers, MuSkills } from './capabilities';
import type { ClmServerState } from './clm';
import { KyrnError, type KyrnResult } from './errors';
import type { ImportedHistory, ImportList, ImportOutcome } from './importChats';
import type { LessonChange, LessonsView } from './lessons';
import type { LocalJudgeAction, LocalJudgeState } from './localJudge';
import type { LoginState, LoginStatus, SubscriptionProvider } from './login';
import type {
  AvailableModels,
  DefaultModelChange,
  ModelDefaults,
  ModelThinkingLevels,
  ProviderTestInput,
  ProviderTestResult,
} from './models';
import type { ActivityPage, KyrnCatalog, KyrnSettings, SaveSettings } from './types';

export const kyrnBridge = {
  catalog: bridge.buildProvider<KyrnResult<KyrnCatalog>, void>('kyrn.catalog'),
  settings: bridge.buildProvider<KyrnResult<KyrnSettings>, void>('kyrn.settings'),
  save: bridge.buildProvider<KyrnResult<KyrnSettings>, SaveSettings>('kyrn.save'),
  /** Models the running mu last reported as usable: a snapshot kept by the backend, not a live query. */
  availableModels: bridge.buildProvider<KyrnResult<AvailableModels>, void>('kyrn.availableModels'),
  /** The model new sessions start on, and a send box's "make default", which changes only that. */
  defaultModel: bridge.buildProvider<KyrnResult<ModelDefaults>, void>('kyrn.defaultModel'),
  setDefaultModel: bridge.buildProvider<KyrnResult<ModelDefaults>, DefaultModelChange>('kyrn.setDefaultModel'),
  /** The backend checks mu again and keeps that snapshot anew; answers once it has. */
  recheck: bridge.buildProvider<KyrnResult<void>, void>('kyrn.recheck'),
  /** One minimal request to a provider's endpoint, made by the main process. */
  testProvider: bridge.buildProvider<KyrnResult<ProviderTestResult>, ProviderTestInput>('kyrn.testProvider'),
  /** A page of a conversation's activity; with `kinds`, only events of those kinds (the cursor still covers all). */
  activity: bridge.buildProvider<
    KyrnResult<ActivityPage>,
    { conversationId: string; sessionId?: string; cursor: number; kinds?: string[] }
  >('kyrn.activity'),
  /** The thinking levels each model of a conversation's session takes; empty for a conversation mu does not run. */
  modelLevels: bridge.buildProvider<KyrnResult<ModelThinkingLevels>, { conversationId: string }>('kyrn.modelLevels'),
  /** A conversation's lessons: its project's and those for everywhere, read from mu's file (common/kyrn/lessons.ts). */
  lessons: bridge.buildProvider<KyrnResult<LessonsView>, { conversationId: string }>('kyrn.lessons'),
  /** A new text or the retirement of one lesson, appended to the file as a line; answers with the lessons after it. */
  lessonsChange: bridge.buildProvider<KyrnResult<LessonsView>, LessonChange>('kyrn.lessons.change'),
  /**
   * Claude Code and Codex conversations on this computer (common/kyrn/importChats.ts); with `cwd`, only that project's.
   * Each says whether a conversation holds it already: with `native`, the mu session made from it.
   */
  importList: bridge.buildProvider<KyrnResult<ImportList>, { cwd?: string; native?: boolean }>('kyrn.import.list'),
  /**
   * Brings these transcripts into mu and makes each an app conversation in its project folder, created with the
   * assistant snapshot in `locale`; with `native`, the mu session each became is the conversation and none is made.
   * One outcome per transcript; a failed one does not stop the others.
   */
  importRun: bridge.buildProvider<KyrnResult<ImportOutcome[]>, { paths: string[]; locale: string; native?: boolean }>(
    'kyrn.import.run'
  ),
  /** What an imported conversation said before it came to mu, to read back. */
  importHistory: bridge.buildProvider<KyrnResult<ImportedHistory>, { conversationId: string }>('kyrn.import.history'),
  /** Signing in to a subscription with pi's OAuth flow; see common/kyrn/login.ts. */
  loginStart: bridge.buildProvider<KyrnResult<LoginState>, { provider: SubscriptionProvider }>('kyrn.login.start'),
  loginState: bridge.buildProvider<KyrnResult<LoginState>, void>('kyrn.login.state'),
  loginAnswer: bridge.buildProvider<KyrnResult<LoginState>, { id: number; value: string }>('kyrn.login.answer'),
  loginCancel: bridge.buildProvider<KyrnResult<LoginState>, void>('kyrn.login.cancel'),
  loginStatus: bridge.buildProvider<KyrnResult<LoginStatus>, void>('kyrn.login.status'),
  loginLogout: bridge.buildProvider<KyrnResult<LoginStatus>, { provider: SubscriptionProvider }>('kyrn.login.logout'),
  /** The local judge (Laya) on this machine; see common/kyrn/localJudge.ts. */
  localJudgeState: bridge.buildProvider<KyrnResult<LocalJudgeState>, void>('kyrn.localJudge.state'),
  /** `consent`: the person agreed to what `setup` downloads. */
  localJudgeRun: bridge.buildProvider<KyrnResult<LocalJudgeState>, { action: LocalJudgeAction; consent?: boolean }>(
    'kyrn.localJudge.run'
  ),
  /** How the CLM server behind a judge's address is (common/kyrn/clm.ts), asked by the main process. */
  clmCheck: bridge.buildProvider<KyrnResult<ClmServerState>, { baseUrl: string }>('kyrn.clm.check'),
  /** The skills mu loads in every conversation, and where each comes from (common/kyrn/capabilities.ts). */
  skills: bridge.buildProvider<KyrnResult<MuSkills>, void>('kyrn.skills'),
  /** Copies a skill folder (or the folder of a SKILL.md) into mu's skills folder; answers with the skills after it. */
  skillAdd: bridge.buildProvider<KyrnResult<MuSkills>, { path: string }>('kyrn.skills.add'),
  /** Moves a skill of mu's own folder to the trash; one from anywhere else is refused (`notMine`). */
  skillRemove: bridge.buildProvider<KyrnResult<MuSkills>, { name: string }>('kyrn.skills.remove'),
  /** The MCP servers mu uses in every conversation, and where each is defined. Nothing is started. */
  mcpServers: bridge.buildProvider<KyrnResult<MuMcpServers>, void>('kyrn.mcp'),
  /** Adds a server to mu's `mcp.json`, as `mu mcp add` does. */
  mcpAdd: bridge.buildProvider<KyrnResult<MuMcpServers>, McpServerInput>('kyrn.mcp.add'),
  /** Removes one of mu's own servers; a server taken over from another tool is refused (`notMine`). */
  mcpRemove: bridge.buildProvider<KyrnResult<MuMcpServers>, { name: string }>('kyrn.mcp.remove'),
  /** Switches a server on or off in mu's own configuration; another tool's file is never written. */
  mcpSwitch: bridge.buildProvider<KyrnResult<MuMcpServers>, { name: string; on: boolean }>('kyrn.mcp.switch'),
  /** Opens mu's skills folder, or shows its `mcp.json`, in the file manager. */
  capabilityReveal: bridge.buildProvider<KyrnResult<void>, { what: 'skills' | 'mcp' }>('kyrn.capabilities.reveal'),
};

/** The data of a bridge answer; a failure is thrown as a `KyrnError` that keeps its code for the screen to translate. */
export function unwrap<T>(result: KyrnResult<T>): T {
  if (result.ok === false) throw new KyrnError(result.code ?? 'unknown', result.error, result.params);
  return result.data;
}
