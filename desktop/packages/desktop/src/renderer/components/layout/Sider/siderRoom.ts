import { MIN_TRANSCRIPT_PX } from '../WorkPanel/panelGeometry';
import { WORK_PANEL_MIN_WIDTH } from '../WorkPanel/workPanelStore';

/** A hairline edge: the sidebar's, and the work panel's. */
const EDGE_PX = 1;
/**
 * Collapsed on a desktop, the sidebar is a rail of its icons: the mark, a new conversation, search, the scheduled
 * tasks, the settings and the theme, each with its tooltip. On a phone it slides away entirely.
 */
export const SIDER_RAIL_WIDTH = 56;
/** How much wider than needed the window must get before a sidebar that made room opens again. */
export const SIDER_REOPEN_MARGIN_PX = 24;

export type SiderRoom = {
  viewportWidth: number;
  /** The open sidebar's width, as the person left it. */
  siderWidth: number;
  /** The work panel is open beside the conversation, and needs its narrowest width too. */
  panelOpen: boolean;
  isMobile: boolean;
};

/**
 * Whether the window is too narrow for the open sidebar beside a readable conversation (and the work panel at its
 * narrowest, when that is open): the sidebar then folds to its rail, and it opens again once the window is wide
 * enough. Once crowded, a window stays so until it is a little wider than needed, so one resized across the line does
 * not make the sidebar flicker. On a phone the sidebar slides over the page, so it is always put away.
 */
export function isSiderCrowded(wasCrowded: boolean, room: SiderRoom): boolean {
  if (room.isMobile) return true;
  const beside = room.panelOpen ? EDGE_PX + WORK_PANEL_MIN_WIDTH : 0;
  const needed = room.siderWidth + EDGE_PX + MIN_TRANSCRIPT_PX + beside;
  return room.viewportWidth < needed + (wasCrowded ? SIDER_REOPEN_MARGIN_PX : 0);
}

/** The person's own folding or opening of the sidebar; `null` while the sidebar follows the room there is. */
export type SiderChoice = 'folded' | 'open' | null;

/** Whether the sidebar shows folded: as the person left it, or else as the room allows. */
export const isSiderFolded = (choice: SiderChoice, crowded: boolean): boolean =>
  choice === 'folded' || (choice === null && crowded);

/**
 * The room changed (the window crossed the line, or the work panel opened or closed): a sidebar the person opened
 * follows the room again, and one they folded stays folded however wide the window gets.
 */
export const siderChoiceAfterRoomChange = (choice: SiderChoice): SiderChoice => (choice === 'open' ? null : choice);
