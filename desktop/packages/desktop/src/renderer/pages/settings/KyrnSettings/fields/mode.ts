import type { DecisionMode } from '@/common/kyrn/manifest';

/**
 * The two states a decision point is shown in: on (`active`), or off. The harness has a third mode, `shadow` (asked
 * and recorded, changing nothing); a stored `shadow` has no effect either, so it reads as off and stays as it is until
 * a switch is moved.
 */
export type ShownMode = 'active' | 'off';

export const shownMode = (mode: DecisionMode): ShownMode => (mode === 'active' ? 'active' : 'off');
