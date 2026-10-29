import { webContents } from 'electron';

export type PageArea = { x: number; y: number; width: number; height: number };

/** The longest side of a picture, in pixels; a larger one is scaled down (it goes to the model as an image). */
export const AREA_PICTURE_MAX_SIDE = 1600;

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * A picture of part of a page in the app's browser, as base64 PNG: the element the person picked to show mu, or with
 * no `area` all of the page that is on screen, for the person to show mu what they see (docs/native-host-ui.md).
 * `area` is in the page's CSS pixels, as the page measures it; the page's zoom turns it into the view's. Null when
 * there is nothing to take: the id is not a page (`<webview>`) of the app, the area is empty, or the page painted
 * nothing there.
 */
export async function pictureOfPageArea(webContentsId: number, area?: PageArea): Promise<string | null> {
  if (!Number.isInteger(webContentsId)) return null;
  if (area !== undefined && (!area || ![area.x, area.y, area.width, area.height].every(whole))) return null;
  const contents = webContents.fromId(webContentsId);
  // A page of the app's browser only: never the app's own window.
  if (!contents || contents.isDestroyed() || contents.getType() !== 'webview') return null;
  const zoom = contents.getZoomFactor() || 1;
  const rect = area && {
    x: Math.floor(area.x * zoom),
    y: Math.floor(area.y * zoom),
    width: Math.ceil(area.width * zoom),
    height: Math.ceil(area.height * zoom),
  };
  if (rect && (rect.width < 1 || rect.height < 1)) return null;
  let image = await (rect ? contents.capturePage(rect) : contents.capturePage());
  if (image.isEmpty()) return null;
  const { width, height } = image.getSize();
  if (Math.max(width, height) > AREA_PICTURE_MAX_SIDE)
    image = image.resize(width >= height ? { width: AREA_PICTURE_MAX_SIDE } : { height: AREA_PICTURE_MAX_SIDE });
  return image.toPNG().toString('base64');
}
