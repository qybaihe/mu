import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { on: vi.fn() }, screen: {} }));

import { MIN_WINDOW_WIDTH } from '@/process/utils/windowBounds';
import {
  isSiderCrowded,
  isSiderFolded,
  SIDER_RAIL_WIDTH,
  SIDER_REOPEN_MARGIN_PX,
  siderChoiceAfterRoomChange,
  type SiderChoice,
  type SiderRoom,
} from '@/renderer/components/layout/Sider/siderRoom';
import { MIN_TRANSCRIPT_PX } from '@/renderer/components/layout/WorkPanel/panelGeometry';

const room = (viewportWidth: number, extra: Partial<SiderRoom> = {}): SiderRoom => ({
  viewportWidth,
  siderWidth: 260,
  panelOpen: false,
  isMobile: false,
  ...extra,
});

/** The sidebar as Layout keeps it: the room (with its memory of being crowded) and the person's choice. */
class Sidebar {
  crowded = false;
  choice: SiderChoice = null;

  resize(next: SiderRoom): this {
    const crowded = isSiderCrowded(this.crowded, next);
    if (crowded !== this.crowded) {
      this.crowded = crowded;
      this.choice = siderChoiceAfterRoomChange(this.choice);
    }
    return this;
  }

  toggle(): this {
    this.choice = this.folded ? 'open' : 'folded';
    return this;
  }

  get folded(): boolean {
    return isSiderFolded(this.choice, this.crowded);
  }
}

describe('isSiderCrowded', () => {
  it('keeps the sidebar open while it leaves the conversation 360px', () => {
    // 260 + 1 + 360 = 621
    expect(isSiderCrowded(false, room(621))).toBe(false);
    expect(isSiderCrowded(false, room(620))).toBe(true);
  });

  it('opens a folded sidebar only once the window is a little wider than needed', () => {
    expect(isSiderCrowded(true, room(621))).toBe(true);
    expect(isSiderCrowded(true, room(621 + SIDER_REOPEN_MARGIN_PX - 1))).toBe(true);
    expect(isSiderCrowded(true, room(621 + SIDER_REOPEN_MARGIN_PX))).toBe(false);
  });

  it('goes by the width the person gave the sidebar', () => {
    expect(isSiderCrowded(false, room(700, { siderWidth: 400 }))).toBe(true);
    expect(isSiderCrowded(false, room(700, { siderWidth: 200 }))).toBe(false);
  });

  it('keeps room for the work panel at its narrowest while it is open', () => {
    // 260 + 1 + 360 + 1 + 270 = 892
    expect(isSiderCrowded(false, room(800, { panelOpen: true }))).toBe(true);
    expect(isSiderCrowded(false, room(800))).toBe(false);
    expect(isSiderCrowded(false, room(892, { panelOpen: true }))).toBe(false);
  });

  it('always puts the sidebar away on a phone', () => {
    expect(isSiderCrowded(false, room(1024, { isMobile: true }))).toBe(true);
  });
});

describe('the sidebar across resizes', () => {
  it('folds in a narrow window and opens again once the window is wide again (N13)', () => {
    const sidebar = new Sidebar().resize(room(1680));
    expect(sidebar.folded).toBe(false);
    expect(sidebar.resize(room(480)).folded).toBe(true);
    expect(sidebar.resize(room(1680)).folded).toBe(false);
  });

  it('stays folded when the person folded it, however wide the window gets', () => {
    const sidebar = new Sidebar().resize(room(1680)).toggle();
    expect(sidebar.folded).toBe(true);
    expect(sidebar.resize(room(480)).folded).toBe(true);
    expect(sidebar.resize(room(1680)).folded).toBe(true);
  });

  it('stays open when the person opens it in a narrow window, and follows the room again once the window changes', () => {
    const sidebar = new Sidebar().resize(room(480)).toggle();
    expect(sidebar.folded).toBe(false);
    expect(sidebar.resize(room(500)).folded).toBe(false);
    expect(sidebar.resize(room(1680)).folded).toBe(false);
    expect(sidebar.resize(room(480)).folded).toBe(true);
  });

  it('makes way for the work panel in an 800px window and comes back when the panel closes', () => {
    const sidebar = new Sidebar().resize(room(800));
    expect(sidebar.folded).toBe(false);
    expect(sidebar.resize(room(800, { panelOpen: true })).folded).toBe(true);
    expect(sidebar.resize(room(800)).folded).toBe(false);
  });
});

describe('the narrowest window', () => {
  it('leaves the conversation its readable width beside the folded sidebar', () => {
    // The rail and its 1px edge.
    expect(MIN_WINDOW_WIDTH - SIDER_RAIL_WIDTH - 1).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_PX);
  });
});
