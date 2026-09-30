import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { HostChild } from '../../../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';
import type { ToHost } from '../../../../../packages/desktop/src/process/services/nativeHost/protocol.ts';

/** A host process that the test plays: it records what the manager posts, and says what pi would say. */
export class FakeChild extends EventEmitter implements HostChild {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly posted: ToHost[] = [];
  kills = 0;

  postMessage(message: ToHost): void {
    this.posted.push(message);
  }

  kill(): boolean {
    this.kills += 1;
    return true;
  }

  /** pi writes one record. */
  write(record: Record<string, unknown>): void {
    this.emit('message', { type: 'out', json: JSON.stringify(record) });
  }

  /** The process exits; its output ends first, as a real one's does. */
  exit(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code);
  }

  /** The commands the manager sent pi, as pi reads them. */
  commands(): Record<string, unknown>[] {
    return this.posted.flatMap((message) =>
      message.type === 'in' ? [JSON.parse(message.json) as Record<string, unknown>] : []
    );
  }
}

/** Lets the streams and the promises that wait on them move on. */
export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
