import { describe, expect, it } from 'vitest';
import type { ViewMessage } from '@/common/utils/nativeHost';
import { sameSendBoxMessages, sendBoxMessages } from '@/renderer/pages/native/components/composer/composerModel';

const user = (id: string, text: string): ViewMessage => ({ id, role: 'user', text, images: [], timestamp: 0 });

const reply = (id: string, text: string, streaming: boolean): ViewMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'text', text }],
  timestamp: 0,
  streaming,
});

describe('the send box’s rows of a native conversation', () => {
  it('leaves out a reply still streaming, and takes it once it is complete', () => {
    expect(sendBoxMessages([user('m1', 'hi'), reply('m2', 'Hel', true)], 'c').map((row) => row.id)).toEqual(['m1']);
    expect(sendBoxMessages([user('m1', 'hi'), reply('m2', 'Hello', false)], 'c').map((row) => row.id)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('reads the same while a reply streams, so the send box is not redrawn per token', () => {
    const before = sendBoxMessages([user('m1', 'hi'), reply('m2', 'Hel', true)], 'c');
    const after = sendBoxMessages([user('m1', 'hi'), reply('m2', 'Hello, wor', true)], 'c');
    expect(sameSendBoxMessages(before, after)).toBe(true);
  });

  it('reads differently once the words change', () => {
    const before = sendBoxMessages([user('m1', 'hi')], 'c');
    const after = sendBoxMessages([user('m1', 'hi'), reply('m2', 'Hello', false)], 'c');
    expect(sameSendBoxMessages(before, after)).toBe(false);
  });
});
