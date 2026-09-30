/**
 * Every message draws its text in a shadow tree that carries the page's theme. Reading the page's computed style once
 * for each message is what made a long conversation slow to open: each read made the browser bring the page's styles
 * up to date again, and a session of 6,752 entries took 24 seconds. Messages that mount together share one read, a
 * message that mounts later reads again, and a change of the page's theme still reaches every message on screen.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ShadowView from '@/renderer/components/Markdown/ShadowView';

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      requestCurrent: { invoke: () => Promise.resolve(null) },
      changed: { on: () => () => {} },
    },
  },
}));

let background = '#ffffff';
const reads = () =>
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    () =>
      ({
        getPropertyValue: (name: string) => (name === '--bg-1' ? background : ''),
      }) as unknown as CSSStyleDeclaration
  );

const Messages: React.FC<{ count: number; from?: number }> = ({ count, from = 0 }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <ShadowView key={from + index}>
        <p>message {from + index}</p>
      </ShadowView>
    ))}
  </>
);

const roots = (): ShadowRoot[] =>
  [...document.querySelectorAll<HTMLElement>('.markdown-shadow')].map((element) => element.shadowRoot as ShadowRoot);
const hostRule = (root: ShadowRoot): string => root.querySelector('style')?.innerHTML ?? '';
const pageReads = (spy: ReturnType<typeof reads>) =>
  spy.mock.calls.filter(([element]) => element === document.documentElement).length;
const settle = () => act(async () => {});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
  background = '#ffffff';
});

describe('the shadow view and the page theme', () => {
  it('reads the page once for the messages that mount together, and each carries what was read', async () => {
    const spy = reads();
    await act(async () => {
      render(<Messages count={60} />);
    });
    await settle();

    expect(roots()).toHaveLength(60);
    for (const root of roots()) expect(hostRule(root)).toContain('--bg-1: #ffffff;');
    // One read a message, twice over (when it mounts, and when its shadow root is set), was 120.
    expect(pageReads(spy)).toBeLessThanOrEqual(2);
  });

  it('reads the page again for a message that mounts in a later task', async () => {
    reads();
    await act(async () => {
      render(<Messages count={1} />);
    });
    await settle();
    background = '#eeeeee';
    await act(async () => {
      render(<Messages count={2} />);
    });
    await settle();

    const [first, second] = roots();
    expect(hostRule(first)).toContain('--bg-1: #ffffff;');
    expect(hostRule(second)).toContain('--bg-1: #eeeeee;');
  });

  it('carries a change of the page theme to every message with one read', async () => {
    const spy = reads();
    await act(async () => {
      render(<Messages count={30} />);
    });
    await settle();
    spy.mockClear();

    background = '#000000';
    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    for (const root of roots()) {
      expect(hostRule(root)).toContain('--bg-1: #000000;');
      expect(root.querySelectorAll('style')).toHaveLength(1);
    }
    expect(pageReads(spy)).toBe(1);
  });

  it('stops watching the page when the last message is gone', async () => {
    const spy = reads();
    await act(async () => {
      render(<Messages count={3} />);
    });
    await settle();
    cleanup();
    spy.mockClear();

    document.documentElement.setAttribute('data-theme', 'dark');
    await settle();

    expect(pageReads(spy)).toBe(0);
  });
});
