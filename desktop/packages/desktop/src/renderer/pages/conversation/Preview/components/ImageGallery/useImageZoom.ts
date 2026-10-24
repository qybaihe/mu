/**
 * Zoom and pan for an image in a frame (ImageGallery.tsx). The image starts fitted to the frame, never above its own
 * size; `zoom` multiplies that. Ctrl or ⌘ with the wheel, and a trackpad pinch (which Chromium sends as a wheel with
 * Ctrl), zoom around the pointer; once the image is larger than the frame, the wheel and a drag move it. A new image
 * (`key`) starts fitted again.
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export const ZOOM_STEP = 1.25;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 16;

type Size = { width: number; height: number };
type View = { zoom: number; x: number; y: number };
type Point = { x: number; y: number };

const FITTED: View = { zoom: 1, x: 0, y: 0 };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** Keeps the image over the frame: it moves only as far as it is larger than the frame. */
function within(view: View, shown: Size | undefined, frame: Size | undefined): View {
  if (!shown || !frame) return view;
  const spareX = Math.max(0, (shown.width - frame.width) / 2);
  const spareY = Math.max(0, (shown.height - frame.height) / 2);
  return { zoom: view.zoom, x: clamp(view.x, -spareX, spareX), y: clamp(view.y, -spareY, spareY) };
}

export type ImageZoom = {
  frameRef: React.RefObject<HTMLDivElement | null>;
  /** Multiplier over the fitted size: 1 is fitted to the frame. */
  zoom: number;
  offset: Point;
  /** The image's size on screen, once its own size and the frame's are known. */
  shown?: Size;
  /** The scale on screen against the image's own pixels, in percent (against the fitted size until it loads). */
  percent: number;
  /** Whether the image is larger than the frame, so it can be moved. */
  movable: boolean;
  panning: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
  onImageLoad: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  panHandlers: {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
    onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  };
};

export function useImageZoom(key: string): ImageZoom {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>(FITTED);
  const [natural, setNatural] = useState<Size>();
  const [frame, setFrame] = useState<Size>();
  const [panning, setPanning] = useState(false);
  const drag = useRef<{ pointerId: number; from: Point; origin: Point } | null>(null);

  // A new image starts fitted, and its size is read again when it loads.
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) {
    setShownKey(key);
    setView(FITTED);
    setNatural(undefined);
  }

  useLayoutEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setFrame(width > 0 && height > 0 ? { width, height } : undefined);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fit = natural && frame ? Math.min(1, frame.width / natural.width, frame.height / natural.height) : undefined;
  const sizeAt = useCallback(
    (zoom: number): Size | undefined =>
      natural && fit !== undefined
        ? { width: natural.width * fit * zoom, height: natural.height * fit * zoom }
        : undefined,
    [fit, natural]
  );
  const shown = sizeAt(view.zoom);

  // The latest of everything, for the wheel listener, which is added once.
  const latest = useRef({ view, frame, sizeAt });
  latest.current = { view, frame, sizeAt };

  /** Zooms by `factor`, keeping the point `at` (from the frame's centre) where it is on screen. */
  const zoomBy = useCallback((factor: number, at: Point = { x: 0, y: 0 }) => {
    setView((current) => {
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = zoom / current.zoom;
      const next = { zoom, x: at.x - (at.x - current.x) * ratio, y: at.y - (at.y - current.y) * ratio };
      return within(next, latest.current.sizeAt(zoom), latest.current.frame);
    });
  }, []);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        const box = element.getBoundingClientRect();
        const at = { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 };
        zoomBy(Math.exp(-event.deltaY / 300), at);
        return;
      }
      const { view: current, frame: frameNow, sizeAt: sizeNow } = latest.current;
      const size = sizeNow(current.zoom);
      if (!size || !frameNow || (size.width <= frameNow.width && size.height <= frameNow.height)) return;
      event.preventDefault();
      setView((now) => within({ ...now, x: now.x - event.deltaX, y: now.y - event.deltaY }, size, frameNow));
    };
    // React's wheel listener is passive, so it could not keep the page from scrolling.
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const movable = Boolean(shown && frame && (shown.width > frame.width || shown.height > frame.height));

  const endPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setPanning(false);
  };

  return {
    frameRef,
    zoom: view.zoom,
    offset: { x: view.x, y: view.y },
    shown,
    percent: Math.round((fit ?? 1) * view.zoom * 100),
    movable,
    panning,
    zoomIn: () => zoomBy(ZOOM_STEP),
    zoomOut: () => zoomBy(1 / ZOOM_STEP),
    reset: () => setView(FITTED),
    onImageLoad: (event) => {
      const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
      setNatural(width > 0 && height > 0 ? { width, height } : undefined);
    },
    panHandlers: {
      onPointerDown: (event) => {
        if (!movable || event.button !== 0) return;
        event.preventDefault();
        drag.current = { pointerId: event.pointerId, from: { x: event.clientX, y: event.clientY }, origin: view };
        event.currentTarget.setPointerCapture?.(event.pointerId);
        setPanning(true);
      },
      onPointerMove: (event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        const next = {
          zoom: view.zoom,
          x: start.origin.x + event.clientX - start.from.x,
          y: start.origin.y + event.clientY - start.from.y,
        };
        setView(within(next, shown, frame));
      },
      onPointerUp: endPan,
      onPointerCancel: endPan,
    },
  };
}
