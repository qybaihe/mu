/**
 * The picture of an element picked in the app's browser: taken of an app page only, at the page's zoom, scaled down
 * when large, and nothing when there is nothing to take.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ contents: new Map<number, unknown>() }));
vi.mock('electron', () => ({ webContents: { fromId: (id: number) => electron.contents.get(id) } }));

import { AREA_PICTURE_MAX_SIDE, pictureOfPageArea } from '@process/services/muBrowser/areaPicture';

type Size = { width: number; height: number };
const image = (size: Size, empty = false) => {
  const made = {
    size,
    isEmpty: () => empty,
    getSize: () => made.size,
    resize: vi.fn((to: Partial<Size>) => image({ width: to.width ?? 0, height: to.height ?? 0 })),
    toPNG: () => Buffer.from(`png ${made.size.width}x${made.size.height}`),
  };
  return made;
};
const page = (
  options: { type?: string; zoom?: number; picture?: ReturnType<typeof image>; destroyed?: boolean } = {}
) => {
  const contents = {
    isDestroyed: () => options.destroyed ?? false,
    getType: () => options.type ?? 'webview',
    getZoomFactor: () => options.zoom ?? 1,
    capturePage: vi.fn(async () => options.picture ?? image({ width: 240, height: 80 })),
  };
  electron.contents.set(7, contents);
  return contents;
};
const area = { x: 10.4, y: 20, width: 120, height: 40.2 };
const decoded = (base64: string | null) => (base64 === null ? null : Buffer.from(base64, 'base64').toString());

beforeEach(() => electron.contents.clear());

describe('a picture of part of a page in the app’s browser', () => {
  it('takes the area at the page’s zoom, as PNG', async () => {
    const contents = page({ zoom: 1.25 });
    expect(decoded(await pictureOfPageArea(7, area))).toBe('png 240x80');
    expect(contents.capturePage).toHaveBeenCalledWith({ x: 13, y: 25, width: 150, height: 51 });
  });

  it('scales a large picture down to the longest side the model takes', async () => {
    const wide = image({ width: 3200, height: 1000 });
    page({ picture: wide });
    expect(decoded(await pictureOfPageArea(7, area))).toBe(`png ${AREA_PICTURE_MAX_SIDE}x0`);
    expect(wide.resize).toHaveBeenCalledWith({ width: AREA_PICTURE_MAX_SIDE });

    const tall = image({ width: 900, height: 2400 });
    page({ picture: tall });
    await pictureOfPageArea(7, area);
    expect(tall.resize).toHaveBeenCalledWith({ height: AREA_PICTURE_MAX_SIDE });
  });

  it('takes none of the app’s own window, a page gone, an empty area or a page that painted nothing', async () => {
    const window = page({ type: 'window' });
    expect(await pictureOfPageArea(7, area)).toBeNull();
    expect(window.capturePage).not.toHaveBeenCalled();

    page({ destroyed: true });
    expect(await pictureOfPageArea(7, area)).toBeNull();
    expect(await pictureOfPageArea(8, area)).toBeNull();
    expect(await pictureOfPageArea(1.5, area)).toBeNull();

    page();
    expect(await pictureOfPageArea(7, { ...area, width: 0 })).toBeNull();
    expect(await pictureOfPageArea(7, { ...area, x: -1 })).toBeNull();
    expect(await pictureOfPageArea(7, { ...area, height: Number.NaN })).toBeNull();

    page({ picture: image({ width: 0, height: 0 }, true) });
    expect(await pictureOfPageArea(7, area)).toBeNull();
  });
});
