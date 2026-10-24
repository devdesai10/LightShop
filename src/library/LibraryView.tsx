import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDownAZ, CalendarDays, Check, Flag, FolderPlus, Grid2x2, Image as ImageIcon, ImagePlus, Images, Layers, Pencil, SlidersHorizontal, Trash, Upload, X,
} from 'lucide-react';
import {
  AppState, ColorLabel, EVENT_GAPS, GroupBy, LABELS, LibraryViewMode, Photo, addToCollection, app, createCollection, deleteCollection, deletePhotos,
  filterPhotos, importFiles, IMPORT_ACCEPT, matchesDate, openInDevelop, removeFromCollection, renameCollection, setFlag, setLabel, setRating,
  thumbUrl, toast, updatePhotos,
} from '../state/app';
import { countLabel, formatDateRange, formatKey, parseKey, yearKey } from '../lib/dates';
import { formatShutter } from '../lib/exif';
import { formatBytes, isTypingTarget, keyLabel, modKey, pickFiles } from '../lib/util';
import { Button, IconButton, Modal, Panel, Segmented, Stars, cx } from '../ui/controls';
import { ExportDialog } from '../ui/ExportDialog';
import { HistogramView } from '../ui/widgets';
import { computeHistogram, Histogram } from '../develop/renderer';
import { BUILTIN_PRESETS, applyPatch, normalizeSettings, isEdited } from '../develop/settings';
import { openPhotoInEditor } from '../editor/session';
import { renderThumbnailFor } from '../develop/thumbs';
import { confirmDialog, promptText } from '../ui/dialogs';
import { wheelDelta, wheelZoomFactor } from '../lib/gestures';
import { CalendarView } from './CalendarView';
import { DatesPanel } from './DatesPanel';
import { Section, collectionSpans, computeEvents, datedName, groupSections, sectionLabel, sortCollections, verticalNeighbour } from './grouping';
import { Thumb } from './Thumb';

export { Thumb };

const THUMB_MIN = 110;
const THUMB_MAX = 340;

/**
 * The Library's photo lists. `base`: the current source and filters except the date filter (for the
 * Dates panel and the calendar). `visible`: with the date filter too. `sections`: `visible` split into the
 * grid's date groups, and `ordered`: those photos in display order.
 */
export function useLibraryPhotos() {
  const photos = app.use((s) => s.photos);
  const filter = app.use((s) => s.filter);
  const sort = app.use((s) => s.sort);
  const sortDesc = app.use((s) => s.sortDesc);
  const lastImport = app.use((s) => s.lastImport);
  const groupBy = app.use((s) => s.groupBy);
  const gapHours = app.use((s) => s.eventGapHours);
  return useMemo(() => {
    const base = filterPhotos({ photos, filter: { ...filter, date: null }, sort, sortDesc, lastImport });
    const visible = filter.date ? base.filter((p) => matchesDate(p, filter.date!)) : base;
    const events = groupBy === 'event' ? computeEvents(photos, gapHours) : null;
    const sections = groupSections(visible, groupBy, sortDesc, events);
    const ordered = sections.length === 1 ? sections[0].photos : sections.flatMap((s) => s.photos);
    return { base, visible, sections, ordered };
  }, [photos, filter, sort, sortDesc, lastImport, groupBy, gapHours]);
}

/** The photos the Library shows, in display order (also the Develop filmstrip). */
export function useVisiblePhotos(): Photo[] {
  return useLibraryPhotos().ordered;
}

/** Switches the Library to the calendar, on the month of the date filter if there is one. */
export function showCalendar() {
  app.set((s) => {
    const kind = s.filter.date ? parseKey(s.filter.date)?.kind : undefined;
    const calendarMonth = kind === 'day' || kind === 'month' ? s.filter.date!.slice(0, 7) : kind === 'year' ? null : s.calendarMonth;
    return { libraryView: 'calendar', calendarMonth };
  });
}

const setView = (v: LibraryViewMode) => (v === 'calendar' ? showCalendar() : app.set({ libraryView: v }));

/** Shows a catalog source (all of its dates); the calendar then opens on its newest photos. */
const setSource = (source: AppState['filter']['source'], collection: string | null = null) =>
  app.set((s) => ({ filter: { ...s.filter, source, collection, date: null }, calendarMonth: null }));

export async function promptImport() {
  const files = await pickFiles(IMPORT_ACCEPT, true);
  if (files.length) await importFiles(files);
}

const FLAG_FILTERS: { value: AppState['filter']['flag']; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'picked', label: 'Picked' },
  { value: 'unflagged', label: 'Unflagged' },
  { value: 'rejected', label: 'Rejected' },
];

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'event', label: 'Events' },
  { value: 'day', label: 'Days' },
  { value: 'month', label: 'Months' },
  { value: 'year', label: 'Years' },
  { value: 'none', label: 'No groups' },
];

function FilterBar() {
  const filter = app.use((s) => s.filter);
  const sort = app.use((s) => s.sort);
  const sortDesc = app.use((s) => s.sortDesc);
  const view = app.use((s) => s.libraryView);
  const size = app.use((s) => s.thumbSize);
  const groupBy = app.use((s) => s.groupBy);
  const gapHours = app.use((s) => s.eventGapHours);
  const setF = (p: Partial<AppState['filter']>) => app.set((s) => ({ filter: { ...s.filter, ...p } }));
  return (
    <div className="filterbar">
      <Segmented
        className="view-switch"
        value={view}
        onChange={setView}
        options={[
          { value: 'grid', label: <Grid2x2 size={13} />, title: 'Grid (G)' },
          { value: 'loupe', label: <ImageIcon size={13} />, title: 'Loupe (E)' },
          { value: 'calendar', label: <CalendarDays size={13} />, title: 'Calendar (C)' },
        ]}
      />
      <input
        className="text-input search"
        type="search"
        placeholder="Search"
        title="Search by name, camera, lens, or keyword"
        value={filter.text}
        onChange={(e) => setF({ text: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        }}
        aria-label="Search photos"
      />
      {filter.date && (
        <span className="chip date-chip" title={`Showing photos from ${formatKey(filter.date)}`}>
          <CalendarDays size={12} />
          {formatKey(filter.date, 'short')}
          <button aria-label="Show all dates" title="Show all dates" onClick={() => setF({ date: null })}>
            <X size={11} />
          </button>
        </span>
      )}
      <div className="bar-group" role="group" aria-label="Rating, flag and label filters">
        <div className="row" title="Show photos with at least this rating">
          <Stars value={filter.minRating} onChange={(minRating) => setF({ minRating })} size={13} />
        </div>
        <select value={filter.flag} onChange={(e) => setF({ flag: e.target.value as AppState['filter']['flag'] })} aria-label="Flag filter">
          {FLAG_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="row" role="group" aria-label="Color label filter">
          {LABELS.map((l) => (
            <button
              key={l}
              className={cx('label-dot', `label-${l}`)}
              style={{ border: filter.label === l ? '2px solid #fff' : '2px solid transparent', width: 14, height: 14, padding: 0 }}
              onClick={() => setF({ label: filter.label === l ? 'any' : l })}
              aria-label={`Filter ${l} label`}
              aria-pressed={filter.label === l}
            />
          ))}
        </div>
      </div>
      {view !== 'calendar' && (
        <div className="bar-group arrange" role="group" aria-label="Arrange">
          {view === 'grid' && (
            <>
              <span className="filter-label" aria-hidden="true">
                Group
              </span>
              <select value={groupBy} onChange={(e) => app.set({ groupBy: e.target.value as GroupBy })} aria-label="Group photos by" title="Group photos by when they were taken">
                {GROUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {groupBy === 'event' && (
                <select
                  value={gapHours}
                  onChange={(e) => app.set({ eventGapHours: +e.target.value })}
                  aria-label="New event after a gap of"
                  title="A new event starts when photos are further apart than this"
                >
                  {EVENT_GAPS.map((h) => (
                    <option key={h} value={h}>
                      {h < 24 ? `${h} h apart` : '1 day apart'}
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
          <select value={sort} onChange={(e) => app.set({ sort: e.target.value as AppState['sort'] })} aria-label="Sort by">
            <option value="captured">Capture time</option>
            <option value="imported">Import time</option>
            <option value="name">File name</option>
            <option value="rating">Rating</option>
          </select>
          <IconButton title={sortDesc ? 'Descending (newest groups first)' : 'Ascending (oldest groups first)'} onClick={() => app.set({ sortDesc: !sortDesc })}>
            <span style={{ fontSize: 13 }}>{sortDesc ? '↓' : '↑'}</span>
          </IconButton>
          {view === 'grid' && (
            <input
              type="range"
              className="mini-range"
              min={THUMB_MIN}
              max={THUMB_MAX}
              value={size}
              onChange={(e) => app.set({ thumbSize: +e.target.value })}
              aria-label="Thumbnail size"
              title="Thumbnail size (or pinch the grid)"
            />
          )}
        </div>
      )}
    </div>
  );
}

function GridCell({ p, selected, active, onClick, onDouble }: { p: Photo; selected: boolean; active: boolean; onClick: (e: React.MouseEvent) => void; onDouble: () => void }) {
  return (
    <div
      className={cx('cell', selected && 'selected', active && 'active', p.flag === -1 && 'rejected')}
      onMouseDown={onClick}
      onDoubleClick={onDouble}
      draggable
      onDragStart={(e) => {
        const ids = app.get().selected.includes(p.id) ? app.get().selected : [p.id];
        e.dataTransfer.setData('application/x-lightshop-photos', JSON.stringify(ids));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      role="gridcell"
      aria-selected={selected}
      aria-label={p.name}
    >
      <div className="thumb">
        <Thumb photo={p} />
      </div>
      {p.flag !== 0 && (
        <span className={cx('flag', p.flag === -1 && 'reject')} title={p.flag === 1 ? 'Picked' : 'Rejected'}>
          {p.flag === 1 ? <Flag size={13} fill="currentColor" /> : <X size={14} />}
        </span>
      )}
      <div className="badges">
        {p.isRaw && <span className="badge">RAW</span>}
        {p.hasProject && <span className="badge" title="Has a layered Editor project">LAYERS</span>}
        {isEdited(p.settings) && <span className="badge edit" title="Has develop edits">EDIT</span>}
      </div>
      <div className="meta">
        <span className="name" title={p.name}>
          {p.name}
        </span>
        {p.label && <span className={cx('label-dot', `label-${p.label}`)} />}
        <Stars value={p.rating} onChange={(v) => setRating([p.id], v)} size={10} />
      </div>
    </div>
  );
}

type LabelContext = Parameters<typeof sectionLabel>[1];

/** Header of a date group in the grid: when, how many, and quick actions. */
function SectionHeader({ section, ctx }: { section: Section; ctx: LabelContext }) {
  const label = sectionLabel(section, ctx);
  const isEvent = section.kind === 'event' && !!section.event;
  const select = () => app.set({ selected: section.photos.map((p) => p.id), activeId: section.photos[0]?.id ?? null });
  const save = async () => {
    // Naming an event takes all of its photos, even ones the filters hide; other groups take what's shown.
    const ids = isEvent ? section.event!.ids : section.photos.map((p) => p.id);
    const name = await promptText(isEvent ? 'Name this event' : 'New collection', label.title, {
      message: `${countLabel(ids.length)} go into a new collection with this name.`,
      okLabel: 'Create',
    });
    if (!name?.trim()) return;
    await createCollection(name.trim(), ids);
    toast(`Created "${name.trim()}" with ${countLabel(ids.length)}`, 'success');
  };
  return (
    <header className="group-head">
      <div className="group-title">
        <h3 id={`grp-${section.key}`}>{label.title}</h3>
        <span className="group-meta">{label.meta}</span>
      </div>
      <div className="group-actions">
        <Button small onClick={select} title="Select every photo in this group">
          Select
        </Button>
        {label.named ? (
          <Button small onClick={() => setSource('collection', label.named!.id)} title={`Show the "${label.named.name}" collection`}>
            <Layers size={12} /> Open collection
          </Button>
        ) : (
          <Button small onClick={save} title={isEvent ? 'Give this event a name (saved as a collection)' : 'Save these photos as a collection'}>
            <FolderPlus size={12} /> {isEvent ? 'Name event…' : 'Make collection…'}
          </Button>
        )}
      </div>
    </header>
  );
}

function Grid({ sections, photos }: { sections: Section[]; photos: Photo[] }) {
  const selected = app.use((s) => s.selected);
  const activeId = app.use((s) => s.activeId);
  const size = app.use((s) => s.thumbSize);
  const all = app.use((s) => s.photos);
  const collections = app.use((s) => s.collections);
  const sel = useMemo(() => new Set(selected), [selected]);
  const grouped = sections.length > 0 && sections[0].kind !== 'none';
  // Needed to name events after a matching collection.
  const ctx = useMemo<LabelContext>(
    () => (grouped ? { byId: new Map(all.map((p) => [p.id, p])), spans: collectionSpans(all), collections } : { byId: new Map(), spans: new Map(), collections }),
    [grouped, all, collections],
  );
  const anchor = useRef<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const click = (p: Photo, e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if (e.shiftKey && anchor.current) {
      const a = photos.findIndex((x) => x.id === anchor.current);
      const b = photos.findIndex((x) => x.id === p.id);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      app.set({ selected: photos.slice(lo, hi + 1).map((x) => x.id), activeId: p.id });
      return;
    }
    if (modKey(e)) {
      const next = sel.has(p.id) ? selected.filter((x) => x !== p.id) : [...selected, p.id];
      app.set({ selected: next, activeId: p.id });
      anchor.current = p.id;
      return;
    }
    if (!sel.has(p.id) || selected.length === 1) app.set({ selected: [p.id], activeId: p.id });
    else app.set({ activeId: p.id });
    anchor.current = p.id;
  };

  useEffect(() => {
    const el = ref.current?.querySelector('.cell.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  // Pinch (or ⌘-scroll) resizes the thumbnails, like Photos; plain scrolling still scrolls the grid.
  const hasPhotos = photos.length > 0;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const cur = app.get().thumbSize;
      const next = Math.min(THUMB_MAX, Math.max(THUMB_MIN, cur * wheelZoomFactor(wheelDelta(e, el.clientHeight).dy, e.ctrlKey)));
      if (next !== cur) app.set({ thumbSize: next });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [hasPhotos]);

  if (!photos.length) return <EmptyState />;
  const columns = { gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` };
  const cells = (list: Photo[]) =>
    list.map((p) => <GridCell key={p.id} p={p} selected={sel.has(p.id)} active={p.id === activeId} onClick={(e) => click(p, e)} onDouble={() => openInDevelop(p.id)} />);
  return (
    <div className={cx('grid-scroll', grouped && 'grouped')} ref={ref} data-cols>
      {grouped ? (
        sections.map((s) => (
          <section key={s.key} className="lib-group" aria-labelledby={`grp-${s.key}`}>
            <SectionHeader section={s} ctx={ctx} />
            <div className="grid" role="grid" aria-labelledby={`grp-${s.key}`} style={columns}>
              {cells(s.photos)}
            </div>
          </section>
        ))
      ) : (
        <div className="grid" role="grid" aria-label="Photos" style={columns}>
          {cells(photos)}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  const total = app.use((s) => s.photos.length);
  return (
    <div className="empty">
      {total ? (
        <>
          <h3>No photos match the current filter</h3>
          <Button onClick={() => app.set((s) => ({ filter: { ...s.filter, text: '', minRating: 0, flag: 'all', label: 'any', source: 'all', collection: null, date: null } }))}>
            Clear filters
          </Button>
        </>
      ) : (
        <>
          <Images size={48} strokeWidth={1.2} />
          <h3>Your catalog is empty</h3>
          <div>Import JPEG, PNG, WebP or camera RAW files (CR2, CR3, NEF, ARW, DNG, RAF, ORF, RW2…).</div>
          <div className="hint">Tip: drag files anywhere onto the window.</div>
          <Button primary onClick={promptImport}>
            <Upload size={14} /> Import photos
          </Button>
        </>
      )}
    </div>
  );
}

function Loupe({ photo }: { photo: Photo | undefined }) {
  if (!photo) return <EmptyState />;
  return (
    <div className="loupe" onDoubleClick={() => openInDevelop(photo.id)}>
      <Thumb photo={photo} />
    </div>
  );
}

function CatalogPanel({ photos, base }: { photos: Photo[]; base: Photo[] }) {
  const filter = app.use((s) => s.filter);
  const all = app.use((s) => s.photos);
  const lastImport = app.use((s) => s.lastImport);
  const collections = app.use((s) => s.collections);
  const collectionSort = app.use((s) => s.collectionSort);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const editedCount = all.filter((p) => isEdited(p.settings) || p.derivedFrom).length;
  const spans = useMemo(() => collectionSpans(all), [all]);
  const sorted = useMemo(() => sortCollections(collections, spans, collectionSort), [collections, spans, collectionSort]);
  const newCollection = async () => {
    const sel = new Set(app.get().selected);
    const name = await promptText('New collection', datedName(all.filter((p) => sel.has(p.id))) ?? `Collection ${collections.length + 1}`, {
      message: sel.size ? `The ${countLabel(sel.size, 'selected photo')} go into it. Drag more photos onto it any time.` : 'Drag photos onto it to add them.',
      okLabel: 'Create',
    });
    if (name?.trim()) await createCollection(name.trim(), [...sel]);
  };
  // When sorted by date, collections are grouped under the year of their newest photo.
  let lastYear: string | null = null;
  return (
    <>
      <div style={{ padding: 10 }}>
        <Button primary onClick={promptImport} className="grow" title="Import photos">
          <Upload size={14} /> Import…
        </Button>
      </div>
      <Panel title="Catalog" id="lib-catalog">
        <ul className="nav-list">
          <li className={cx(filter.source === 'all' && 'active')} onClick={() => setSource('all')}>
            <Images size={14} /> All Photographs <span className="count">{all.length}</span>
          </li>
          <li className={cx(filter.source === 'recent' && 'active')} onClick={() => setSource('recent')}>
            <ImagePlus size={14} /> Previous Import <span className="count">{lastImport.length}</span>
          </li>
          <li className={cx(filter.source === 'edited' && 'active')} onClick={() => setSource('edited')}>
            <SlidersHorizontal size={14} /> Edited <span className="count">{editedCount}</span>
          </li>
        </ul>
      </Panel>
      <DatesPanel photos={base} onCalendar={showCalendar} />
      <Panel
        title="Collections"
        id="lib-collections"
        actions={
          <>
            <IconButton
              title={collectionSort === 'date' ? 'Sorted by date, newest first. Sort by name' : 'Sorted by name. Sort by date'}
              onClick={() => app.set({ collectionSort: collectionSort === 'date' ? 'name' : 'date' })}
            >
              {collectionSort === 'date' ? <CalendarDays size={14} /> : <ArrowDownAZ size={14} />}
            </IconButton>
            <IconButton title="New collection from selection" onClick={newCollection}>
              <FolderPlus size={14} />
            </IconButton>
          </>
        }
      >
        {!collections.length && <div className="hint">Create a collection, then drag photos onto it. Or group the grid by event and name an event.</div>}
        <ul className="nav-list">
          {sorted.map((c) => {
            const span = spans.get(c.id);
            const year = span ? yearKey(span.end) : '';
            const heading = collectionSort === 'date' && year !== lastYear;
            lastYear = year;
            return [
              heading && (
                <li key={`y:${year}`} className="nav-subhead" role="presentation">
                  {year || 'No photos yet'}
                </li>
              ),
              <li
                key={c.id}
                className={cx('coll', filter.source === 'collection' && filter.collection === c.id && 'active', dropTarget === c.id && 'drop-target')}
                title={span ? `${c.name}: ${countLabel(span.count)}, ${formatDateRange(span.start, span.end)}` : c.name}
                onClick={() => setSource('collection', c.id)}
                onDragOver={(e) => {
                  if (e.dataTransfer.types.includes('application/x-lightshop-photos')) {
                    e.preventDefault();
                    setDropTarget(c.id);
                  }
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDropTarget(null);
                  const ids = JSON.parse(e.dataTransfer.getData('application/x-lightshop-photos') || '[]');
                  addToCollection(ids, c.id);
                }}
                onDoubleClick={() => setRenaming(c.id)}
              >
                <Layers size={14} />
                {renaming === c.id ? (
                  <input
                    className="text-input"
                    autoFocus
                    defaultValue={c.name}
                    onBlur={(e) => {
                      renameCollection(c.id, e.target.value.trim() || c.name);
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                  />
                ) : (
                  <span className="coll-text">
                    <span className="coll-name">{c.name}</span>
                    {span && <span className="coll-date">{formatDateRange(span.start, span.end)}</span>}
                  </span>
                )}
                <span className="count">{span?.count ?? 0}</span>
                <button
                  className="icon-btn"
                  style={{ width: 18, height: 18 }}
                  title="Delete collection"
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (await confirmDialog('Delete collection', `Delete "${c.name}"? The photos stay in the catalog.`, { okLabel: 'Delete', danger: true })) deleteCollection(c.id);
                  }}
                >
                  <X size={12} />
                </button>
              </li>,
            ];
          })}
        </ul>
        {filter.source === 'collection' && filter.collection && photos.length > 0 && (
          <Button small onClick={() => removeFromCollection(app.get().selected, filter.collection!)}>
            Remove selected from collection
          </Button>
        )}
      </Panel>
      <Panel title="Quick Develop" id="lib-quick" defaultOpen={false}>
        <div className="hint" style={{ marginBottom: 6 }}>Apply a preset to all selected photos.</div>
        <select
          style={{ width: '100%' }}
          value=""
          onChange={(e) => {
            const all = [...BUILTIN_PRESETS, ...app.get().presets];
            const pr = all.find((x) => x.id === e.target.value);
            if (!pr) return;
            const ids = app.get().selected;
            updatePhotos(ids, (p) => ({ settings: applyPatch(normalizeSettings(p.settings), pr.patch), editedAt: Date.now() }));
            regenerateThumbs(ids);
          }}
          aria-label="Apply preset to selected"
        >
          <option value="">Choose preset…</option>
          {[...BUILTIN_PRESETS, ...app.get().presets].map((p) => (
            <option key={p.id} value={p.id}>
              {p.group} · {p.name}
            </option>
          ))}
        </select>
      </Panel>
    </>
  );
}

/** Re-renders thumbnails for photos whose settings changed outside the Develop view. */
export async function regenerateThumbs(ids: string[]) {
  for (const id of ids) await renderThumbnailFor(id);
}

function useThumbHistogram(p: Photo | undefined): Histogram | null {
  const [h, setH] = useState<Histogram | null>(null);
  useEffect(() => {
    if (!p) return setH(null);
    let live = true;
    thumbUrl(p).then((url) => {
      if (!url || !live) return;
      const img = new Image();
      img.onload = () => {
        if (!live) return;
        const c = document.createElement('canvas');
        const k = Math.min(1, 200 / Math.max(img.width, img.height));
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        const ctx = c.getContext('2d', { willReadFrequently: true })!;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        setH(computeHistogram(ctx.getImageData(0, 0, c.width, c.height).data));
      };
      img.src = url;
    });
    return () => {
      live = false;
    };
  }, [p?.id, p?.thumbVersion]);
  return h;
}

function InfoPanel({ onExport }: { onExport: () => void }) {
  const activeId = app.use((s) => s.activeId);
  const selected = app.use((s) => s.selected);
  const photos = app.use((s) => s.photos);
  const p = photos.find((x) => x.id === activeId);
  const hist = useThumbHistogram(p);
  const [kw, setKw] = useState('');
  const targets = selected.length ? selected : p ? [p.id] : [];
  if (!p)
    return (
      <div className="hist-wrap">
        <HistogramView data={null} />
        <p className="hint">Select a photo to see its details.</p>
      </div>
    );
  const e = p.exif ?? {};
  const rows: [string, string | undefined][] = [
    ['File', p.name],
    ['Dimensions', `${p.width} × ${p.height}${p.isRaw ? ' (embedded preview)' : ''}`],
    ['File size', formatBytes(p.size)],
    ['Captured', p.capturedAt ? new Date(p.capturedAt).toLocaleString() : undefined],
    ['Camera', [e.make, e.model].filter(Boolean).join(' ') || undefined],
    ['Lens', e.lens],
    ['Exposure', [formatShutter(e.exposureTime), e.fNumber ? `ƒ/${+e.fNumber.toFixed(1)}` : undefined, e.iso ? `ISO ${e.iso}` : undefined].filter(Boolean).join('  ') || undefined],
    ['Focal length', e.focalLength ? `${+e.focalLength.toFixed(1)} mm${e.focalLength35 ? ` (${e.focalLength35} mm eq.)` : ''}` : undefined],
    ['Flash', e.flash === undefined ? undefined : e.flash ? 'Fired' : 'Did not fire'],
    ['Software', e.software],
  ];
  return (
    <>
      <div className="hist-wrap">
        <HistogramView data={hist} />
        <div className="hist-info">
          <span>{formatShutter(e.exposureTime) ?? ''}</span>
          <span>{e.fNumber ? `ƒ/${+e.fNumber.toFixed(1)}` : ''}</span>
          <span>{e.iso ? `ISO ${e.iso}` : ''}</span>
          <span>{e.focalLength ? `${Math.round(e.focalLength)} mm` : ''}</span>
        </div>
      </div>
      <Panel title="Actions" id="lib-actions">
        <div className="row wrap">
          <Button small onClick={() => openInDevelop(p.id)} title="Develop (D)">
            <SlidersHorizontal size={13} /> Develop
          </Button>
          <Button small onClick={() => openPhotoInEditor(p.id)} title={`Edit in Editor (${keyLabel('⌘E')})`}>
            <Pencil size={13} /> Edit in Editor
          </Button>
          <Button small onClick={onExport} title={`Export (${keyLabel('⇧⌘E')})`}>
            Export…
          </Button>
          <Button
            small
            onClick={async () => {
              const msg = `Remove ${targets.length} photo${targets.length === 1 ? '' : 's'} and their edits from the LightShop catalog? Files on your disk are not affected.`;
              if (await confirmDialog('Remove from catalog', msg, { okLabel: 'Remove', danger: true })) await deletePhotos(targets);
            }}
          >
            <Trash size={13} /> Remove
          </Button>
        </div>
      </Panel>
      <Panel title="Rating & Labels" id="lib-rating">
        <div className="row" style={{ marginBottom: 8 }}>
          <Stars value={p.rating} onChange={(v) => setRating(targets, v)} size={15} />
        </div>
        <div className="row" style={{ marginBottom: 8 }}>
          <Button small onClick={() => setFlag(targets, p.flag === 1 ? 0 : 1)} className={cx(p.flag === 1 && 'primary')}>
            <Flag size={12} /> Pick
          </Button>
          <Button small onClick={() => setFlag(targets, p.flag === -1 ? 0 : -1)} className={cx(p.flag === -1 && 'primary')}>
            <X size={12} /> Reject
          </Button>
        </div>
        <div className="row">
          {LABELS.map((l) => (
            <button
              key={l}
              className={cx('label-dot', `label-${l}`)}
              style={{ width: 18, height: 18, border: p.label === l ? '2px solid #fff' : '2px solid transparent', padding: 0 }}
              onClick={() => setLabel(targets, l as ColorLabel)}
              aria-label={`${l} label`}
              aria-pressed={p.label === l}
            >
              {p.label === l && <Check size={10} color="#fff" />}
            </button>
          ))}
        </div>
      </Panel>
      <Panel title="Keywords" id="lib-keywords">
        <input
          className="text-input"
          style={{ width: '100%' }}
          placeholder="Add keyword and press Enter"
          value={kw}
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(ev) => {
            ev.stopPropagation();
            if (ev.key === 'Enter' && kw.trim()) {
              const words = kw.split(',').map((w) => w.trim()).filter(Boolean);
              updatePhotos(targets, (x) => ({ keywords: [...new Set([...x.keywords, ...words])] }));
              setKw('');
            }
          }}
          aria-label="Add keyword"
        />
        <div className="keyword-chips">
          {p.keywords.map((k) => (
            <span className="chip" key={k}>
              {k}
              <button aria-label={`Remove ${k}`} onClick={() => updatePhotos(targets, (x) => ({ keywords: x.keywords.filter((y) => y !== k) }))}>
                ×
              </button>
            </span>
          ))}
        </div>
      </Panel>
      <Panel title="Metadata" id="lib-meta">
        <table className="meta-table">
          <tbody>
            {rows
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <tr key={k}>
                  <td>{k}</td>
                  <td>{v}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

export function LibraryView() {
  const { base, sections, ordered: photos } = useLibraryPhotos();
  const view = app.use((s) => s.libraryView);
  const activeId = app.use((s) => s.activeId);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string[] | null>(null);
  const active = photos.find((p) => p.id === activeId);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.modal')) return;
      const s = app.get();
      const sel = s.selected.length ? s.selected : s.activeId ? [s.activeId] : [];
      const idx = photos.findIndex((p) => p.id === s.activeId);
      const k = e.key.toLowerCase();
      // The calendar has no selection; only the view switches apply (its days handle the arrow keys).
      if (s.libraryView === 'calendar') {
        if (modKey(e) || e.altKey) return;
        if (k === 'g' || k === 'escape' || k === 'c') app.set({ libraryView: 'grid' });
        else if (k === 'e') app.set({ libraryView: 'loupe' });
        return;
      }
      if (modKey(e) && k === 'a') {
        e.preventDefault();
        app.set({ selected: photos.map((p) => p.id) });
        return;
      }
      if (modKey(e) && k === 'd') {
        e.preventDefault();
        app.set({ selected: s.activeId ? [s.activeId] : [] });
        return;
      }
      if (modKey(e) && e.shiftKey && k === 'e') {
        e.preventDefault();
        if (sel.length) setExporting(sel);
        return;
      }
      if (modKey(e) && k === 'e') {
        e.preventDefault();
        if (s.activeId) openPhotoInEditor(s.activeId);
        return;
      }
      if (modKey(e) || e.altKey) return;
      if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(k)) {
        e.preventDefault();
        if (!photos.length) return;
        const grid = document.querySelector('.grid') as HTMLElement | null;
        const cols = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').length) : 1;
        const vertical = k === 'arrowup' || k === 'arrowdown';
        let next: Photo | null;
        if (vertical && s.libraryView === 'grid' && sections.length > 1) {
          // Date groups each start a new row, so ↑/↓ steps between them by position.
          next = verticalNeighbour(sections, s.activeId, k === 'arrowdown', cols);
        } else {
          const step = k === 'arrowleft' ? -1 : k === 'arrowright' ? 1 : k === 'arrowup' ? (s.libraryView === 'grid' ? -cols : -1) : s.libraryView === 'grid' ? cols : 1;
          next = photos[Math.min(photos.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + step))];
        }
        if (!next) return;
        if (e.shiftKey) app.set({ activeId: next.id, selected: [...new Set([...s.selected, next.id])] });
        else app.set({ activeId: next.id, selected: [next.id] });
        return;
      }
      if (k >= '0' && k <= '5') return setRating(sel, +k);
      if (k === '6') return setLabel(sel, 'red');
      if (k === '7') return setLabel(sel, 'yellow');
      if (k === '8') return setLabel(sel, 'green');
      if (k === '9') return setLabel(sel, 'blue');
      if (k === 'p') return setFlag(sel, 1);
      if (k === 'x') return setFlag(sel, -1);
      if (k === 'u') return setFlag(sel, 0);
      if (k === 'g') return app.set({ libraryView: 'grid' });
      if (k === 'c') return showCalendar();
      if (k === 'e' || k === ' ') {
        e.preventDefault();
        return app.set({ libraryView: s.libraryView === 'grid' || k === 'e' ? 'loupe' : 'grid' });
      }
      if (k === 'd' && s.activeId) return openInDevelop(s.activeId);
      if ((k === 'delete' || k === 'backspace') && sel.length) {
        e.preventDefault();
        setConfirmDelete(sel);
      }
      if (k === 'enter' && s.activeId) app.set({ libraryView: 'loupe' });
      if (k === 'escape') app.set({ libraryView: 'grid' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [photos, sections]);

  return (
    <div className="lib">
      <aside className="side left">
        <CatalogPanel photos={photos} base={base} />
      </aside>
      <main className="lib-center">
        <FilterBar />
        {view === 'calendar' ? (
          base.length ? <CalendarView photos={base} /> : <EmptyState />
        ) : view === 'grid' ? (
          <Grid sections={sections} photos={photos} />
        ) : (
          <Loupe photo={active ?? photos[0]} />
        )}
      </main>
      <aside className="side right">
        <InfoPanel onExport={() => setExporting(app.get().selected.length ? app.get().selected : activeId ? [activeId] : [])} />
      </aside>
      {exporting && <ExportDialog ids={exporting} onClose={() => setExporting(null)} />}
      {confirmDelete && (
        <Modal
          title="Remove from catalog"
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button
                primary
                onClick={async () => {
                  await deletePhotos(confirmDelete);
                  setConfirmDelete(null);
                }}
              >
                Remove {confirmDelete.length}
              </Button>
            </>
          }
        >
          Remove {confirmDelete.length} photo{confirmDelete.length === 1 ? '' : 's'} and their edits from the LightShop catalog? Files on your disk are not affected.
        </Modal>
      )}
    </div>
  );
}
