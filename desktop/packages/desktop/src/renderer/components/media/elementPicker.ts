/**
 * Pointing at an element of a page in the app's browser, to show it to mu (docs/native-host-ui.md).
 *
 * The page in front runs `pickElementScript`: it outlines the element under the pointer and resolves with the one the
 * person clicks, or with null when they press Escape or the picker is called off (`CANCEL_PICK_SCRIPT`). The click
 * never reaches the page. ↑ widens the outline to the element's parent, ↓ narrows it back, Enter takes the outlined
 * one. The picker draws with the page's style objects only, which a page's content security policy allows.
 *
 * What comes back is the page's word, so `readPickedElement` keeps only what it expects, cut to size;
 * `describePickedElement` says it for the message: the page, a selector that finds it, its text, size and look.
 */

export type PickedRect = { x: number; y: number; width: number; height: number };

export type PickedElement = {
  url: string;
  title: string;
  /** A CSS selector that finds this element alone on the page, as far as the page allows. */
  selector: string;
  /** tag#id.class, as the chip in the send box shows it. */
  label: string;
  text: string;
  html: string;
  /** What of it is on screen, in the page's CSS pixels from the top left of its window; empty when none is. */
  rect: PickedRect;
  /** Its whole size in CSS pixels. */
  size: { width: number; height: number };
  /** The computed styles worth knowing, by property; those at their defaults are left out. */
  styles: Readonly<Record<string, string>>;
};

/** The element's HTML up to this many characters; a page's whole body would fill the model's context. */
export const PICKED_HTML_LIMIT = 4000;
export const PICKED_TEXT_LIMIT = 300;

/** The computed styles a picked element reports, in this order. */
export const PICKED_STYLES = [
  'display',
  'position',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'padding',
  'margin',
  'border',
  'border-radius',
  'gap',
  'opacity',
] as const;

/** Calls off a picker the page runs; the picker's promise resolves with null. */
export const CANCEL_PICK_SCRIPT = 'void (window.__muPicker && window.__muPicker.cancel())';

/**
 * The picker, as a script for `executeJavaScript`: it evaluates to a promise of the picked element (see
 * `PickedElement`; the page's own, unchecked) or null. `hint` is the line shown at the top of the page.
 */
export function pickElementScript(hint: string): string {
  return `(${pageSide.toString()})(${JSON.stringify({
    hint,
    htmlLimit: PICKED_HTML_LIMIT,
    textLimit: PICKED_TEXT_LIMIT,
    styles: PICKED_STYLES,
  })})`;
}

type PageSideOptions = { hint: string; htmlLimit: number; textLimit: number; styles: readonly string[] };

/* eslint-disable unicorn/consistent-function-scoping -- the page runs this from its source: all it uses is inside */
/**
 * Runs inside the page, from its source text: it may use nothing outside itself. Exported for the tests, which run it
 * in a document of their own.
 */
export function pageSide(options: PageSideOptions): Promise<unknown> {
  type Picker = { cancel: () => void };
  const host = window as unknown as { __muPicker?: Picker };
  host.__muPicker?.cancel();

  return new Promise((resolve) => {
    const doc = document;
    const layer = doc.createElement('div');
    const box = doc.createElement('div');
    const tag = doc.createElement('div');
    const hint = doc.createElement('div');
    layer.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;pointer-events:none;margin:0;padding:0;border:0;background:none';
    box.style.cssText =
      'position:absolute;display:none;box-sizing:border-box;border:2px solid #2563eb;background:rgba(37,99,235,0.12);border-radius:2px';
    tag.style.cssText =
      'position:absolute;display:none;padding:2px 6px;border-radius:4px;background:#1e40af;color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:nowrap;max-width:80vw;overflow:hidden;text-overflow:ellipsis';
    hint.style.cssText =
      'position:absolute;top:12px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:999px;background:rgba(17,24,39,0.9);color:#fff;font:13px/1.4 system-ui,sans-serif;white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis';
    hint.textContent = options.hint;
    layer.append(box, tag, hint);
    doc.documentElement.append(layer);

    let current: Element | null = null;
    // The elements ↑ widened from, to go back down with ↓.
    let narrower: Element[] = [];
    // The outlined element shows a crosshair; what its own style said is put back as it was, attribute and all.
    let cursor: { element: HTMLElement | SVGElement; value: string; priority: string; styled: boolean } | null = null;

    const setCursor = (element: Element | null) => {
      if (cursor) {
        const { element: was, value, priority, styled } = cursor;
        if (value) was.style.setProperty('cursor', value, priority);
        else was.style.removeProperty('cursor');
        if (!styled && !was.getAttribute('style')) was.removeAttribute('style');
      }
      cursor = null;
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        cursor = {
          element,
          value: element.style.getPropertyValue('cursor'),
          priority: element.style.getPropertyPriority('cursor'),
          styled: element.hasAttribute('style'),
        };
        element.style.setProperty('cursor', 'crosshair', 'important');
      }
    };
    const labelOf = (element: Element): string => {
      const name = element.tagName.toLowerCase();
      const id = element.id ? `#${element.id}` : '';
      const first = Array.from(element.classList)[0];
      return `${name}${id}${first ? `.${first}` : ''}`;
    };

    const draw = () => {
      if (!current) {
        box.style.display = 'none';
        tag.style.display = 'none';
        return;
      }
      const rect = current.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = `${rect.left}px`;
      box.style.top = `${rect.top}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
      tag.style.display = 'block';
      tag.textContent = `${labelOf(current)}  ${Math.round(rect.width)}×${Math.round(rect.height)}`;
      const above = rect.top - 24;
      tag.style.left = `${Math.max(0, rect.left)}px`;
      tag.style.top = `${above >= 0 ? above : Math.min(rect.bottom + 4, window.innerHeight - 24)}px`;
    };

    const outline = (element: Element | null, keepTrail = false) => {
      if (!element || element === layer || layer.contains(element) || element === current) return;
      if (!keepTrail) narrower = [];
      current = element;
      setCursor(element);
      draw();
    };

    const escape = (value: string): string =>
      typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
    const unique = (selector: string): boolean => {
      try {
        return doc.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    const step = (element: Element): { selector: string; anchored: boolean } => {
      if (element.id && unique(`#${escape(element.id)}`)) return { selector: `#${escape(element.id)}`, anchored: true };
      const classes = Array.from(element.classList)
        .filter((name) => /^[a-zA-Z_-][\w-]*$/.test(name) && name.length <= 40)
        .slice(0, 2);
      let selector = element.tagName.toLowerCase() + classes.map((name) => `.${escape(name)}`).join('');
      const parent = element.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        if (siblings.filter((sibling) => sibling.matches(selector)).length > 1) {
          const sameTag = siblings.filter((sibling) => sibling.tagName === element.tagName);
          selector += `:nth-of-type(${sameTag.indexOf(element) + 1})`;
        }
      }
      return { selector, anchored: false };
    };
    const selectorOf = (element: Element): string => {
      if (element === doc.documentElement) return 'html';
      const steps: string[] = [];
      for (let node: Element | null = element; node && node !== doc.documentElement; node = node.parentElement) {
        const next = step(node);
        steps.unshift(next.selector);
        const selector = steps.join(' > ');
        if (next.anchored || unique(selector)) return selector;
      }
      return steps.join(' > ');
    };

    const textOf = (element: Element): string => {
      // What it shows; where nothing lays the page out (innerText unknown), its text.
      const shown = (element instanceof HTMLElement ? element.innerText : undefined) ?? element.textContent;
      const said =
        (shown ?? '').replace(/\s+/g, ' ').trim() ||
        element.getAttribute('aria-label') ||
        element.getAttribute('alt') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('title') ||
        '';
      return said.slice(0, options.textLimit);
    };

    const quiet = (property: string, value: string): boolean =>
      !value ||
      value === 'normal' ||
      value === 'none' ||
      (property === 'position' && value === 'static') ||
      (property === 'opacity' && value === '1') ||
      (property === 'background-color' && value === 'rgba(0, 0, 0, 0)') ||
      ((property === 'padding' || property === 'margin' || property === 'border-radius') &&
        /^0px( 0px)*$/.test(value)) ||
      (property === 'border' && value.startsWith('0px'));
    const stylesOf = (element: Element): Record<string, string> => {
      const computed = window.getComputedStyle(element);
      const styles: Record<string, string> = {};
      for (const property of options.styles) {
        const value = computed.getPropertyValue(property).trim();
        if (!quiet(property, value)) styles[property] = value.slice(0, 200);
      }
      return styles;
    };

    const describe = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const top = Math.max(0, rect.top);
      const right = Math.min(window.innerWidth, rect.right);
      const bottom = Math.min(window.innerHeight, rect.bottom);
      const html = element.outerHTML;
      return {
        url: location.href,
        title: doc.title,
        selector: selectorOf(element),
        label: labelOf(element),
        text: textOf(element),
        html: html.length > options.htmlLimit ? `${html.slice(0, options.htmlLimit)}\n<!-- … cut -->` : html,
        rect:
          right > left && bottom > top
            ? { x: left, y: top, width: right - left, height: bottom - top }
            : { x: 0, y: 0, width: 0, height: 0 },
        size: { width: Math.round(rect.width), height: Math.round(rect.height) },
        styles: stylesOf(element),
      };
    };

    const swallowed = [
      'pointerdown',
      'pointerup',
      'mousedown',
      'mouseup',
      'dblclick',
      'auxclick',
      'contextmenu',
      'touchstart',
      'touchend',
    ];
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMove = (event: MouseEvent) => outline(doc.elementFromPoint(event.clientX, event.clientY));
    const onClick = (event: MouseEvent) => {
      swallow(event);
      if (event.button !== 0) return;
      const target = doc.elementFromPoint(event.clientX, event.clientY);
      if (target && target !== current && !narrower.length) outline(target);
      finish(current);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        swallow(event);
        finish(null);
      } else if (event.key === 'Enter' && current) {
        swallow(event);
        finish(current);
      } else if (event.key === 'ArrowUp' && current?.parentElement) {
        swallow(event);
        const widened = current;
        outline(current.parentElement, true);
        narrower.push(widened);
      } else if (event.key === 'ArrowDown' && narrower.length) {
        swallow(event);
        outline(narrower.pop() ?? null, true);
      }
    };
    const onLeave = () => finish(null);

    let done = false;
    function finish(element: Element | null) {
      if (done) return;
      done = true;
      setCursor(null);
      for (const type of swallowed) window.removeEventListener(type, swallow, true);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', draw, true);
      window.removeEventListener('resize', draw);
      window.removeEventListener('pagehide', onLeave);
      layer.remove();
      if (host.__muPicker === picker) delete host.__muPicker;
      let picked: unknown = null;
      try {
        picked = element && element.isConnected ? describe(element) : null;
      } catch {
        picked = null;
      }
      // Once the page has painted without the outline, for a picture of the element; a hidden page paints no
      // frames, so not later than a moment from now either way.
      let sent = false;
      const send = () => {
        if (sent) return;
        sent = true;
        resolve(picked);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(send));
      setTimeout(send, 250);
    }

    const picker: Picker = { cancel: () => finish(null) };
    host.__muPicker = picker;
    for (const type of swallowed) window.addEventListener(type, swallow, true);
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', draw, true);
    window.addEventListener('resize', draw);
    window.addEventListener('pagehide', onLeave);
  });
}

/* eslint-enable unicorn/consistent-function-scoping */

const text = (value: unknown, limit: number): string => (typeof value === 'string' ? value.slice(0, limit) : '');
const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, 100_000) : 0;

/** What the picker said, if it is a picked element: only the expected fields, each cut to size. */
export function readPickedElement(raw: unknown): PickedElement | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const selector = text(value.selector, 500);
  const html = text(value.html, PICKED_HTML_LIMIT + 40);
  if (!selector || !html) return null;
  const rect = (value.rect ?? {}) as Record<string, unknown>;
  const size = (value.size ?? {}) as Record<string, unknown>;
  const styles: Record<string, string> = {};
  const given = (value.styles ?? {}) as Record<string, unknown>;
  for (const property of PICKED_STYLES) {
    const style = text(given[property], 200);
    if (style) styles[property] = style;
  }
  return {
    url: text(value.url, 2000),
    title: text(value.title, 200),
    selector,
    label: text(value.label, 120) || selector.slice(0, 120),
    text: text(value.text, PICKED_TEXT_LIMIT),
    html,
    rect: { x: amount(rect.x), y: amount(rect.y), width: amount(rect.width), height: amount(rect.height) },
    size: { width: Math.round(amount(size.width)), height: Math.round(amount(size.height)) },
    styles,
  };
}

/** The lines above the element's HTML in the message: where it is, how to find it, and what it looks like. */
export function describePickedElement(element: PickedElement): string {
  const page = element.title ? `${element.url} ("${element.title}")` : element.url;
  const lines = [`Element on the page ${page || 'in the browser'} (${element.label}):`];
  lines.push(`- selector: \`${element.selector}\``);
  if (element.text) lines.push(`- text: "${element.text}"`);
  if (element.size.width || element.size.height) lines.push(`- size: ${element.size.width}×${element.size.height} px`);
  const styles = Object.entries(element.styles);
  if (styles.length) lines.push(`- styles: ${styles.map(([property, value]) => `${property}: ${value}`).join('; ')}`);
  return lines.join('\n');
}

/** The picture of a picked element (base64 PNG) as a file for the send box, named after the element. */
export function pictureFile(base64: string, label: string): File {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const name =
    label
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'element';
  return new File([bytes], `${name}.png`, { type: 'image/png' });
}
