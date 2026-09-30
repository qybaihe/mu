/** Where a native conversation lives in the app, and how its folder is named on screen. */

/** The route of a native conversation. */
export const nativeConversationPath = (id: string): string => `/conversation/native/${encodeURIComponent(id)}`;

/** The last part of a folder's path: what a person calls the project. */
export const folderName = (cwd: string): string =>
  cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .pop() || cwd;
