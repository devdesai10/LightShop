// Date organisation for the Library: events (runs of photos taken close together in time), the grid's
// sections by event, day, month or year, the Dates tree, per-day summaries for the calendar, and the
// date span of each collection.

import type { Collection, GroupBy, Photo } from '../state/app';
import { photoTime } from '../state/app';
import { countLabel, dayKey, formatDateRange, formatDayLong, formatKey, formatTimeRange, keyRange, monthKey, yearKey } from '../lib/dates';

// ---------------------------------------------------------------- events

export interface PhotoEvent {
  /** Stays the same while the event's first photo does, so it survives edits and new imports. */
  key: string;
  start: number;
  end: number;
  ids: string[];
}

export interface EventIndex {
  events: PhotoEvent[];
  of: Map<string, PhotoEvent>;
}

let eventCache: { photos: Photo[]; gapHours: number; index: EventIndex } | null = null;

/**
 * Splits the whole catalog into events: a new event starts whenever more than `gapHours` pass between
 * one photo and the next. Computed over every photo (not just the filtered ones) so an event is the same
 * whichever filters are on.
 */
export function computeEvents(photos: Photo[], gapHours: number): EventIndex {
  if (eventCache && eventCache.photos === photos && eventCache.gapHours === gapHours) return eventCache.index;
  const gap = gapHours * 3_600_000;
  const sorted = [...photos].sort((a, b) => photoTime(a) - photoTime(b) || a.importedAt - b.importedAt);
  const events: PhotoEvent[] = [];
  const of = new Map<string, PhotoEvent>();
  let cur: PhotoEvent | null = null;
  for (const p of sorted) {
    const t = photoTime(p);
    if (!cur || t - cur.end > gap) {
      cur = { key: `e:${p.id}`, start: t, end: t, ids: [] };
      events.push(cur);
    }
    cur.ids.push(p.id);
    cur.end = t;
    of.set(p.id, cur);
  }
  const index = { events, of };
  eventCache = { photos, gapHours, index };
  return index;
}

/** Calendar days an interval touches (1 for a single day). */
export function daySpan(start: number, end: number): number {
  const a = keyRange(dayKey(start))![0];
  const b = keyRange(dayKey(end))![0];
  return Math.round((b - a) / 86_400_000) + 1; // rounding absorbs DST hours
}

/**
 * The collection that names an event, if there is one: it holds at least half of the event's photos and
 * those make up at least half of the collection (so "Beach day" names that day, but "Best of 2026" doesn't).
 */
export function eventCollection(ev: PhotoEvent, byId: Map<string, Photo>, spans: Map<string, CollectionSpan>, collections: Collection[]): Collection | undefined {
  const hits = new Map<string, number>();
  for (const id of ev.ids) for (const c of byId.get(id)?.collections ?? []) hits.set(c, (hits.get(c) ?? 0) + 1);
  let best: Collection | undefined;
  let bestScore = 0;
  for (const [cid, k] of hits) {
    const size = spans.get(cid)?.count ?? 0;
    if (!size || k * 2 < ev.ids.length || k * 2 < size) continue;
    const score = (k / ev.ids.length) * (k / size);
    if (score > bestScore) {
      const c = collections.find((x) => x.id === cid);
      if (c) {
        best = c;
        bestScore = score;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------- grid sections

export interface Section {
  key: string;
  kind: GroupBy;
  /** Earliest and latest capture time of the photos in the section. */
  start: number;
  end: number;
  photos: Photo[];
  event?: PhotoEvent;
}

/**
 * Groups the (already filtered and sorted) photos into sections. Sections run oldest first, or newest
 * first when `newestFirst`; inside a section photos keep the order of the current sort.
 */
export function groupSections(ordered: Photo[], by: GroupBy, newestFirst: boolean, events: EventIndex | null): Section[] {
  if (by === 'none' || !ordered.length) return [{ key: 'all', kind: 'none', start: 0, end: 0, photos: ordered }];
  const map = new Map<string, Section>();
  for (const p of ordered) {
    const t = photoTime(p);
    const ev = by === 'event' ? events?.of.get(p.id) : undefined;
    const key = ev ? ev.key : by === 'year' ? yearKey(t) : by === 'month' ? monthKey(t) : dayKey(t);
    let s = map.get(key);
    if (!s) map.set(key, (s = { key, kind: by, start: t, end: t, photos: [], event: ev }));
    s.photos.push(p);
    if (t < s.start) s.start = t;
    if (t > s.end) s.end = t;
  }
  const dir = newestFirst ? -1 : 1;
  return [...map.values()].sort((a, b) => (a.start - b.start) * dir);
}

export interface SectionLabel {
  title: string;
  meta: string;
  /** For events: the collection that names it. */
  named?: Collection;
}

export function sectionLabel(s: Section, ctx: { byId: Map<string, Photo>; spans: Map<string, CollectionSpan>; collections: Collection[] }): SectionLabel {
  const n = s.photos.length;
  const days = () => new Set(s.photos.map((p) => dayKey(photoTime(p)))).size;
  if (s.kind === 'year' || s.kind === 'month') {
    return { title: formatKey(s.kind === 'year' ? yearKey(s.start) : monthKey(s.start)), meta: `${countLabel(n)} · ${countLabel(days(), 'day')}` };
  }
  if (s.kind === 'day') return { title: formatDayLong(s.start), meta: `${countLabel(n)} · ${formatTimeRange(s.start, s.end)}` };
  const ev = s.event;
  if (!ev) return { title: formatDayLong(s.start), meta: countLabel(n) };
  const total = ev.ids.length;
  const multiDay = dayKey(ev.start) !== dayKey(ev.end);
  const when = multiDay ? formatDateRange(ev.start, ev.end) : formatDayLong(ev.start);
  const span = multiDay ? countLabel(daySpan(ev.start, ev.end), 'day') : formatTimeRange(ev.start, ev.end);
  const count = n < total ? `${n.toLocaleString()} of ${countLabel(total)}` : countLabel(n);
  const named = eventCollection(ev, ctx.byId, ctx.spans, ctx.collections);
  return { title: named?.name ?? when, meta: [named ? when : null, span, count].filter(Boolean).join(' · '), named };
}

/**
 * ↑/↓ in a grid made of sections that each wrap at `cols` columns: the photo above or below, moving into
 * the neighbouring section's nearest row at the same column. At the very top or bottom it returns the
 * first or last photo.
 */
export function verticalNeighbour(sections: Section[], id: string | null, down: boolean, cols: number): Photo | null {
  const nonEmpty = sections.filter((s) => s.photos.length);
  if (!nonEmpty.length) return null;
  let si = -1;
  let i = -1;
  for (let k = 0; k < nonEmpty.length && si < 0; k++) {
    const j = nonEmpty[k].photos.findIndex((p) => p.id === id);
    if (j >= 0) [si, i] = [k, j];
  }
  if (si < 0) return nonEmpty[0].photos[0];
  const cur = nonEmpty[si].photos;
  const col = i % cols;
  if (down) {
    if (i + cols < cur.length) return cur[i + cols];
    const lastRow = Math.floor((cur.length - 1) / cols) * cols;
    if (i < lastRow) return cur[cur.length - 1]; // into a shorter last row
    const next = nonEmpty[si + 1]?.photos;
    return next ? next[Math.min(col, next.length - 1)] : cur[cur.length - 1];
  }
  if (i >= cols) return cur[i - cols];
  const prev = nonEmpty[si - 1]?.photos;
  if (!prev) return cur[0];
  const lastRow = Math.floor((prev.length - 1) / cols) * cols;
  return prev[Math.min(lastRow + col, prev.length - 1)];
}

// ---------------------------------------------------------------- dates tree and calendar

export interface DateNode {
  key: string;
  count: number;
  children: DateNode[];
}

/** Years → months → days that have photos, with counts, newest first. */
export function dateTree(photos: Photo[]): DateNode[] {
  const days = new Map<string, number>();
  for (const p of photos) {
    const k = dayKey(photoTime(p));
    days.set(k, (days.get(k) ?? 0) + 1);
  }
  const years = new Map<string, DateNode>();
  const months = new Map<string, DateNode>();
  for (const [k, n] of [...days].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const yk = k.slice(0, 4);
    const mk = k.slice(0, 7);
    let y = years.get(yk);
    if (!y) years.set(yk, (y = { key: yk, count: 0, children: [] }));
    let m = months.get(mk);
    if (!m) {
      months.set(mk, (m = { key: mk, count: 0, children: [] }));
      y.children.push(m);
    }
    m.children.push({ key: k, count: n, children: [] });
    m.count += n;
    y.count += n;
  }
  return [...years.values()];
}

export interface DaySummary {
  count: number;
  /** The photo shown on the calendar: the best rated, then picked, then the first taken that day. */
  cover: Photo;
}

const coverScore = (p: Photo) => p.rating * 2 + (p.flag === 1 ? 3 : 0) - (p.flag === -1 ? 20 : 0);

export function daySummaries(photos: Photo[]): Map<string, DaySummary> {
  const out = new Map<string, DaySummary>();
  for (const p of photos) {
    const k = dayKey(photoTime(p));
    const d = out.get(k);
    if (!d) out.set(k, { count: 1, cover: p });
    else {
      d.count++;
      const a = coverScore(p);
      const b = coverScore(d.cover);
      if (a > b || (a === b && photoTime(p) < photoTime(d.cover))) d.cover = p;
    }
  }
  return out;
}

// ---------------------------------------------------------------- collections

export interface CollectionSpan {
  count: number;
  start: number;
  end: number;
}

/** Photo count and capture-date span of every collection. */
export function collectionSpans(photos: Photo[]): Map<string, CollectionSpan> {
  const out = new Map<string, CollectionSpan>();
  for (const p of photos) {
    if (!p.collections.length) continue;
    const t = photoTime(p);
    for (const c of p.collections) {
      const s = out.get(c);
      if (!s) out.set(c, { count: 1, start: t, end: t });
      else {
        s.count++;
        if (t < s.start) s.start = t;
        if (t > s.end) s.end = t;
      }
    }
  }
  return out;
}

/** Collections newest first by their latest photo (empty ones last), or by name. */
export function sortCollections(list: Collection[], spans: Map<string, CollectionSpan>, by: 'date' | 'name'): Collection[] {
  const byName = (a: Collection, b: Collection) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  if (by === 'name') return [...list].sort(byName);
  return [...list].sort((a, b) => {
    const sa = spans.get(a.id);
    const sb = spans.get(b.id);
    if (sa && sb) return sb.end - sa.end || byName(a, b);
    if (sa || sb) return sa ? -1 : 1;
    return byName(a, b);
  });
}

/** A default name for a new collection: the date span of its photos ("Mar 14 – 16, 2026"). */
export function datedName(photos: Photo[]): string | null {
  if (!photos.length) return null;
  let a = Infinity;
  let b = -Infinity;
  for (const p of photos) {
    const t = photoTime(p);
    if (t < a) a = t;
    if (t > b) b = t;
  }
  return formatDateRange(a, b);
}
