/**
 * Names that earlier versions of the app wrote and that are already on people's machines. The app began as a fork of
 * AionUi and kept its names at first. Some are only read, to move what is stored under them to mu's names. The others
 * stay in use, because renaming them would lose or break what people have: a folder that stored paths point into, a
 * file the app still reads and writes, a record other records name. Everything else in the app has mu's names.
 */

/**
 * The app's data folder inside its profile (`<userData>/aionui`). AionCore's database stores absolute paths into it:
 * through the `~/.mu-desktop` shortcut on macOS, as they are on Windows and Linux.
 */
export const DATA_FOLDER = 'aionui';

/** The folder in the system's temporary folder that the first versions kept their data in, moved from at start. */
export const LEGACY_TEMP_FOLDER = 'aionui';

/** A development build's profile folder (and with MU_MULTI_INSTANCE=1, the second instance's): its data stays there. */
export const DEV_PROFILE_NAMES = { first: 'AionUi-Dev', second: 'AionUi-Dev-2' } as const;

/**
 * A development build's home-folder shortcuts to its data and config folders (`~/.aionui-dev`, `~/.aionui-config-dev`,
 * and `-dev-2` for the second instance), through which the paths it stored were written. A packaged build has mu's
 * own (`~/.mu-desktop`, `~/.mu-desktop-config`).
 */
export const DEV_SHORTCUT_BASES = { data: '.aionui', config: '.aionui-config' } as const;

/** The files in the config folder the app keeps the local service's folders and its first versions' data in. */
export const CONFIG_FILES = {
  config: 'aionui-config.txt',
  chatMessage: 'aionui-chat-message.txt',
  chat: 'aionui-chat.txt',
  env: '.aionui-env',
  chatHistory: 'aionui-chat-history',
} as const;

/** The key, in `CONFIG_FILES.env`, under which the local service's cache, work and log folders are kept. */
export const DIRS_KEY = 'aionui.dir';

/** The database of the first versions, migrated from at start. */
export const LEGACY_DATABASE_FILE = 'aionui.db';

/** A file in the home folder that earlier versions kept the CDP ports in, removed at start. */
export const LEGACY_CDP_REGISTRY_FILE = '.aionui-cdp-registry.json';

/** The built-in browser's own session (its cookies and sign-ins), kept on disk under this partition. */
export const BROWSER_PARTITION = 'persist:aionui-browser';

/**
 * The built-in MCP servers' names. AionCore's database finds their records by these names, and conversations keep
 * the names of the servers they were made with.
 */
export const BUILTIN_MCP_SERVER_NAMES = {
  browser: 'aionui-browser',
  imageGeneration: 'aionui-image-generation',
} as const;

/** The image generation server's record name in the first versions, which a record may still have. */
export const FIRST_IMAGE_GEN_SERVER_NAME = 'AionUi Image Generation';

/** The markers around the background block of a custom CSS theme, as earlier versions wrote them. */
export const LEGACY_BACKGROUND_BLOCK = {
  start: '/* AionUi Theme Background Start */',
  end: '/* AionUi Theme Background End */',
} as const;

/**
 * The components' class names before they were mu's (`.aionui-modal`, `.aion-select`): the name after the prefix is
 * in the first group or the second. A custom CSS theme written then may still target them.
 */
export const LEGACY_CLASS_NAMES = /\.(?:aionui-(modal|steps|markdown)|aion-(select|url-viewer-toolbar|dir-input))\b/g;

/**
 * The image generation server's settings before they were named mu (`IMAGE_GEN_ENV_KEYS`). They are kept in the
 * server's record in AionCore's database, so a server set up earlier still has them until its settings are written.
 */
export const LEGACY_IMAGE_GEN_ENV_KEYS = {
  providerId: 'AIONUI_IMG_PROVIDER_ID',
  platform: 'AIONUI_IMG_PLATFORM',
  baseUrl: 'AIONUI_IMG_BASE_URL',
  apiKey: 'AIONUI_IMG_API_KEY',
  model: 'AIONUI_IMG_MODEL',
  proxy: 'AIONUI_IMG_PROXY',
} as const;

/** The renderer's local storage keys before they were mu's: each old key, and the key it is now. */
export const LEGACY_STORAGE_KEYS: ReadonlyArray<readonly [legacy: string, current: string]> = [
  ['__aionui_theme', '__mu_theme'],
  ['__aionui_theme_follows_system', '__mu_theme_follows_system'],
  ['aionui.emoji.recent', 'mu.emoji.recent'],
  ['aionui.gpuAutoDisableNoticeAckAt', 'mu.gpuAutoDisableNoticeAckAt'],
  ['aionui:recent-workspaces', 'mu:recent-workspaces'],
  ['aionui_workspace_expansion', 'mu_workspace_expansion'],
  ['aionui_workspace_update_time', 'mu_workspace_update_time'],
  ['aionui_agent_browser_first_use_notified', 'mu_agent_browser_first_use_notified'],
  ['aionui_cron_unread', 'mu_cron_unread'],
];

/**
 * Moves what is stored under an old key to its current key, once: a key that already has a value keeps it. Run before
 * anything reads storage (the renderer's runtime patches do).
 */
export function migrateLegacyStorageKeys(storage: Storage): void {
  for (const [legacy, current] of LEGACY_STORAGE_KEYS) {
    try {
      const value = storage.getItem(legacy);
      if (value === null) continue;
      if (storage.getItem(current) === null) storage.setItem(current, value);
      storage.removeItem(legacy);
    } catch {
      // Storage that refuses (full, or blocked) keeps the old key; the setting starts over under the new one.
    }
  }
}
