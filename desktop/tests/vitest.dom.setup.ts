/**
 * Vitest DOM Test Setup
 * Configuration for React component and hook tests using jsdom
 */

import '@testing-library/jest-dom/vitest';

// Make this a module

// Extend global types for testing
interface ElectronAPI {
  emit: () => Promise<void>;
  on: () => void;
  windowControls: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    unmaximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    onMaximizedChange: () => () => void;
  };
}

declare global {
  // eslint-disable-next-line no-var
  var electronAPI: ElectronAPI;
}

const noop = () => Promise.resolve();

// Mock Electron APIs for testing
const windowControlsMock = {
  minimize: noop,
  maximize: noop,
  unmaximize: noop,
  close: noop,
  isMaximized: () => Promise.resolve(false),
  onMaximizedChange: (): (() => void) => () => void 0,
};

global.electronAPI = {
  emit: noop,
  on: () => {},
  windowControls: windowControlsMock,
};

if (typeof window !== 'undefined') {
  (window as unknown as { electronAPI: ElectronAPI }).electronAPI = global.electronAPI;
}

// Mock ResizeObserver for Virtuoso
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.ResizeObserver = ResizeObserverMock;

// Mock IntersectionObserver
class IntersectionObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

global.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

// A WebSocket that never dials. The renderer's realtime channel (common/adapter/httpBridge.ts, ensureWs) opens its socket
// as soon as a component subscribes to it, and jsdom's own WebSocket really connects to ws://localhost:3000/ws. Nothing
// listens there: the attempt fails, the channel logs "[ensureWs] ERROR" and "CLOSED code=1006" and arms a timer that
// dials again after 1 s, 2 s, 4 s, ... When that failure came while the worker was finishing a file, its log was still
// on its way to vitest, and vitest failed the run with "EnvironmentTeardownError: Closing rpc while "onUserConsoleLog"
// was pending" although every test had passed. This socket stays CONNECTING and fires no event, so nothing is logged or
// scheduled after a test. A test of the channel itself installs its own fake with vi.stubGlobal; unstubbing brings
// back this one.
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readonly url: string;
  readyState: number = InertWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }

  send(): void {
    throw new DOMException('The WebSocket is still connecting.', 'InvalidStateError');
  }

  close(): void {
    this.readyState = InertWebSocket.CLOSED;
  }
}

global.WebSocket = InertWebSocket as unknown as typeof WebSocket;

// Mock requestAnimationFrame
global.requestAnimationFrame = (callback: FrameRequestCallback) => {
  return setTimeout(() => callback(Date.now()), 0) as unknown as number;
};

global.cancelAnimationFrame = (id: number) => {
  clearTimeout(id);
};

// Mock scrollTo
Element.prototype.scrollTo = () => {};
Element.prototype.scrollIntoView = () => {};

// Mock localStorage (not always available in jsdom)
if (typeof globalThis.localStorage === 'undefined' || typeof globalThis.localStorage?.clear !== 'function') {
  const store = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
  };
  Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', { value: localStorageMock, writable: true });
  }
}
