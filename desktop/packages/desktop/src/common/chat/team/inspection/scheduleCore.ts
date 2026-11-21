/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Schedule math for the resident inspection, framework-free so tests drive
 * it with a fake clock. Two system-owned schedules, both at 09:00 local: the
 * friction scan every WEEKDAY (scanning the previous local day), the waste
 * audit every MONDAY (scanning the previous 7 local days). All boundaries
 * are local-time day edges; DST days shift with them, which is the honest
 * behavior for "yesterday at the user's office".
 */

/** The local hour both schedules fire at — before the workday, after the night batch. */
export const INSPECTION_HOUR = 9;

/** True from Monday through Friday (local), the friction scan's fire days. */
export function isWeekday(at: number): boolean {
  const day = new Date(at).getDay();
  return day >= 1 && day <= 5;
}

/** The local-time start-of-day timestamp. */
export function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Adds n local days, keeping the time-of-day. */
export function plusDays(at: number, days: number): number {
  const d = new Date(at);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** The ms from `now` to today's (or tomorrow's) 09:00 local; 0 means it IS 09:00 sharp. */
function msUntilHour(at: number): number {
  const target = new Date(at);
  target.setHours(INSPECTION_HOUR, 0, 0, 0);
  if (target.getTime() < at) target.setDate(target.getDate() + 1);
  return target.getTime() - at;
}

/** The next moment the scheduler should wake: the coming 09:00 local, skipping weekend days entirely. */
export function nextWakeAt(now: number): number {
  const candidate = now + msUntilHour(now);
  if (isWeekday(candidate)) return candidate;
  // Weekend: jump to Monday's 09:00. Saturday (+2) or Sunday (+1).
  const d = new Date(candidate);
  const addDays = d.getDay() === 6 ? 2 : 1;
  return plusDays(candidate, addDays);
}

/** True when a wake at `wakeAt` should run the waste audit too: Monday's wake. */
export function isAuditWake(wakeAt: number): boolean {
  return new Date(wakeAt).getDay() === 1;
}

/** The friction scan's window: the previous local day, start-inclusive/end-exclusive. */
export function previousDayWindow(now: number): { from: number; to: number } {
  const todayStart = startOfDay(now);
  return { from: plusDays(todayStart, -1), to: todayStart };
}

/** The waste audit's window: the previous 7 local days. */
export function previousWeekWindow(now: number): { from: number; to: number } {
  const todayStart = startOfDay(now);
  return { from: plusDays(todayStart, -7), to: todayStart };
}

/** The manual run's window: a rolling 24h, so "run it now" always covers today's data. */
export function rollingDayWindow(now: number): { from: number; to: number } {
  return { from: now - 24 * 60 * 60 * 1000, to: now };
}
