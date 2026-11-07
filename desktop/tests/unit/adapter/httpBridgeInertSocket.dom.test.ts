/**
 * The dom tests' WebSocket (tests/vitest.dom.setup.ts) never dials. The realtime channel opens its socket as soon as a
 * component subscribes to it. With jsdom's own WebSocket that socket failed against ws://localhost:3000/ws and the
 * channel logged the failure, sometimes after the file's last test had ended; vitest then failed CI with
 * "EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending" (runs 39813050224, 39830935502).
 */

import { afterEach, expect, it, vi } from 'vitest';
import { wsEmitter } from '@/common/adapter/httpBridge';

afterEach(() => {
  vi.restoreAllMocks();
});

it('subscribing to the realtime channel opens a socket that never fails, logs or dials again', async () => {
  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  const off = wsEmitter('probe').on(() => {});
  // A refused connection failed within milliseconds here, and the channel then dialled again after 1 s.
  await new Promise((resolve) => setTimeout(resolve, 200));
  off();

  expect(error).not.toHaveBeenCalled();
  expect(debug.mock.calls.map(([message]) => message)).toEqual(['[ensureWs] connecting to']);
});
