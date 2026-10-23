// The Library's Dates panel: the years, months and days that have photos (for the current source and
// filters), with counts. Picking one shows only the photos taken then; picking it again shows all dates.

import { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronDown, ChevronRight, X } from 'lucide-react';
import { AppState, Photo, app } from '../state/app';
import { countLabel, formatDayNoYear, formatKey, formatMonthName, keyRange, parseKey } from '../lib/dates';
import { IconButton, Panel, cx } from '../ui/controls';
import { DateNode, dateTree } from './grouping';

/** The year and month keys above a date key, i.e. the tree rows to expand to reveal it. */
const ancestors = (k: string) => [k.slice(0, 4), ...(k.length > 7 ? [k.slice(0, 7)] : [])];

function rowLabel(node: DateNode, level: number) {
  if (level === 1) return node.key;
  const t = keyRange(node.key)![0];
  return level === 2 ? formatMonthName(t) : formatDayNoYear(t);
}

export function DatesPanel({ photos, onCalendar }: { photos: Photo[]; onCalendar: () => void }) {
  const date = app.use((s) => s.filter.date);
  const tree = useMemo(() => dateTree(photos), [photos]);
  // Expanded rows. Until the user expands or collapses something, the newest year is open.
  const [expanded, setExpanded] = useState<Set<string> | null>(() => (date ? new Set(ancestors(date)) : null));
  const newestYear = tree[0]?.key;
  const open = useMemo(() => expanded ?? new Set(newestYear ? [newestYear] : []), [expanded, newestYear]);
  const listRef = useRef<HTMLUListElement>(null);

  const update = (f: (s: Set<string>) => void) =>
    setExpanded((cur) => {
      const n = new Set(cur ?? (newestYear ? [newestYear] : []));
      f(n);
      return n;
    });
  const toggle = (k: string, force?: boolean) =>
    update((n) => {
      if (force ?? !n.has(k)) n.add(k);
      else n.delete(k);
    });

  // Reveal a date picked elsewhere (calendar, section header).
  useEffect(() => {
    if (date && !ancestors(date).every((k) => open.has(k))) update((n) => ancestors(date).forEach((k) => n.add(k)));
  }, [date]);

  const pick = (node: DateNode) => {
    const s = app.get();
    if (s.filter.date === node.key) return app.set({ filter: { ...s.filter, date: null } });
    const kind = parseKey(node.key)?.kind;
    const patch: Partial<AppState> = { filter: { ...s.filter, date: node.key } };
    if (s.libraryView === 'calendar') {
      if (kind === 'day') patch.libraryView = 'grid';
      else patch.calendarMonth = kind === 'month' ? node.key : (node.children[0]?.key ?? `${node.key}-01`);
    }
    app.set(patch);
    if (node.children.length) toggle(node.key, true);
  };

  // Rows currently shown, in order (collapsed branches hidden).
  const rows: { node: DateNode; level: 1 | 2 | 3; parent: number }[] = [];
  for (const y of tree) {
    const yi = rows.push({ node: y, level: 1, parent: -1 }) - 1;
    if (!open.has(y.key)) continue;
    for (const m of y.children) {
      const mi = rows.push({ node: m, level: 2, parent: yi }) - 1;
      if (open.has(m.key)) for (const d of m.children) rows.push({ node: d, level: 3, parent: mi });
    }
  }
  const focusKey = rows.some((r) => r.node.key === date) ? date : rows[0]?.node.key;

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const r = rows[i];
    const kids = r.node.children.length > 0;
    let target: number | null = null;
    switch (e.key) {
      case 'ArrowDown':
        target = Math.min(rows.length - 1, i + 1);
        break;
      case 'ArrowUp':
        target = Math.max(0, i - 1);
        break;
      case 'ArrowRight':
        if (kids && !open.has(r.node.key)) toggle(r.node.key, true);
        else if (kids) target = i + 1;
        break;
      case 'ArrowLeft':
        if (kids && open.has(r.node.key)) toggle(r.node.key, false);
        else if (r.parent >= 0) target = r.parent;
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = rows.length - 1;
        break;
      case 'Enter':
      case ' ':
        pick(r.node);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation(); // the Library's photo shortcuts use the same keys
    if (target !== null) listRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')[target]?.focus();
  };

  return (
    <Panel
      title="Dates"
      id="lib-dates"
      actions={
        <>
          {date && (
            <IconButton title="Show all dates" onClick={() => app.set((s) => ({ filter: { ...s.filter, date: null } }))}>
              <X size={13} />
            </IconButton>
          )}
          <IconButton title="Calendar" shortcut="C" onClick={onCalendar}>
            <CalendarDays size={14} />
          </IconButton>
        </>
      }
    >
      {!tree.length && <div className="hint">No photos match the current filters.</div>}
      <ul className="nav-list date-tree" role="tree" aria-label="Dates" ref={listRef}>
        {rows.map(({ node, level }, i) => {
          const kids = node.children.length > 0;
          const isOpen = kids && open.has(node.key);
          return (
            <li
              key={node.key}
              role="treeitem"
              aria-level={level}
              aria-expanded={kids ? isOpen : undefined}
              aria-selected={date === node.key}
              aria-label={`${formatKey(node.key)}, ${countLabel(node.count)}`}
              tabIndex={node.key === focusKey ? 0 : -1}
              className={cx(`lvl${level}`, date === node.key && 'active')}
              onClick={() => pick(node)}
              onKeyDown={(e) => onKeyDown(e, i)}
              title={date === node.key ? 'Click again to show all dates' : formatKey(node.key)}
            >
              {kids ? (
                <button
                  className="disclose"
                  tabIndex={-1}
                  aria-hidden="true"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(node.key);
                  }}
                >
                  {isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              ) : (
                <span className="disclose" aria-hidden="true" />
              )}
              <span className="date-label">{rowLabel(node, level)}</span>
              <span className="count">{node.count.toLocaleString()}</span>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
