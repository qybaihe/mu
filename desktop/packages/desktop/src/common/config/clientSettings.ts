import type { IMcpServer, TProviderWithModel } from '@/common/config/storage';

export type GoogleClientSetting = {
  proxy?: string;
};

export type ImageGenerationModelSetting = TProviderWithModel & {
  switch?: boolean;
};

/**
 * The high-frequency decision model: the cheap model behind the ⚡
 * short-circuits (supervisor team reuse, position off-domain rejection).
 * Stored as a provider reference plus the model name — `api_key` and
 * `base_url` stay empty because secrets stay in the provider store; the
 * service resolves them at call time. Undefined = the feature is off.
 */
export type QuickDecisionModelSetting = TProviderWithModel;

/**
 * The resident inspection's two schedules. Both default ON: undefined means
 * "never configured", only an explicit `false` (the settings switch) turns a
 * schedule off — the switch reads/writes booleans and never stores `true`.
 */
export type InspectionToggleSetting = boolean | undefined;

/**
 * The context steward's master switch: undefined = ON (a fresh install runs
 * it), only an explicit `false` turns it off — the same never-store-`true`
 * shape as the inspection toggles.
 */
export type ContextStewardToggleSetting = boolean | undefined;

/**
 * The steward's check-line ratio override (0 < r ≤ 1). Undefined = the
 * built-in 0.8 default. A test/E2E knob rather than a user setting: the
 * ratio's why lives with the constants in contextStewardCore, and a value a
 * user could not reason about is not one to expose.
 */
export type ContextStewardRatioSetting = number | undefined;

export type ClientBusinessSettingMap = {
  'google.config': GoogleClientSetting;
  'mcp.config': IMcpServer[] | undefined;
  'tools.imageGenerationModel': ImageGenerationModelSetting | undefined;
  'tools.quickDecisionModel': QuickDecisionModelSetting | undefined;
  'tools.inspectionFrictionEnabled': InspectionToggleSetting;
  'tools.inspectionWasteEnabled': InspectionToggleSetting;
  'tools.contextStewardEnabled': ContextStewardToggleSetting;
  'tools.contextStewardCheckRatio': ContextStewardRatioSetting;
  'acp.promptTimeout': number | undefined;
  'acp.agentIdleTimeout': number | undefined;
  /**
   * Preview size ceiling for text-like files, **in whole megabytes**.
   *
   * Stored in MB rather than bytes because that is the unit the settings field
   * presents; the byte conversion belongs to the one place that compares against a
   * file size (`resolvePreviewPayload`). Keeping the stored unit and the displayed
   * unit identical means a value read back from storage never has to be
   * reinterpreted.
   *
   * `undefined` means "never configured" and falls back to the built-in default —
   * distinct from any number the user could enter.
   */
  'preview.textSizeLimitMb': number | undefined;
};

export type ClientBusinessSettingKey = keyof ClientBusinessSettingMap;
