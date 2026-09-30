/**
 * What the line above a native conversation's send box says about the run, from the view alone: pi's events and the
 * judgment layer's frames say how it stands, so nothing is guessed from time. One state at a time, the one the person
 * most needs to know: a compaction or a retry holds the run up, Jev classifies before the run starts, and the model
 * thinks or works while it goes. Once a run is over, how it ended.
 */
import type { JsonObject, NativeView } from '@/common/utils/nativeHost';

export type StatusRow =
  /** Nothing ran yet. */
  | { kind: 'idle' }
  /** Jev classifies the message before the run starts; `judge` is the judge asked (`jev-latest`, `laya`, …). */
  | { kind: 'classifying'; judge: string }
  | { kind: 'compacting' }
  /** A request failed and pi tries again after `delayMs`: this is attempt `attempt` of `maxAttempts`. */
  | { kind: 'retrying'; attempt: number; maxAttempts: number; delayMs: number; error: string }
  | { kind: 'thinking' }
  /** The run goes; `step` is what the judgment layer says it works out, with its code and params when it has one. */
  | { kind: 'working'; step?: string; code?: string; params?: JsonObject }
  | { kind: 'settled' }
  | { kind: 'aborted' }
  | { kind: 'error'; error: string };

export function statusRow(view: NativeView): StatusRow {
  const { live } = view;
  if (live.compacting) return { kind: 'compacting' };
  if (live.retry) return { kind: 'retrying', ...live.retry };
  if (live.classifying) return { kind: 'classifying', judge: live.classifying.judge };
  switch (view.status) {
    case 'thinking':
      return { kind: 'thinking' };
    case 'working': {
      const progress = live.progress;
      if (!progress?.step) return { kind: 'working' };
      return {
        kind: 'working',
        step: progress.step,
        ...(progress.code ? { code: progress.code } : {}),
        ...(progress.params ? { params: progress.params } : {}),
      };
    }
    case 'error':
      return { kind: 'error', error: view.error ?? '' };
    case 'settled':
    case 'aborted':
      return { kind: view.status };
    default:
      return { kind: 'idle' };
  }
}

/** Whether a run goes: the send box then steers or queues, and offers to stop. */
export const isWorking = (view: NativeView): boolean => view.status === 'working' || view.status === 'thinking';
