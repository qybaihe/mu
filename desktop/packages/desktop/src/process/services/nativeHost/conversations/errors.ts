/**
 * A request the native conversations refuse before any host is involved: an id they do not know
 * (`unknown-conversation`), or something the screen should never send (`invalid`). The host's own failures are
 * NativeHostError (NativeHost.ts); the bridge maps both onto the renderer's kinds (common/kyrn/nativeBridge.ts).
 */
export type NativeRequestErrorKind = 'unknown-conversation' | 'invalid';

export class NativeRequestError extends Error {
  readonly kind: NativeRequestErrorKind;
  constructor(kind: NativeRequestErrorKind, message: string) {
    super(message);
    this.name = 'NativeRequestError';
    this.kind = kind;
  }
}
