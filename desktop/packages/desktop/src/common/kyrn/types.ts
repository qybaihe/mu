import type { Assistant } from '../types/agent/assistantTypes';
import type { DecisionMode, FeatureState, HarnessState } from './manifest';
import type { ModelsSettings } from './models';

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };
/** `classifier`: a classifier model of mu's model catalog, `model` = "provider/model-id" (Jev on OpenCode Zen, Clef…). */
export type JudgeType = 'jev' | 'typesafe' | 'clm' | 'gateway' | 'local' | 'http' | 'llm' | 'classifier' | 'mock';
export type JudgeSettings = {
  type: JudgeType;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  timeoutMs: number;
};
/**
 * The permission mode a new conversation starts in. mu reads, in order: the conversation's own switch, `MU_PERMISSIONS`,
 * the last pick (`<agentDir>/mu/permissions.json`, written by `/permissions` and by this page), then mu.json.
 */
export type PermissionDefault = {
  /** full, jev or ask; '' when this harness has no permission modes. */
  mode: string;
  /** picked: the last pick; config: `features.permissions.mode` in mu.json; default: the harness's own. */
  from: 'picked' | 'config' | 'default';
};
/** The model that writes the plain-language board: `model` in `<agentDir>/mu/board.json`, which `/board model` also sets. */
export type BoardModel = {
  /** Whether this harness lets a chosen model write the board. */
  supported: boolean;
  /** "provider/model", "session" (the conversation's model), or '' (asked the first time the board is switched on). */
  model: string;
};
export type KyrnSettings = {
  /**
   * One hash over mu.json, pi's settings.json, models.json, the permission default and the board's model: a save based
   * on an older one is refused.
   */
  revision: string;
  tiers: string[];
  judges: Record<string, JudgeSettings>;
  mode: DecisionMode;
  betaCompression: boolean;
  autoCompaction: boolean;
  maxContextTokens: number;
  keys: Record<string, boolean>;
  /** What the harness says it can do. Without it only the basic settings are shown. */
  harness: HarnessState;
  /** Per-decision overrides of `mode`, by decision id. A decision that follows the default is absent. */
  decisionModes: Record<string, DecisionMode>;
  /** One entry per feature the manifest describes. */
  features: Record<string, FeatureState>;
  models: ModelsSettings;
  permissions: PermissionDefault;
  boardModel: BoardModel;
};
export type Credential = { name: string; value: string };
/**
 * What `read()` returned, with changes. `decisionModes`, `features` and `models` may be left out: that part of the
 * files is then not touched. Keys only travel this way, in `credential` / `credentials`.
 */
export type SaveSettings = Omit<
  KyrnSettings,
  'keys' | 'harness' | 'decisionModes' | 'features' | 'models' | 'permissions' | 'boardModel'
> & {
  decisionModes?: Record<string, DecisionMode>;
  features?: Record<string, FeatureState>;
  /** `removeEntries`: ids of hand-written models.json entries (`foreign`) to delete. */
  models?: Pick<ModelsSettings, 'providers' | 'defaults'> & { removeEntries?: string[] };
  credential?: Credential;
  credentials?: Credential[];
  /** The permission mode of new conversations. Written only when it changes. */
  permissions?: Pick<PermissionDefault, 'mode'>;
  /** The board's model. Written only when it changes. */
  boardModel?: Pick<BoardModel, 'model'>;
};
export type Activity = {
  id: string;
  at: number;
  kind: string;
  run?: string;
  bee?: string;
  runtimeId?: string;
  turnId?: number;
  sequence?: number;
  payload: Record<string, unknown>;
};
export type ActivityPage = { sessionId: string; cursor: number; more: boolean; events: Activity[] };
export type KyrnCatalog = { agentId: string; assistants: Assistant[] };
