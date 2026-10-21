/**
 * Names the bundled backend reads and writes. The backend is a separate program (see NOTICE) whose protocol still
 * uses its upstream names: in the error codes and ownership it gives its own errors, in its environment variables,
 * headers, files and ids. The app can't rename them, so it speaks them only here and at the launcher, and turns the
 * backend's answers into mu's names where they come in. `tests/unit/i18n/noUpstreamNames.test.ts` keeps them here.
 */

/** The prefix the backend gives the codes of its own errors (`AIONUI_STREAM_BROKEN`); the app calls them `MU_…`. */
const BACKEND_CODE_PREFIX = 'AIONUI_';
const MU_CODE_PREFIX = 'MU_';

/** The ownership the backend gives its own errors; the app calls it `mu`. */
const BACKEND_OWN_OWNERSHIP = 'aionui';

/** The backend's file name for its database, in the app's data folder. */
export const BACKEND_DATABASE_FILE = 'aionui-backend.db';

/** The header that marks the app's own requests to the backend, as against a browser's. */
export const BACKEND_INTERNAL_HEADER = 'x-aionui-internal';

/** The source the backend gives a conversation made in the app, as against one from a chat channel. */
export const BACKEND_APP_SOURCE = 'aionui';

/** The id of the backend's built-in assistant that helps with the app itself (the Butler). */
export const BACKEND_BUTLER_ASSISTANT_ID = 'aionui-assistant';

/** The variable in which the backend names the conversation to an agent it starts (the ACP adapter). */
export const BACKEND_CONVERSATION_ID_ENV = 'AIONUI_CONVERSATION_ID';

/** The suffix the backend adds to the name of a file it stores for a message: `_aionui_` and the time in milliseconds. */
export const BACKEND_UPLOAD_SUFFIX = /_aionui_\d{13}(\.\w+)?$/;

/**
 * The backend's id for its built-in agent: a conversation's `type`, an assistant's `agent.type`, a cron job's backend.
 * The app calls it the built-in agent; `bare-<id>` and `agent-<id>` are the backend's ids for its bare assistant and
 * its agent option.
 */
export const BUILTIN_AGENT = 'aionrs';
export type BuiltinAgent = typeof BUILTIN_AGENT;

/** An error code from the backend by the app's name for it: its own errors' codes start `MU_`, the rest stay. */
export function fromBackendCode(code: string): string {
  return code.startsWith(BACKEND_CODE_PREFIX) ? MU_CODE_PREFIX + code.slice(BACKEND_CODE_PREFIX.length) : code;
}

/** An error ownership from the backend by the app's name for it. */
export function fromBackendOwnership(ownership: string): string {
  return ownership === BACKEND_OWN_OWNERSHIP ? 'mu' : ownership;
}
