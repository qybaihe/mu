import type { IRuntimeStatusEvent, IRuntimeStatusScope } from './ipcBridge';

/**
 * Whether the person put the Node.js runtime download off at this start (the question in
 * process/startup/nodeRuntimeConsent.ts). The backend then runs without fetching it. The preload says so; the main
 * process and a plain browser have no such flag.
 */
export function isNodeRuntimeDeferred(): boolean {
  return typeof window !== 'undefined' && window.__nodeRuntimeDeferred === true;
}

/**
 * With the download put off, the backend reports the runtime as a missing bundled resource wherever it is needed. That
 * is expected, not a damaged installation: it gets a one-line note there, not the reinstall dialog.
 */
export function isDeferredRuntimeFailure(
  event: IRuntimeStatusEvent,
  deferred: boolean = isNodeRuntimeDeferred()
): boolean {
  return deferred && event.phase === 'failed' && event.failure_kind === 'bundled_resource_missing';
}

/** The backend checks the runtime once as it starts, under this scope: nothing waits for it there. */
export function isStartupRuntimeScope(scope: IRuntimeStatusScope): boolean {
  return scope.kind === 'custom_agent' && scope.id === 'startup';
}

export type RuntimeStatusEmitter = {
  on: (callback: (event: IRuntimeStatusEvent) => void) => () => void;
  emit: (event: IRuntimeStatusEvent) => void;
};

/** The backend's runtime events in two streams: the failures a put-off download explains, and everything else. */
export function splitDeferredRuntimeFailures(source: RuntimeStatusEmitter): {
  statusChanged: RuntimeStatusEmitter;
  deferredFailure: RuntimeStatusEmitter;
} {
  const only = (keep: (event: IRuntimeStatusEvent) => boolean): RuntimeStatusEmitter => ({
    on: (callback) =>
      source.on((event) => {
        if (keep(event)) callback(event);
      }),
    emit: source.emit,
  });
  return {
    statusChanged: only((event) => !isDeferredRuntimeFailure(event)),
    deferredFailure: only((event) => isDeferredRuntimeFailure(event)),
  };
}
