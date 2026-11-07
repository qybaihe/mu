import { inspect } from 'node:util';

/**
 * The adapter's error output: the backend logs it (each line under "CLI process stderr" in the app's log folder). It is a
 * log, nothing more: writing to it never throws and never ends the adapter.
 */

let guarded = false;

/**
 * Writes to the adapter's error output. The backend stops reading that output at the first line that is not UTF-8 and
 * closes it, and a write after that fails (EPIPE) with an error event that, unheard, would end the adapter.
 */
export function log(line: string): void {
  try {
    if (!guarded) {
      // A listener for good. console.error's goes away after one error, and a stream piped into this one (tsx pipes
      // one in) passes on an error when no other listener is left.
      process.stderr.on('error', () => {});
      guarded = true;
    }
    process.stderr.write(line);
  } catch {
    // Nowhere to log to.
  }
}

/** An error as the log shows it: its stack when it has one. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  return inspect(error, { depth: 4, breakLength: Number.POSITIVE_INFINITY });
}

/**
 * What the adapter does with an error nothing caught. A promise that failed with nothing to handle it is logged, and the
 * adapter goes on: Node would end it for that, and with it every conversation it serves. An exception nothing caught is
 * logged with its stack, and the adapter exits with code 1 as Node would, since its state can no longer be trusted; the
 * log now says why.
 */
export function logUncaught(target: NodeJS.Process = process): void {
  target.on('unhandledRejection', (reason) => {
    log(`[mu] a promise failed and nothing handled it; the adapter goes on: ${describeError(reason)}\n`);
  });
  target.on('uncaughtException', (error) => {
    log(`[mu] the adapter stops on an error nothing handled: ${describeError(error)}\n`);
    target.exit(1);
  });
}
