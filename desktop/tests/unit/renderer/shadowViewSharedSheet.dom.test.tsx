/**
 * Where the browser takes constructed stylesheets, the messages on screen share one base sheet instead of each parsing
 * its own `<style>`. jsdom has no `adoptedStyleSheets`, so it is given one here before the view loads.
 */
import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const adopted = vi.hoisted(() => {
  const sheets = new WeakMap<ShadowRoot, CSSStyleSheet[]>();
  Object.defineProperty(ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get(this: ShadowRoot) {
      return sheets.get(this) ?? [];
    },
    set(this: ShadowRoot, value: CSSStyleSheet[]) {
      sheets.set(this, value);
    },
  });
  return { parses: 0 };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      requestCurrent: { invoke: () => Promise.resolve(null) },
      changed: { on: () => () => {} },
    },
  },
}));

import ShadowView from '@/renderer/components/Markdown/ShadowView';

const realReplaceSync = CSSStyleSheet.prototype.replaceSync;
CSSStyleSheet.prototype.replaceSync = function (this: CSSStyleSheet, text: string) {
  adopted.parses += 1;
  return realReplaceSync.call(this, text);
};

const Messages: React.FC<{ count: number }> = ({ count }) => (
  <>
    {Array.from({ length: count }, (_, index) => (
      <ShadowView key={index}>
        <p>message {index}</p>
      </ShadowView>
    ))}
  </>
);

const roots = (): ShadowRoot[] =>
  [...document.querySelectorAll<HTMLElement>('.markdown-shadow')].map((element) => element.shadowRoot as ShadowRoot);

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
});

describe('the messages’ base style, shared', () => {
  it('is one sheet for every message that mounts, parsed once, with no style element of its own', async () => {
    adopted.parses = 0;
    await act(async () => {
      render(<Messages count={40} />);
    });
    const all = roots();
    expect(all).toHaveLength(40);
    const first = all[0].adoptedStyleSheets[0];
    expect(first).toBeInstanceOf(CSSStyleSheet);
    for (const root of all) {
      expect(root.adoptedStyleSheets[0]).toBe(first);
      expect(root.querySelector('style')).toBeNull();
    }
    expect(adopted.parses).toBe(1);
  });

  it('moves every message to one new sheet when the page’s theme changes', async () => {
    await act(async () => {
      render(<Messages count={10} />);
    });
    const before = roots()[0].adoptedStyleSheets[0];
    adopted.parses = 0;
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    const after = roots()[0].adoptedStyleSheets[0];
    expect(after).not.toBe(before);
    for (const root of roots()) expect(root.adoptedStyleSheets.filter((sheet) => sheet === after)).toHaveLength(1);
    expect(adopted.parses).toBe(1);
  });
});
