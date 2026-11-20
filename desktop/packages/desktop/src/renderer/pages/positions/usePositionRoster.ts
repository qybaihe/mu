/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The roster as the window sees it: the main process's position library,
 * refreshed while the sidebar is open (the library is the user's file to
 * change at any time; a short poll keeps the roster honest without watching
 * the file system).
 */
import useSWR, { mutate } from 'swr';
import { positionBridge } from '@/common/chat/team/positions/positionBridge';
import type { PositionInfo } from '@/common/chat/team/positions/positionLibraryCore';

export const POSITIONS_SWR_KEY = 'positions.roster';

export const fetchPositions = (): Promise<PositionInfo[]> => positionBridge.list.invoke();

/** Refetches the roster everywhere it shows: what a delete or a restore calls,
 *  so the sidebar's rows move without waiting for the next poll. */
export const refreshPositions = (): Promise<unknown> => mutate(POSITIONS_SWR_KEY);

/** The roster, empty while it loads or when there is no position library. */
export const usePositionRoster = (): { positions: PositionInfo[]; isLoading: boolean } => {
  const { data, isLoading } = useSWR<PositionInfo[]>(POSITIONS_SWR_KEY, fetchPositions, {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  });
  return { positions: data ?? [], isLoading };
};
