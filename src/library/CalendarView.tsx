// Calendar view of the Library. Month: each day shows its best photo and how many photos were taken;
// Year: every day of the year as a heat map. Picking a day opens its photos in the grid.
// It covers the current source and filters, except the date filter, which it highlights instead.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Photo, app, openDate } from '../state/app';
import {
  addDays, addMonths, countLabel, dayKey, daysInMonth, firstDayOfWeek, formatDayLong, formatKey, formatMonthName, keyOf, monthKey, monthWeeks, parseKey,
  weekdayNames,
} from '../lib/dates';
import { Button, IconButton, Segmented, cx } from '../ui/controls';
import { DaySummary, daySummaries } from './grouping';
import { Thumb } from './Thumb';

type Days = Map<string, DaySummary>;

const dateKeyOf = (d: Date) => keyOf(d.getFullYear(), d.getMonth(), d.getDate());

/** Photos, and days with photos, in a year ('YYYY') or month ('YYYY-MM'). */
function totals(days: Days, prefix: string) {
  let photos = 0;
  let n = 0;
  for (const [k, d] of days)
    if (k.startsWith(prefix)) {
      photos += d.count;
      n++;
    }
  return { photos, days: n };
}

/** The newest day with photos whose key starts with `prefix`. */
function newestDay(days: Days, prefix = ''): string | null {
  let best: string | null = null;
  for (const k of days.keys()) if (k.startsWith(prefix) && (!best || k > best)) best = k;
  return best;
}

/** Where the calendar opens: the month of the date filter, else of the newest photo, else this month. */
function initialMonth(days: Days, date: string | null): string {
  const p = date ? parseKey(date) : null;
  if (p && p.kind !== 'year') return date!.slice(0, 7);
  const newest = newestDay(days, p ? date! : '');
  if (newest) return newest.slice(0, 7);
  return p ? `${date}-01` : monthKey(Date.now());
}

export function CalendarView({ photos }: { photos: Photo[] }) {
  const mode = app.use((s) => s.calendarMode);
  const stored = app.use((s) => s.calendarMonth);
  const date = app.use((s) => s.filter.date);
  const days = useMemo(() => daySummaries(photos), [photos]);
  const first = useMemo(firstDayOfWeek, []);
  const month = stored ?? initialMonth(days, date);
  const year = +month.slice(0, 4);
  const newest = newestDay(days);
  const sum = totals(days, mode === 'month' ? month : String(year));
  const step = mode === 'month' ? 1 : 12;
  const setMonth = (m: string) => app.set({ calendarMonth: m });
  return (
    <div className="cal">
      <header className="cal-head">
        <IconButton title={mode === 'month' ? 'Previous month' : 'Previous year'} onClick={() => setMonth(addMonths(month, -step))}>
          <ChevronLeft size={17} />
        </IconButton>
        <IconButton title={mode === 'month' ? 'Next month' : 'Next year'} onClick={() => setMonth(addMonths(month, step))}>
          <ChevronRight size={17} />
        </IconButton>
        <h2 className="cal-title" aria-live="polite">
          {mode === 'month' ? formatKey(month) : year}
        </h2>
        <span className="cal-sum">{sum.photos ? `${countLabel(sum.photos)} · ${countLabel(sum.days, 'day')}` : 'No photos'}</span>
        <div className="grow" />
        <Button small onClick={() => setMonth(monthKey(Date.now()))} title="Go to this month">
          Today
        </Button>
        <Button small disabled={!newest} onClick={() => newest && setMonth(newest.slice(0, 7))} title="Go to the newest photos">
          Newest
        </Button>
        <Segmented
          value={mode}
          onChange={(calendarMode) => app.set({ calendarMode })}
          options={[
            { value: 'month', label: 'Month', title: 'One month, with photos' },
            { value: 'year', label: 'Year', title: 'The whole year at a glance' },
          ]}
        />
      </header>
      {mode === 'month' ? (
        <MonthGrid month={month} days={days} first={first} selected={date} onMonth={setMonth} />
      ) : (
        <YearGrid year={year} days={days} first={first} selected={date} onMonth={(m) => app.set({ calendarMonth: m, calendarMode: 'month' })} />
      )}
    </div>
  );
}

function MonthGrid({ month, days, first, selected, onMonth }: { month: string; days: Days; first: number; selected: string | null; onMonth: (m: string) => void }) {
  const p = parseKey(month)!;
  const weeks = useMemo(() => monthWeeks(p.y, p.m!, first, 6), [p.y, p.m, first]);
  const names = useMemo(() => weekdayNames(first, 'short'), [first]);
  const today = dayKey(Date.now());
  // The one day cell in the tab order (arrow keys move it).
  const startFocus = () => (selected?.length === 10 && selected.startsWith(month) ? selected : (newestDay(days, month) ?? `${month}-01`));
  const [focus, setFocus] = useState(startFocus);
  const gridRef = useRef<HTMLDivElement>(null);
  const fromKeyboard = useRef(false);

  // A month picked with the buttons: put the focusable day inside it.
  useEffect(() => {
    if (!focus.startsWith(month) && !fromKeyboard.current) setFocus(startFocus());
  }, [month]);

  useEffect(() => {
    if (!fromKeyboard.current) return;
    const el = gridRef.current?.querySelector<HTMLElement>(`[data-day="${focus}"]`);
    if (!el) return;
    el.focus();
    if (focus.startsWith(month)) fromKeyboard.current = false;
  }, [focus, month]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const d = parseKey(focus);
    if (!d || d.d === undefined) return;
    const weekday = (new Date(d.y, d.m!, d.d).getDay() - first + 7) % 7;
    let next: string;
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(focus, -1);
        break;
      case 'ArrowRight':
        next = addDays(focus, 1);
        break;
      case 'ArrowUp':
        next = addDays(focus, -7);
        break;
      case 'ArrowDown':
        next = addDays(focus, 7);
        break;
      case 'Home':
        next = addDays(focus, -weekday);
        break;
      case 'End':
        next = addDays(focus, 6 - weekday);
        break;
      case 'PageUp':
      case 'PageDown': {
        const m = parseKey(addMonths(focus.slice(0, 7), e.key === 'PageUp' ? -1 : 1))!;
        next = keyOf(m.y, m.m!, Math.min(d.d, daysInMonth(m.y, m.m!)));
        break;
      }
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation(); // the Library's photo shortcuts use the same keys
    fromKeyboard.current = true;
    setFocus(next);
    if (!next.startsWith(month)) onMonth(next.slice(0, 7));
  };

  return (
    <div className="cal-month" role="grid" aria-label={formatKey(month)} ref={gridRef} onKeyDown={onKeyDown}>
      <div className="cal-weekdays" role="row">
        {names.map((n, i) => (
          <div key={i} role="columnheader">
            {n}
          </div>
        ))}
      </div>
      {weeks.map((w) => (
        <div className="cal-week" role="row" key={dateKeyOf(w[0])}>
          {w.map((d) => {
            const k = dateKeyOf(d);
            const info = days.get(k);
            const label = `${formatDayLong(d.getTime())}, ${info ? countLabel(info.count) : 'no photos'}`;
            return (
              <div role="gridcell" key={k} aria-selected={selected === k}>
                <button
                  data-day={k}
                  tabIndex={k === focus ? 0 : -1}
                  className={cx('cal-day', !k.startsWith(month) && 'out', k === today && 'today', info && 'has', selected === k && 'sel')}
                  aria-label={label}
                  aria-disabled={info ? undefined : true}
                  title={info ? `${label}: click to show them` : label}
                  onClick={() => info && openDate(k)}
                  onFocus={() => setFocus(k)}
                >
                  {info && <Thumb photo={info.cover} className="cal-cover" alt="" />}
                  <span className="cal-num" aria-hidden="true">
                    {d.getDate()}
                  </span>
                  {info && (
                    <span className="cal-count" aria-hidden="true">
                      {info.count.toLocaleString()}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function YearGrid({ year, days, first, selected, onMonth }: { year: number; days: Days; first: number; selected: string | null; onMonth: (m: string) => void }) {
  const names = useMemo(() => weekdayNames(first, 'narrow'), [first]);
  const today = dayKey(Date.now());
  const busiest = useMemo(() => {
    let m = 1;
    for (const [k, d] of days) if (k.startsWith(String(year))) m = Math.max(m, d.count);
    return m;
  }, [days, year]);
  // Four shades, on a log scale so one huge day doesn't wash out the rest.
  const shade = (n: number) => 1 + Math.min(3, Math.floor((Math.log(n) / Math.log(busiest + 1)) * 4));
  return (
    <div className="cal-year">
      {Array.from({ length: 12 }, (_, m) => {
        const mk = keyOf(year, m);
        const t = totals(days, mk);
        return (
          <section key={mk} className="cal-mini" aria-label={`${formatKey(mk)}, ${countLabel(t.photos)}`}>
            <button className="cal-mini-title" onClick={() => onMonth(mk)} title={`Show ${formatKey(mk)}`}>
              <span>{formatMonthName(new Date(year, m, 1).getTime())}</span>
              <span className="count">{t.photos ? t.photos.toLocaleString() : ''}</span>
            </button>
            <div className="cal-mini-grid">
              {names.map((n, i) => (
                <span key={`w${i}`} className="cal-mini-wd" aria-hidden="true">
                  {n}
                </span>
              ))}
              {monthWeeks(year, m, first)
                .flat()
                .map((d) => {
                  const k = dateKeyOf(d);
                  if (d.getMonth() !== m) return <span key={k} className="cal-dot out" aria-hidden="true" />;
                  const info = days.get(k);
                  const cls = cx('cal-dot', k === today && 'today', selected === k && 'sel');
                  if (!info)
                    return (
                      <span key={k} className={cls} aria-hidden="true">
                        {d.getDate()}
                      </span>
                    );
                  const label = `${formatDayLong(d.getTime())}, ${countLabel(info.count)}`;
                  return (
                    <button key={k} className={cx(cls, `lvl${shade(info.count)}`)} tabIndex={-1} title={label} aria-label={label} onClick={() => openDate(k)}>
                      {d.getDate()}
                    </button>
                  );
                })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
