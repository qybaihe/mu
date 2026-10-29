/**
 * The browser's element picker as the page runs it: the outline follows the pointer, the click picks without reaching
 * the page, ↑ and ↓ widen and narrow, Escape and the host call it off, and the page is left as it was. Then what the
 * host makes of the answer: only the expected fields, in bounds, said for the message, and the picture as a file.
 * jsdom does no layout: `elementFromPoint` is the test's, and every box is empty.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCEL_PICK_SCRIPT,
  describePickedElement,
  pageSide,
  pickElementScript,
  pictureFile,
  PICKED_HTML_LIMIT,
  readPickedElement,
  type PickedElement,
} from '@/renderer/components/media/elementPicker';

const OPTIONS = {
  hint: 'Click an element',
  htmlLimit: PICKED_HTML_LIMIT,
  textLimit: 300,
  styles: ['display', 'color'],
};

let under: Element | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  document.title = 'Shop';
  document.body.innerHTML = `
    <main>
      <section class="hero">
        <button class="primary big" type="button">Get started</button>
        <button class="primary" type="button">Later</button>
      </section>
      <ul><li>One</li><li>Two</li></ul>
      <div id="cart"><span>3 items</span></div>
    </main>
    <footer><span>Help</span></footer>`;
  under = null;
  document.elementFromPoint = () => under;
});
afterEach(() => {
  delete (window as { __muPicker?: unknown }).__muPicker;
  vi.useRealTimers();
});

const pointAt = (element: Element) => {
  under = element;
  window.dispatchEvent(new MouseEvent('mousemove', { clientX: 5, clientY: 5 }));
};
const click = () =>
  window.dispatchEvent(new MouseEvent('click', { clientX: 5, clientY: 5, button: 0, cancelable: true }));
const key = (name: string) => window.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
/** The picker answers once the page has painted without its outline, or a moment later. */
const answer = async (picked: Promise<unknown>) => {
  await vi.advanceTimersByTimeAsync(300);
  return picked as Promise<Record<string, unknown> | null>;
};
const layer = () => document.documentElement.lastElementChild;

describe('the picker on the page', () => {
  it('outlines what the pointer is over, with the hint, and answers with the element clicked', async () => {
    const heard = vi.fn();
    const button = document.querySelector('button')!;
    button.addEventListener('click', heard);
    const picked = pageSide(OPTIONS);
    expect(layer()?.textContent).toContain('Click an element');

    pointAt(button);
    expect(button.style.getPropertyValue('cursor')).toBe('crosshair');
    expect(layer()?.textContent).toContain('button.primary');
    click();

    const result = await answer(picked);
    expect(heard).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      url: location.href,
      title: 'Shop',
      label: 'button.primary',
      selector: 'button.primary.big',
      text: 'Get started',
    });
    expect(result?.html).toBe('<button class="primary big" type="button">Get started</button>');
    expect(document.querySelectorAll(String(result?.selector))).toHaveLength(1);
    // The page as it was: no outline, no crosshair, no style attribute it did not have.
    expect(document.documentElement.lastElementChild).toBe(document.body);
    expect(button.hasAttribute('style')).toBe(false);
    expect((window as { __muPicker?: unknown }).__muPicker).toBeUndefined();
  });

  it('finds an element by the shortest way that finds it alone: its place among its kind, its parents, an id', async () => {
    let picked = pageSide(OPTIONS);
    pointAt(document.querySelectorAll('li')[1]);
    click();
    expect((await answer(picked))?.selector).toBe('li:nth-of-type(2)');

    picked = pageSide(OPTIONS);
    pointAt(document.querySelectorAll('button')[1]);
    click();
    expect((await answer(picked))?.selector).toBe('button.primary:nth-of-type(2)');

    picked = pageSide(OPTIONS);
    pointAt(document.querySelector('footer span')!);
    click();
    expect((await answer(picked))?.selector).toBe('footer > span');

    picked = pageSide(OPTIONS);
    pointAt(document.querySelector('#cart span')!);
    click();
    expect((await answer(picked))?.selector).toBe('#cart > span');
  });

  it('widens to the parent with ↑ and back with ↓, and Enter takes the outlined one', async () => {
    const picked = pageSide(OPTIONS);
    pointAt(document.querySelector('#cart span')!);
    key('ArrowUp');
    key('ArrowUp');
    key('ArrowDown');
    key('Enter');
    expect((await answer(picked))?.selector).toBe('#cart');
  });

  it('a click after ↑ takes the widened element, not the one under the pointer', async () => {
    const picked = pageSide(OPTIONS);
    pointAt(document.querySelector('li')!);
    key('ArrowUp');
    click();
    expect((await answer(picked))?.selector).toBe('ul');
  });

  it('answers nothing on Escape, on the host calling it off, or when the page goes away', async () => {
    let picked = pageSide(OPTIONS);
    pointAt(document.querySelector('button')!);
    key('Escape');
    expect(await answer(picked)).toBeNull();
    expect(document.querySelector('button')!.hasAttribute('style')).toBe(false);

    picked = pageSide(OPTIONS);
    // The host's script, run in the page.
    new Function(CANCEL_PICK_SCRIPT)();
    expect(await answer(picked)).toBeNull();

    picked = pageSide(OPTIONS);
    window.dispatchEvent(new Event('pagehide'));
    expect(await answer(picked)).toBeNull();
    expect(document.documentElement.lastElementChild).toBe(document.body);
  });

  it('a second picker calls off the first', async () => {
    const first = pageSide(OPTIONS);
    const second = pageSide(OPTIONS);
    expect(await answer(first)).toBeNull();
    pointAt(document.querySelector('button')!);
    click();
    expect((await answer(second))?.label).toBe('button.primary');
    expect(document.querySelectorAll('body ~ div')).toHaveLength(0);
  });

  it('cuts a long element’s HTML', async () => {
    document.querySelector('#cart span')!.textContent = 'x'.repeat(PICKED_HTML_LIMIT * 2);
    const picked = pageSide(OPTIONS);
    pointAt(document.querySelector('#cart')!);
    click();
    const html = String((await answer(picked))?.html);
    expect(html.length).toBeLessThan(PICKED_HTML_LIMIT + 40);
    expect(html.endsWith('<!-- … cut -->')).toBe(true);
  });

  it('is sent to the page as its own source, called with the hint', () => {
    const script = pickElementScript('Pick "this"');
    expect(script.startsWith('(')).toBe(true);
    expect(script).toContain(JSON.stringify('Pick "this"'));
    expect(script).toContain('__muPicker');
  });
});

describe('what the host makes of the answer', () => {
  const raw = {
    url: 'http://localhost:5173/',
    title: 'Shop',
    selector: 'main > button.primary',
    label: 'button.primary',
    text: 'Get started',
    html: '<button class="primary">Get started</button>',
    rect: { x: 10, y: 20, width: 120, height: 40 },
    size: { width: 120.4, height: 40 },
    styles: { color: 'rgb(255, 255, 255)', display: 'inline-block', onclick: 'steal()' },
  };

  it('keeps the expected fields only, each in bounds', () => {
    const picked = readPickedElement({
      ...raw,
      extra: 'x',
      text: 'y'.repeat(5000),
      rect: { x: -5, y: 'a', width: 1e9 },
    });
    expect(picked).not.toBeNull();
    expect(Object.keys(picked!.styles)).toEqual(['display', 'color']);
    expect(picked!.text).toHaveLength(300);
    expect(picked!.rect).toEqual({ x: 0, y: 0, width: 100_000, height: 0 });
    expect(picked!.size).toEqual({ width: 120, height: 40 });
    expect(picked).not.toHaveProperty('extra');
  });

  it('is no element without a selector and HTML, or when the page said nothing', () => {
    expect(readPickedElement(null)).toBeNull();
    expect(readPickedElement('button')).toBeNull();
    expect(readPickedElement({ ...raw, selector: '' })).toBeNull();
    expect(readPickedElement({ ...raw, html: 42 })).toBeNull();
  });

  it('says where the element is, how to find it, and how it looks', () => {
    expect(describePickedElement(readPickedElement(raw) as PickedElement)).toBe(
      [
        'Element on the page http://localhost:5173/ ("Shop") (button.primary):',
        '- selector: `main > button.primary`',
        '- text: "Get started"',
        '- size: 120×40 px',
        '- styles: display: inline-block; color: rgb(255, 255, 255)',
      ].join('\n')
    );
  });

  it('turns the picture into a PNG file named after the element', async () => {
    const file = pictureFile(btoa('\x89PNG'), 'button#buy.primary');
    expect(file.name).toBe('button-buy.primary.png');
    expect(file.type).toBe('image/png');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    expect(pictureFile(btoa('x'), '###').name).toBe('element.png');
  });
});
