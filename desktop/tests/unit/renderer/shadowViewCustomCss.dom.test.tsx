/**
 * The person's own CSS reaches every message's shadow tree. A conversation mounts a window of messages at once, and
 * each used to ask the main process for that CSS on its own and listen for its changes on its own: one request and one
 * listener are enough for all of them, and a change still reaches every message on screen.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => {
  const listeners = new Set<(theme: { css?: string }) => void>();
  return {
    listeners,
    requestCurrent: vi.fn(() => Promise.resolve({ css: '.mine { color: red; }' })),
    on: vi.fn((listener: (theme: { css?: string }) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      requestCurrent: { invoke: bridge.requestCurrent },
      changed: { on: bridge.on },
    },
  },
}));

import ShadowView from '@/renderer/components/Markdown/ShadowView';

const Messages: React.FC<{ count: number }> = ({ count }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <ShadowView key={index}>
        <p>message {index}</p>
      </ShadowView>
    ))}
  </>
);

const styles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('.markdown-shadow')].map(
    (element) => element.shadowRoot?.querySelector('style')?.innerHTML ?? ''
  );

afterEach(() => {
  cleanup();
  bridge.requestCurrent.mockClear();
  bridge.on.mockClear();
});

describe('the person’s own CSS in the messages', () => {
  it('is asked for once for all the messages that mount, and reaches each of them', async () => {
    await act(async () => {
      render(<Messages count={30} />);
    });
    expect(bridge.requestCurrent).toHaveBeenCalledTimes(1);
    expect(bridge.on).toHaveBeenCalledTimes(1);
    for (const style of styles()) expect(style).toContain('.mine');
  });

  it('carries a change to every message on screen', async () => {
    await act(async () => {
      render(<Messages count={5} />);
    });
    await act(async () => {
      for (const listener of bridge.listeners) listener({ css: '.theirs { color: blue; }' });
    });
    for (const style of styles()) {
      expect(style).toContain('.theirs');
      expect(style).not.toContain('.mine');
    }
  });

  it('stops listening once no message is on screen, and asks again for the next', async () => {
    await act(async () => {
      render(<Messages count={2} />);
    });
    cleanup();
    expect(bridge.listeners.size).toBe(0);
    await act(async () => {
      render(<Messages count={1} />);
    });
    expect(bridge.requestCurrent).toHaveBeenCalledTimes(2);
  });
});
