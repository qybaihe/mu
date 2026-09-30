import { asObject, asText, type JsonObject } from './records.ts';

/**
 * The status key the judgment layer's presentation frames ride on in pi's RPC stream: `runtime.present()` in the
 * harness sends each one as `setStatus(PRESENTATION_STATUS_KEY, JSON)` (packages/kyrn-judge/src/extension/presentation.ts).
 */
export const PRESENTATION_STATUS_KEY = 'kyrn.presentation.v1';

/** Which judgment runtime and turn a frame belongs to, and its place in that runtime's sequence: all three, or none. */
export type FrameCorrelation = { runtimeId: string; turnId: number; sequence: number };

/** One presentation frame: what the judgment layer shows, never what it hides (decisions, verdicts, progress). */
export type PresentationFrame = {
  /** 1 for every frame the judgment layer sends today; a reader that knows only version 1 checks it. */
  version: unknown;
  kind: string;
  payload: JsonObject;
  /** When it was presented, in milliseconds since the epoch. */
  at?: number;
  correlation?: FrameCorrelation;
};

/**
 * The presentation frame a record of pi's RPC stream carries, or undefined for any other record, or for a frame that
 * does not parse or names no kind. The CLI bridge's telemetry (process/agent/kyrn/telemetry.ts), its permission
 * reader and the native host's reducer read frames through this one function.
 */
export function readPresentation(record: unknown): PresentationFrame | undefined {
  const event = asObject(record);
  if (
    event.type !== 'extension_ui_request' ||
    event.method !== 'setStatus' ||
    event.statusKey !== PRESENTATION_STATUS_KEY
  )
    return undefined;
  let frame: JsonObject;
  try {
    frame = asObject(JSON.parse(asText(event.statusText)));
  } catch {
    return undefined;
  }
  if (typeof frame.kind !== 'string') return undefined;
  const { runtimeId, turnId, sequence } = frame;
  const correlation =
    typeof runtimeId === 'string' &&
    runtimeId &&
    typeof turnId === 'number' &&
    Number.isSafeInteger(turnId) &&
    turnId >= 0 &&
    typeof sequence === 'number' &&
    Number.isSafeInteger(sequence) &&
    sequence > 0
      ? { runtimeId, turnId, sequence }
      : undefined;
  return {
    version: frame.version,
    kind: frame.kind,
    payload: asObject(frame.payload),
    ...(typeof frame.at === 'number' ? { at: frame.at } : {}),
    ...(correlation ? { correlation } : {}),
  };
}
