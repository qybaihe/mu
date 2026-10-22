import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IRuntimeStatusEvent } from '@/common/adapter/ipcBridge';
import {
  isDeferredRuntimeFailure,
  isNodeRuntimeDeferred,
  splitDeferredRuntimeFailures,
  type RuntimeStatusEmitter,
} from '@/common/adapter/nodeRuntimeDeferral';
import { createDeferredRuntimeNeeds } from '@/renderer/services/runtime/deferredNodeRuntime';

const missing = (kind: IRuntimeStatusEvent['scope']['kind'], id: string): IRuntimeStatusEvent => ({
  resource: 'node',
  scope: { kind, id },
  phase: 'failed',
  failure_kind: 'bundled_resource_missing',
});

function fakeSource() {
  const listeners = new Set<(event: IRuntimeStatusEvent) => void>();
  const source: RuntimeStatusEmitter = {
    on: (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    emit: () => {},
  };
  return { source, send: (event: IRuntimeStatusEvent) => listeners.forEach((listener) => listener(event)) };
}

describe('a Node.js download put off at this start', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is known from the preload flag only', () => {
    expect(isNodeRuntimeDeferred()).toBe(false);
    vi.stubGlobal('window', {});
    expect(isNodeRuntimeDeferred()).toBe(false);
    vi.stubGlobal('window', { __nodeRuntimeDeferred: true });
    expect(isNodeRuntimeDeferred()).toBe(true);
  });

  it('explains a missing bundled runtime, nothing else', () => {
    expect(isDeferredRuntimeFailure(missing('conversation', 'c1'), true)).toBe(true);
    expect(isDeferredRuntimeFailure(missing('conversation', 'c1'), false)).toBe(false);
    expect(
      isDeferredRuntimeFailure({ ...missing('conversation', 'c1'), failure_kind: 'bundled_resource_invalid' }, true)
    ).toBe(false);
    expect(
      isDeferredRuntimeFailure({ ...missing('conversation', 'c1'), phase: 'ready', failure_kind: undefined }, true)
    ).toBe(false);
  });

  it('keeps those failures from the damaged-installation listener and hands them to the notes', () => {
    vi.stubGlobal('window', { __nodeRuntimeDeferred: true });
    const { source, send } = fakeSource();
    const split = splitDeferredRuntimeFailures(source);
    const status = vi.fn();
    const deferred = vi.fn();
    const offStatus = split.statusChanged.on(status);
    split.deferredFailure.on(deferred);

    const ready: IRuntimeStatusEvent = { resource: 'node', scope: { kind: 'conversation', id: 'c1' }, phase: 'ready' };
    send(missing('conversation', 'c1'));
    send(ready);

    expect(deferred).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveBeenCalledWith(missing('conversation', 'c1'));
    expect(status).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledWith(ready);

    offStatus();
    send(ready);
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('passes every event on as before when nothing was put off', () => {
    const { source, send } = fakeSource();
    const split = splitDeferredRuntimeFailures(source);
    const status = vi.fn();
    const deferred = vi.fn();
    split.statusChanged.on(status);
    split.deferredFailure.on(deferred);

    send(missing('conversation', 'c1'));

    expect(status).toHaveBeenCalledWith(missing('conversation', 'c1'));
    expect(deferred).not.toHaveBeenCalled();
  });
});

describe('where the put-off runtime was needed', () => {
  it('is kept once per place and told to the listeners', () => {
    const needs = createDeferredRuntimeNeeds();
    const listener = vi.fn();
    const off = needs.subscribe(listener);

    expect(needs.record({ kind: 'conversation', id: 'c1' })).toBe(false);
    expect(needs.record({ kind: 'conversation', id: 'c1' })).toBe(false);
    expect(needs.neededBy('c1')).toBe(true);
    expect(needs.neededBy('c2')).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    needs.record({ kind: 'conversation', id: 'c2' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('announces the first place outside a conversation, once', () => {
    const needs = createDeferredRuntimeNeeds();
    expect(needs.record({ kind: 'mcp', id: 'fetch' })).toBe(true);
    expect(needs.record({ kind: 'mcp', id: 'fetch' })).toBe(false);
    expect(needs.record({ kind: 'custom_agent', id: 'writer' })).toBe(false);
  });

  it('ignores the check the backend makes as it starts', () => {
    const needs = createDeferredRuntimeNeeds();
    const listener = vi.fn();
    needs.subscribe(listener);
    expect(needs.record({ kind: 'custom_agent', id: 'startup' })).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    expect(needs.record({ kind: 'mcp', id: 'fetch' })).toBe(true);
  });
});
