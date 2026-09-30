import { fork } from 'node:child_process';
import type { HostChild, HostLaunch } from './NativeHost.ts';

/**
 * Starts a host with Node's `child_process.fork` instead of an Electron utility process: the same entry and envelope,
 * over Node's IPC channel. For tests and scripts, where there is no Electron; `node` is the Node to run it with. The
 * launch's Node options go to the host in its `init` message, as they do for a utility process (entry.ts), so the
 * process starts with none, not with this one's.
 */
export function forkWithNode(entry: string, node: string = process.execPath): (launch: HostLaunch) => HostChild {
  return (launch) => {
    const child = fork(entry, [], {
      execArgv: [],
      execPath: node,
      env: launch.env,
      cwd: launch.cwd,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    // A message sent while the channel closes fails there, not here: the exit says what happened.
    child.on('error', () => undefined);
    return {
      get pid() {
        return child.pid;
      },
      stdout: child.stdout,
      stderr: child.stderr,
      postMessage: (message) => {
        if (child.connected) child.send(message);
      },
      on: (event: 'message' | 'exit', listener: (value: never) => void) =>
        event === 'exit'
          ? child.on('exit', (code) => (listener as (code: number | null) => void)(code))
          : child.on('message', listener as (message: unknown) => void),
      kill: () => child.kill(),
    };
  };
}
