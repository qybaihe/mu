/**
 * Why a native call failed, as the screens say it: one sentence per kind of failure, in the reader's language. The
 * failure's own message (plain English, from the main process or pi) goes under it as a detail.
 */
import type { NativeErrorKind } from '@/common/kyrn/nativeBridge';

const KEYS: Record<NativeErrorKind, string> = {
  off: 'mu.native.error.off',
  'no-harness': 'mu.native.error.noHarness',
  'old-harness': 'mu.native.error.oldHarness',
  plan: 'mu.native.error.plan',
  'no-models': 'mu.native.error.noModels',
  failed: 'mu.native.error.failed',
  crashed: 'mu.native.error.crashed',
  closed: 'mu.native.error.closed',
  timeout: 'mu.native.error.timeout',
  command: 'mu.native.error.command',
  'no-folder': 'mu.native.error.noFolder',
  'unknown-conversation': 'mu.native.error.unknownConversation',
  invalid: 'mu.native.error.invalid',
};

/** The i18n key of the sentence for a kind; a kind this build does not know reads as a failed host. */
export const errorKey = (kind: NativeErrorKind): string => KEYS[kind] ?? KEYS.failed;
