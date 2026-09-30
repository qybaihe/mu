import { readFileSync } from 'node:fs';
import { appLanguageFilePath } from '../../i18n/appLanguage.ts';

/**
 * What a native conversation's mu gets in its environment besides the app's own, as the CLI bridge gives it
 * (KyrnAgent.ts `harnessEnv`):
 *
 * - MU_DESKTOP_SESSION: the app's name for the conversation, which mu hands back when it drives the app's browser, so
 *   the tab opens beside the right conversation (process/bridge/kyrnBrowserBridge.ts looks it up);
 * - MU_LANG: the app's language (`<mu home>/app-language`), read at every start so a new host follows a switch;
 * - MU_PERMISSIONS: the permission mode to start in, when the conversation has one (mu's own record of a switch in the
 *   session wins over it).
 */
export function hostEnv(input: {
  desktopSession: string;
  permissions?: string;
  home?: string;
}): Record<string, string> {
  let language: string | undefined;
  try {
    language = readFileSync(appLanguageFilePath(input.home), 'utf8').trim() || undefined;
  } catch {
    language = undefined;
  }
  return {
    MU_DESKTOP_SESSION: input.desktopSession,
    ...(language ? { MU_LANG: language } : {}),
    ...(input.permissions ? { MU_PERMISSIONS: input.permissions } : {}),
  };
}
