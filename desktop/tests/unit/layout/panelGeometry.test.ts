import { describe, expect, it } from 'vitest';
import { MIN_TRANSCRIPT_PX, panelGeometry } from '@/renderer/components/layout/WorkPanel/panelGeometry';
import { WORK_PANEL_MIN_WIDTH } from '@/renderer/components/layout/WorkPanel/workPanelStore';

describe('panelGeometry', () => {
  it('docks the panel beside the conversation while both fit', () => {
    // A 1280px window with the sidebar open (261px): a 1019px row, of which the panel may take 1019 - 361 = 658.
    expect(panelGeometry(1019, 1280, false, 360)).toEqual({ mode: 'dock', width: 360, max: 658 });
  });

  it('takes at most 60% of the window', () => {
    expect(panelGeometry(1800, 1860, false, 2000)).toEqual({ mode: 'dock', width: 1116, max: 1116 });
  });

  it('narrows a wide panel so the conversation keeps its 360px', () => {
    // An 800px window with the sidebar folded to its rail: a 744px row.
    const geometry = panelGeometry(744, 800, false, 500);
    expect(geometry).toEqual({ mode: 'dock', width: 383, max: 383 });
    expect(744 - 1 - geometry.width).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_PX);
  });

  it('never docks narrower than the panel minimum', () => {
    expect(panelGeometry(744, 800, false, 100).width).toBe(WORK_PANEL_MIN_WIDTH);
  });

  it('gives the panel the whole row when the row cannot hold both, instead of floating it over the text', () => {
    // An 800px window with the sidebar open: a 539px row cannot hold 360 + 1 + 270.
    expect(panelGeometry(539, 800, false, 360)).toEqual({ mode: 'fill', width: 539, max: 539 });
  });

  it('turns from docked to filling exactly where the row stops holding both', () => {
    const edge = MIN_TRANSCRIPT_PX + 1 + WORK_PANEL_MIN_WIDTH;
    expect(panelGeometry(edge, 1200, false, 360).mode).toBe('dock');
    expect(panelGeometry(edge - 1, 1200, false, 360).mode).toBe('fill');
  });

  it('goes by the window before the row is measured', () => {
    expect(panelGeometry(0, 1280, false, 360)).toEqual({ mode: 'dock', width: 360, max: 768 });
    expect(panelGeometry(0, 400, false, 360)).toEqual({ mode: 'fill', width: 400, max: 400 });
  });

  it('slides in as a sheet on a phone', () => {
    expect(panelGeometry(390, 390, true, 360)).toEqual({ mode: 'sheet', width: 332, max: 332 });
  });
});
