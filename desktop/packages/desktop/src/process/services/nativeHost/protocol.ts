/**
 * The envelope between the app's main process and a native host process (entry.ts). Inside it travels pi's own RPC
 * protocol, unchanged: each record is its JSON text, one record per message, in both directions.
 *
 * Over an Electron utility process the envelope rides `process.parentPort` (a MessagePort); under Node's
 * `child_process.fork` (tests, scripts) it rides the IPC channel. Both carry these objects as they are.
 *
 * Kept free of imports and of TypeScript that needs compiling, so Node can run the host from its sources.
 */

/**
 * main → host. `init` comes first: pi's module and arguments, and the Node options the launcher planned for the
 * process, which the host applies itself (entry.ts). `in` records wait in the host until pi listens; `end` asks pi to
 * shut down.
 */
export type ToHost =
  | { type: 'init'; module: string; args: string[]; execArgv: string[] }
  | { type: 'in'; json: string }
  | { type: 'end' };

/**
 * host → main. `ready`: pi is imported and `main()` is about to run, `importMs` after the host started. `out`: one of
 * pi's records. `failed`: the host could not import pi or `main()` threw, and exits with code 1.
 */
export type FromHost =
  | { type: 'ready'; importMs: number }
  | { type: 'out'; json: string }
  | { type: 'failed'; stage: 'init' | 'import' | 'main'; message: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((each) => typeof each === 'string');

/** A message from the main process, or undefined when it is not one of `ToHost`. */
export function readToHost(value: unknown): ToHost | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === 'in' && typeof value.json === 'string') return { type: 'in', json: value.json };
  if (value.type === 'end') return { type: 'end' };
  if (value.type === 'init' && typeof value.module === 'string' && isStrings(value.args)) {
    const execArgv = value.execArgv ?? [];
    return isStrings(execArgv) ? { type: 'init', module: value.module, args: value.args, execArgv } : undefined;
  }
  return undefined;
}

/** A message from the host, or undefined when it is not one of `FromHost`. */
export function readFromHost(value: unknown): FromHost | undefined {
  if (!isObject(value)) return undefined;
  if (value.type === 'out' && typeof value.json === 'string') return { type: 'out', json: value.json };
  if (value.type === 'ready')
    return { type: 'ready', importMs: typeof value.importMs === 'number' ? value.importMs : 0 };
  if (
    value.type === 'failed' &&
    (value.stage === 'init' || value.stage === 'import' || value.stage === 'main') &&
    typeof value.message === 'string'
  )
    return { type: 'failed', stage: value.stage, message: value.message };
  return undefined;
}
