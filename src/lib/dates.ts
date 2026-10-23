// Calendar-date helpers for the Library: date keys, ranges, labels and month grids.
//
// Photos are bucketed by the local wall-clock time they were taken at. (EXIF capture times are read as
// local time on import, so a photo taken at 23:30 stays on that day.)
//
// A date key names a period: 'YYYY' (year), 'YYYY-MM' (month) or 'YYYY-MM-DD' (day). Keys are zero-padded,
// so a day key starts with its month and year keys: `day.startsWith(month)` tests membership.

export type DateKind = 'year' | 'month' | 'day';

const pad = (n: number) => String(n).padStart(2, '0');

export const keyOf = (y: number, m0?: number, d?: number) =>
  m0 === undefined ? String(y) : d === undefined ? `${y}-${pad(m0 + 1)}` : `${y}-${pad(m0 + 1)}-${pad(d)}`;
export const dayKey = (t: number) => {
  const d = new Date(t);
  return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
};
export const monthKey = (t: number) => dayKey(t).slice(0, 7);
export const yearKey = (t: number) => dayKey(t).slice(0, 4);

/** Parts of a date key (month is 0-based), or null if it isn't one. */
export function parseKey(k: string): { y: number; m?: number; d?: number; kind: DateKind } | null {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(k);
  if (!m) return null;
  const y = +m[1];
  if (!m[2]) return { y, kind: 'year' };
  const mo = +m[2] - 1;
  if (mo < 0 || mo > 11) return null;
  if (!m[3]) return { y, m: mo, kind: 'month' };
  return { y, m: mo, d: +m[3], kind: 'day' };
}

/** Local midnight at the start of the period a key names, and of the period after it. */
export function keyRange(k: string): [number, number] | null {
  const p = parseKey(k);
  if (!p) return null;
  if (p.kind === 'year') return [new Date(p.y, 0, 1).getTime(), new Date(p.y + 1, 0, 1).getTime()];
  if (p.kind === 'month') return [new Date(p.y, p.m!, 1).getTime(), new Date(p.y, p.m! + 1, 1).getTime()];
  return [new Date(p.y, p.m!, p.d!).getTime(), new Date(p.y, p.m!, p.d! + 1).getTime()];
}

/** Key of the month `delta` months after a 'YYYY-MM' key. */
export function addMonths(month: string, delta: number): string {
  const p = parseKey(month);
  if (!p || p.m === undefined) return month;
  const d = new Date(p.y, p.m + delta, 1);
  return keyOf(d.getFullYear(), d.getMonth());
}

/** Key of the day `delta` days after a 'YYYY-MM-DD' key (calendar days, so DST changes don't matter). */
export function addDays(day: string, delta: number): string {
  const p = parseKey(day);
  if (!p || p.d === undefined) return day;
  const d = new Date(p.y, p.m!, p.d + delta);
  return keyOf(d.getFullYear(), d.getMonth(), d.getDate());
}

export const daysInMonth = (y: number, m0: number) => new Date(y, m0 + 1, 0).getDate();

// ---------------------------------------------------------------- labels (in the user's locale)

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const k = JSON.stringify(opts);
  let f = formatters.get(k);
  if (!f) formatters.set(k, (f = new Intl.DateTimeFormat(undefined, opts)));
  return f;
}

const DAY_LONG: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
const DATE_SHORT: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };
const TIME: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };

/** "Saturday, March 14, 2026" */
export const formatDayLong = (t: number) => fmt(DAY_LONG).format(t);
/** "March 2026" */
export const formatMonth = (t: number) => fmt({ year: 'numeric', month: 'long' }).format(t);
/** "March" or "Mar" */
export const formatMonthName = (t: number, style: 'long' | 'short' = 'long') => fmt({ month: style }).format(t);
/** "Sat, Mar 14" */
export const formatDayNoYear = (t: number) => fmt({ weekday: 'short', month: 'short', day: 'numeric' }).format(t);
/** "4:05 PM" */
export const formatTime = (t: number) => fmt(TIME).format(t);

function range(f: Intl.DateTimeFormat, a: number, b: number) {
  return typeof f.formatRange === 'function' ? f.formatRange(a, b) : `${f.format(a)} – ${f.format(b)}`;
}

/** "Mar 14, 2026", "Mar 14 – 16, 2026", "Mar 30 – Apr 2, 2026" or "Dec 30, 2025 – Jan 2, 2026". */
export function formatDateRange(a: number, b: number): string {
  if (b < a) [a, b] = [b, a];
  const f = fmt(DATE_SHORT);
  return dayKey(a) === dayKey(b) ? f.format(a) : range(f, a, b);
}

/** "10:12 AM – 4:05 PM", or a single time when both are in the same minute. */
export function formatTimeRange(a: number, b: number): string {
  if (b < a) [a, b] = [b, a];
  const f = fmt(TIME);
  return Math.floor(a / 60000) === Math.floor(b / 60000) ? f.format(a) : range(f, a, b);
}

/** Label for a date key: "2026", "March 2026", or the day ("Saturday, March 14, 2026" / "Mar 14, 2026"). */
export function formatKey(k: string, style: 'long' | 'short' = 'long'): string {
  const p = parseKey(k);
  if (!p) return k;
  if (p.kind === 'year') return String(p.y);
  if (p.kind === 'month') return formatMonth(new Date(p.y, p.m!, 1).getTime());
  const t = new Date(p.y, p.m!, p.d!).getTime();
  return style === 'long' ? formatDayLong(t) : fmt(DATE_SHORT).format(t);
}

/** "1 photo", "12 photos", "1,204 photos" */
export const countLabel = (n: number, noun = 'photo') => `${n.toLocaleString()} ${noun}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------- calendar grids

/** First day of the week for the user's locale: 0 = Sunday … 6 = Saturday. */
export function firstDayOfWeek(): number {
  try {
    type WeekInfo = { firstDay: number };
    const loc = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay; // 1 = Monday … 7 = Sunday
    if (first) return first % 7;
  } catch {
    /* older engines: fall through */
  }
  return 0;
}

/** Weekday names starting at `first` ("Sun", "Mon", … or "S", "M", …). */
export function weekdayNames(first: number, style: 'short' | 'narrow' | 'long' = 'short'): string[] {
  const f = fmt({ weekday: style });
  // 1 January 2023 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => f.format(new Date(2023, 0, 1 + ((first + i) % 7))));
}

/**
 * The weeks of a month as rows of 7 local dates, starting on weekday `first`, including the days of the
 * neighbouring months that fill the first and last weeks. `rows: 6` always returns six weeks, so a month
 * view keeps its size from month to month.
 */
export function monthWeeks(y: number, m0: number, first: number, rows?: number): Date[][] {
  const offset = (new Date(y, m0, 1).getDay() - first + 7) % 7;
  const n = rows ?? Math.ceil((offset + daysInMonth(y, m0)) / 7);
  return Array.from({ length: n }, (_, w) => Array.from({ length: 7 }, (_, i) => new Date(y, m0, 1 - offset + w * 7 + i)));
}
