import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import WebviewHost, {
  type WebviewNavigation,
  type WebviewNavigationState,
} from '@/renderer/components/media/WebviewHost';

const { report } = vi.hoisted(() => ({ report: vi.fn(async () => ({ success: true })) }));
vi.mock('@/common', () => ({
  ipcBridge: { application: { reportBrowserWebContentsId: { invoke: report } } },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** jsdom knows no `<webview>`: give the element the few methods WebviewHost calls when the page is ready. */
async function ready(container: HTMLElement) {
  const view = container.querySelector('webview') as HTMLElement & Record<string, unknown>;
  const scripts: string[] = [];
  view.executeJavaScript = vi.fn(async (script: string) => {
    scripts.push(script);
    return true;
  });
  view.getWebContentsId = () => 7;
  view.loadURL = vi.fn(async () => undefined);
  view.canGoBack = () => false;
  view.canGoForward = () => false;
  view.setZoomFactor = () => undefined;
  await act(async () => {
    view.dispatchEvent(new Event('dom-ready'));
  });
  return { view, scripts };
}

describe('the two seams agent tabs need in the shared webview host', () => {
  it('by default intercepts links and forms, and reports the page to the single-target bridge', async () => {
    const { container } = render(<WebviewHost url='https://example.com/' />);
    const { scripts } = await ready(container);
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(true);
    expect(report).toHaveBeenCalledWith({ webContentsId: 7 });
  });

  it('leaves a pristine page its own links and forms, and hands the webContents to the caller instead', async () => {
    const onReady = vi.fn();
    const { container } = render(<WebviewHost url='https://example.com/' pristine onWebContentsReady={onReady} />);
    const { view, scripts } = await ready(container);
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(false);
    expect(scripts.some((script) => script.includes("addEventListener('submit'"))).toBe(false);
    expect(onReady).toHaveBeenCalledWith(7, view);
    expect(report).not.toHaveBeenCalled();
  });
});

describe('the seam for an owner that draws the navigation itself (the in-app browser)', () => {
  it('draws its own bar when asked and nobody else draws one', () => {
    const { container } = render(<WebviewHost url='https://example.com/' showNavBar />);
    expect(container.querySelector('.mu-url-viewer-toolbar')).not.toBeNull();
  });

  it('draws no bar, never hides the page while it loads, and tells the owner where the page is and what it can do', async () => {
    const states: WebviewNavigationState[] = [];
    const { container } = render(
      <WebviewHost url='https://example.com/' showNavBar onNavigationChange={(state) => states.push(state)} />
    );
    expect(container.querySelector('.mu-url-viewer-toolbar')).toBeNull();
    expect((container.querySelector('webview') as HTMLElement).style.opacity).toBe('1');
    expect(states.at(-1)).toEqual({
      url: 'https://example.com/',
      canGoBack: false,
      canGoForward: false,
      loading: true,
    });

    const { view } = await ready(container);
    await act(async () => {
      view.dispatchEvent(new Event('did-stop-loading'));
    });
    expect(states.at(-1)).toMatchObject({ loading: false });

    view.canGoBack = () => true;
    await act(async () => {
      view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/next' }));
    });
    expect(states.at(-1)).toEqual({
      url: 'https://example.com/next',
      canGoBack: true,
      canGoForward: false,
      loading: false,
    });
  });

  it('goes back, forward, reloads and goes to an address when the owner’s controls say so', async () => {
    const navigation = React.createRef<WebviewNavigation>();
    const { container } = render(
      <WebviewHost url='https://example.com/' onNavigationChange={() => {}} navigationRef={navigation} />
    );
    const { view } = await ready(container);
    const calls: string[] = [];
    view.goBack = () => calls.push('back');
    view.goForward = () => calls.push('forward');
    view.reload = () => calls.push('reload');

    // Nothing behind or ahead yet: the controls do nothing.
    act(() => navigation.current?.back());
    act(() => navigation.current?.forward());
    expect(calls).toEqual([]);

    view.canGoBack = () => true;
    view.canGoForward = () => true;
    act(() => navigation.current?.back());
    act(() => navigation.current?.forward());
    act(() => navigation.current?.reload());
    // The page's own address again reloads it.
    act(() => navigation.current?.go('https://example.com/'));
    expect(calls).toEqual(['back', 'forward', 'reload', 'reload']);

    act(() => navigation.current?.go('https://other.test/'));
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(view.loadURL).toHaveBeenCalledWith('https://other.test/');
  });
});

// Electron loads whatever a webview's src is set to, even the address the page is already on. The page's own
// address written back to src reloaded it after every redirect, every route change of a single-page app, and every
// form it submitted (as a GET, losing a POST's result).
describe('where the page goes, and where it is sent', () => {
  it('follows the page where it goes by itself without loading it again', async () => {
    const states: WebviewNavigationState[] = [];
    const { container } = render(
      <WebviewHost url='https://example.com/' onNavigationChange={(state) => states.push(state)} />
    );
    const { view } = await ready(container);
    // A link or a redirect, then a route change inside a single-page app.
    await act(async () => {
      view.dispatchEvent(Object.assign(new Event('did-navigate'), { url: 'https://example.com/next' }));
    });
    expect(states.at(-1)?.url).toBe('https://example.com/next');
    await act(async () => {
      view.dispatchEvent(Object.assign(new Event('did-navigate-in-page'), { url: 'https://example.com/next/route' }));
    });
    expect(states.at(-1)?.url).toBe('https://example.com/next/route');
    expect(view.getAttribute('src')).toBe('https://example.com/');
    expect(view.loadURL).not.toHaveBeenCalled();
  });

  it('goes to an address asked for once, by loadURL, with src left alone', async () => {
    const navigation = React.createRef<WebviewNavigation>();
    const { container } = render(
      <WebviewHost url='https://example.com/' onNavigationChange={() => {}} navigationRef={navigation} />
    );
    const { view } = await ready(container);
    act(() => navigation.current?.go('https://other.test/'));
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(view.getAttribute('src')).toBe('https://example.com/');
  });

  it('loads an address its owner gives once: through src before the page is ready, by loadURL after', async () => {
    const { container, rerender } = render(<WebviewHost url='https://example.com/' />);
    rerender(<WebviewHost url='https://first.test/' />);
    expect(container.querySelector('webview')?.getAttribute('src')).toBe('https://first.test/');
    const { view } = await ready(container);
    rerender(<WebviewHost url='https://second.test/' />);
    expect(view.loadURL).toHaveBeenCalledTimes(1);
    expect(view.loadURL).toHaveBeenCalledWith('https://second.test/');
    expect(view.getAttribute('src')).toBe('https://first.test/');
  });
});
