import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDateTime, formatDuration } from '@/renderer/services/i18n/format';

const CLOCK: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: 'numeric', second: 'numeric' };

/** The time of day in the app language. `toLocaleTimeString()` follows the operating system instead. */
export function formatClock(at: number | string | Date, language?: string | null): string {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? '' : formatDateTime(date, language, CLOCK);
}

export function useClock(): (at: number | string | Date) => string {
  const { i18n } = useTranslation();
  const language = i18n?.language;
  return useCallback((at: number | string | Date) => formatClock(at, language), [language]);
}

/** A log's clock: 24-hour, to the second, the same width on every line, in the app language's digits. */
const LOG_CLOCK: Intl.DateTimeFormatOptions = {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

export function useLogClock(): (at: number | string | Date) => string {
  const { i18n } = useTranslation();
  const language = i18n?.language;
  return useCallback(
    (at: number | string | Date) => {
      const date = at instanceof Date ? at : new Date(at);
      return Number.isNaN(date.getTime()) ? '' : formatDateTime(date, language, LOG_CLOCK);
    },
    [language]
  );
}

/**
 * The time now, taken again every `intervalMs` while `live`: for a label that counts up ("updated 20 s ago"). Only the
 * component that asks re-renders on each tick, never the panel around it.
 */
export function useNow(intervalMs = 1000, live = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, live]);
  return now;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/**
 * How long something has gone on, as a person says it: seconds in steps of five under a minute, whole minutes under an
 * hour, hours and minutes after that ("20 sec", "6 min", "1 hr, 5 min"), in the app language.
 */
export function formatElapsed(ms: number, language?: string | null): string {
  const span = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const step = span < MINUTE ? 5 * SECOND : MINUTE;
  return formatDuration(Math.floor(span / step) * step, language, 'short');
}
