import { describe, expect, expectTypeOf, it } from 'vitest';
import type { NativeErrorKind, NativeHostStatus } from '../../../packages/desktop/src/common/kyrn/nativeBridge';
import type {
  NativeHostErrorKind,
  NativeHostState,
} from '../../../packages/desktop/src/process/services/nativeHost/NativeHost.ts';

/**
 * The renderer's failure kinds are the manager's own (`NativeHostErrorKind`) and two the bridge adds. They are kept in
 * step by their types: a kind the manager gains must be named in the bridge, or this file stops compiling.
 */
describe('the native conversation bridge and the host manager', () => {
  it('agree on the failure kinds', () => {
    expectTypeOf<NativeErrorKind>().toEqualTypeOf<NativeHostErrorKind | 'unknown-conversation' | 'invalid'>();
    expect(true).toBe(true);
  });

  it('agree on the phases a host is in', () => {
    expectTypeOf<NativeHostStatus['phase']>().toEqualTypeOf<Exclude<NativeHostState['phase'], 'stopped'>>();
    expect(true).toBe(true);
  });
});
