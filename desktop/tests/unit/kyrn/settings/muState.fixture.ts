/**
 * Two features of the harness manifest as the harness describes them (packages/kyrn-judge/manifest.json, trimmed to
 * what the page reads): the permission modes, whose one option is the mode a new conversation starts in, and the
 * board, whose model has a place of its own on the default model page. The shared fixture manifest is older.
 */
export const PERMISSIONS_FEATURE = {
  name: 'permissions',
  title: { zh: '权限模式', en: 'Permission modes' },
  summary: { zh: '完全访问、判定模式、最小权限三种模式。', en: 'Full access, Judge mode, or minimal permissions.' },
  defaultEnabled: true,
  options: [
    {
      key: 'mode',
      kind: 'choice',
      default: 'judge',
      choices: [
        { value: 'full', label: { zh: '完全访问', en: 'Full access' } },
        { value: 'judge', label: { zh: '判定模式', en: 'Judge mode' } },
        { value: 'ask', label: { zh: '最小权限', en: 'Minimal permissions' } },
      ],
      label: { zh: '新对话的默认模式', en: 'Mode of a new conversation' },
    },
  ],
};

export const BOARD_FEATURE = {
  name: 'board',
  title: { zh: '人话看板', en: 'Plain-language board' },
  summary: { zh: '用大白话告诉你项目推进到哪。', en: 'Tells you in plain words how far the work is.' },
  defaultEnabled: true,
  options: [
    {
      key: 'defaultOn',
      kind: 'boolean',
      default: false,
      label: { zh: '没单独设置过的项目也打开', en: 'On by default' },
    },
    { key: 'model', kind: 'text', default: '', label: { zh: '写看板的模型', en: 'Model that writes the board' } },
  ],
};

/** A manifest with both, from one without them. */
export const withOwnPlaces = <T extends { features: unknown[] }>(manifest: T): T => ({
  ...manifest,
  features: [...manifest.features, PERMISSIONS_FEATURE, BOARD_FEATURE],
});
