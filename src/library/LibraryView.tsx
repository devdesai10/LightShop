import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Flag, FolderPlus, Grid2x2, Image as ImageIcon, ImagePlus, Images, Layers, Pencil, Search, SlidersHorizontal, Trash, Upload, X,
} from 'lucide-react';
import {
  AppState, ColorLabel, LABELS, Photo, addToCollection, app, cachedThumb, createCollection, deleteCollection, deletePhotos, filterPhotos,
  importFiles, IMPORT_ACCEPT, openInDevelop, removeFromCollection, renameCollection, setFlag, setLabel, setRating, thumbUrl, updatePhotos,
} from '../state/app';
import { formatShutter } from '../lib/exif';
import { formatBytes, isTypingTarget, modKey, pickFiles } from '../lib/util';
import { Button, IconButton, Modal, Panel, Segmented, Stars, cx } from '../ui/controls';
import { ExportDialog } from '../ui/ExportDialog';
import { HistogramView } from '../ui/widgets';
import { computeHistogram, Histogram } from '../develop/renderer';
import { BUILTIN_PRESETS, applyPatch, normalizeSettings, isEdited } from '../develop/settings';
import { openPhotoInEditor } from '../editor/session';
import { renderThumbnailFor } from '../develop/thumbs';
import { confirmDialog, promptText } from '../ui/dialogs';
import { wheelDelta, wheelZoomFactor } from '../lib/gestures';

const THUMB_MIN = 110;
const THUMB_MAX = 340;

export function useVisiblePhotos(): Photo[] {
  const photos = app.use((s) => s.photos);
  const filter = app.use((s) => s.filter);
  const sort = app.use((s) => s.sort);
  const sortDesc = app.use((s) => s.sortDesc);
  const lastImport = app.use((s) => s.lastImport);
  return useMemo(() => filterPhotos({ photos, filter, sort, sortDesc, lastImport }), [photos, filter, sort, sortDesc, lastImport]);
}

export function Thumb({ photo, className }: { photo: Photo; className?: string }) {
  const [url, setUrl] = useState<string | null>(() => cachedThumb(photo));
  useEffect(() => {
    let live = true;
    thumbUrl(photo).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [photo.id, photo.thumbVersion]);
  return url ? <img src={url} alt={photo.name} className={className} draggable={false} /> : <div className={cx('thumb-placeholder', className)} />;
}

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

function FilterBar() {
  const filter = app.use((s) => s.filter);
  const sort = app.use((s) => s.sort);
  const sortDesc = app.use((s) => s.sortDesc);
  const view = app.use((s) => s.libraryView);
  const size = app.use((s) => s.thumbSize);
  const setF = (p: Partial<AppState['filter']>) => app.set((s) => ({ filter: { ...s.filter, ...p } }));
  return (
    <div className="filterbar">
      <div className="row">
        <Search size={14} className="muted" />
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
      </div>
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
      <div className="grow" />
      <select value={sort} onChange={(e) => app.set({ sort: e.target.value as AppState['sort'] })} aria-label="Sort by">
        <option value="captured">Capture time</option>
        <option value="imported">Import time</option>
        <option value="name">File name</option>
        <option value="rating">Rating</option>
      </select>
      <IconButton title={sortDesc ? 'Descending' : 'Ascending'} onClick={() => app.set({ sortDesc: !sortDesc })}>
        <span style={{ fontSize: 13 }}>{sortDesc ? '↓' : '↑'}</span>
      </IconButton>
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
      <Segmented
        value={view}
        onChange={(libraryView) => app.set({ libraryView })}
        options={[
          { value: 'grid', label: <Grid2x2 size={13} />, title: 'Grid (G)' },
          { value: 'loupe', label: <ImageIcon size={13} />, title: 'Loupe (E)' },
        ]}
      />
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

function Grid({ photos }: { photos: Photo[] }) {
  const selected = app.use((s) => s.selected);
  const activeId = app.use((s) => s.activeId);
  const size = app.use((s) => s.thumbSize);
  const sel = useMemo(() => new Set(selected), [selected]);
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
  return (
    <div className="grid-scroll" ref={ref} data-cols>
      <div className="grid" role="grid" aria-label="Photos" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${size}px, 1fr))` }}>
        {photos.map((p) => (
          <GridCell key={p.id} p={p} selected={sel.has(p.id)} active={p.id === activeId} onClick={(e) => click(p, e)} onDouble={() => openInDevelop(p.id)} />
        ))}
      </div>
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
          <Button onClick={() => app.set((s) => ({ filter: { ...s.filter, text: '', minRating: 0, flag: 'all', label: 'any', source: 'all', collection: null } }))}>Clear filters</Button>
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

function CatalogPanel({ photos }: { photos: Photo[] }) {
  const filter = app.use((s) => s.filter);
  const all = app.use((s) => s.photos);
  const lastImport = app.use((s) => s.lastImport);
  const collections = app.use((s) => s.collections);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const setSource = (source: AppState['filter']['source'], collection: string | null = null) =>
    app.set((s) => ({ filter: { ...s.filter, source, collection } }));
  const editedCount = all.filter((p) => isEdited(p.settings) || p.derivedFrom).length;
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
      <Panel
        title="Collections"
        id="lib-collections"
        actions={
          <IconButton title="New collection from selection" onClick={async () => {
            const name = await promptText('New collection', `Collection ${collections.length + 1}`, { okLabel: 'Create' });
            if (name?.trim()) await createCollection(name.trim(), app.get().selected);
          }}>
            <FolderPlus size={14} />
          </IconButton>
        }
      >
        {!collections.length && <div className="hint">Create a collection, then drag photos onto it.</div>}
        <ul className="nav-list">
          {collections.map((c) => {
            const count = all.filter((p) => p.collections.includes(c.id)).length;
            return (
              <li
                key={c.id}
                className={cx(filter.source === 'collection' && filter.collection === c.id && 'active', dropTarget === c.id && 'drop-target')}
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
                  <span>{c.name}</span>
                )}
                <span className="count">{count}</span>
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
              </li>
            );
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
          <Button small onClick={() => openPhotoInEditor(p.id)} title="Edit in Editor (⌘E)">
            <Pencil size={13} /> Edit in Editor
          </Button>
          <Button small onClick={onExport} title="Export (⇧⌘E)">
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
  const photos = useVisiblePhotos();
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
        const step = k === 'arrowleft' ? -1 : k === 'arrowright' ? 1 : k === 'arrowup' ? (s.libraryView === 'grid' ? -cols : -1) : s.libraryView === 'grid' ? cols : 1;
        const next = photos[Math.min(photos.length - 1, Math.max(0, (idx < 0 ? 0 : idx) + step))];
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
  }, [photos]);

  return (
    <div className="lib">
      <aside className="side left">
        <CatalogPanel photos={photos} />
      </aside>
      <main className="lib-center">
        <FilterBar />
        {view === 'grid' ? <Grid photos={photos} /> : <Loupe photo={active ?? photos[0]} />}
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
