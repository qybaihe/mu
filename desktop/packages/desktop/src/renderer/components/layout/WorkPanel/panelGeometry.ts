import { WORK_PANEL_MIN_WIDTH } from './workPanelStore';

/**
 * The transcript keeps at least this much of the row while the panel sits beside it: the app's minimum content width
 * (`--app-min-width`, which the route content keeps too), about a phone's. Its lines stay readable and the composer
 * stays whole: its toolbar wraps and its chips give up label width before anything is hidden.
 */
export const MIN_TRANSCRIPT_PX = 360;
/** The panel takes at most this share of the window. */
const MAX_WINDOW_SHARE = 0.6;
/** The panel's hairline edge, drawn outside its width. */
const EDGE_PX = 1;
/** The mobile sheet: most of the screen, capped. */
const SHEET_SHARE = 0.85;
const SHEET_MAX_PX = 420;

export type PanelGeometry = { mode: 'dock' | 'fill' | 'sheet'; width: number; max: number };

/**
 * Where the panel sits and how wide it is. Beside the transcript (`dock`) while both fit: at least 270px for the
 * panel, at most 60% of the window, and 360px left for the transcript, which shrinks and wraps rather than being
 * covered. A row too narrow for both gives the panel all of it (`fill`): the transcript is set aside, whole, until
 * the panel is closed again (its strip then leads with the way back). A phone shows the panel as a sheet from the
 * side (`sheet`).
 *
 * @param rowWidth the [transcript | panel] row, 0 before it is measured
 * @param wanted the width the person gave the panel
 */
export function panelGeometry(
  rowWidth: number,
  viewportWidth: number,
  isMobile: boolean,
  wanted: number
): PanelGeometry {
  if (isMobile) {
    const width = Math.min(viewportWidth, SHEET_MAX_PX, Math.max(WORK_PANEL_MIN_WIDTH, viewportWidth * SHEET_SHARE));
    return { mode: 'sheet', width: Math.round(width), max: Math.round(width) };
  }
  const byWindow = Math.floor(viewportWidth * MAX_WINDOW_SHARE);
  const inFlow = rowWidth > 0 ? Math.min(byWindow, rowWidth - MIN_TRANSCRIPT_PX - EDGE_PX) : byWindow;
  if (inFlow >= WORK_PANEL_MIN_WIDTH) {
    return { mode: 'dock', max: inFlow, width: Math.min(inFlow, Math.max(WORK_PANEL_MIN_WIDTH, wanted)) };
  }
  const whole = Math.max(0, Math.round(rowWidth > 0 ? rowWidth : viewportWidth));
  return { mode: 'fill', max: whole, width: whole };
}
