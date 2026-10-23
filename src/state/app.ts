// Global application state: catalog (photos, collections, presets), library view state, toasts.

import { dayKey } from '../lib/dates';
import { dbDelete, dbDeleteMany, dbGet, dbGetAll, dbPut, requestPersistence } from '../lib/db';
import { ExifSummary, parseExifDate, parseJpegExif } from '../lib/exif';
import { SUPPORTED_IMAGE_EXT, decodeImage, makeThumbnail, mimeFor } from '../lib/imageio';
import { extractRawPreview, isRawName } from '../lib/raw';
import { debounce, extOf, uid } from '../lib/util';
import { isEdited, type DevelopSettings, type Preset } from '../develop/settings';
import { createStore } from './store';

export type Flag = 0 | 1 | -1;
export type ColorLabel = '' | 'red' | 'yellow' | 'green' | 'blue' | 'purple';
export const LABELS: ColorLabel[] = ['red', 'yellow', 'green', 'blue', 'purple'];
export type Module = 'library' | 'develop' | 'editor';

export interface Photo {
  id: string;
  name: string;
  type: string;
  isRaw: boolean;
  size: number;
  width: number;
  height: number;
  importedAt: number;
  capturedAt?: number;
  exif?: ExifSummary;
  rating: number;
  flag: Flag;
  label: ColorLabel;
  keywords: string[];
  collections: string[];
  settings: DevelopSettings | null;
  editedAt?: number;
  /** Set for images produced by the editor: id of the photo they were derived from. */
  derivedFrom?: string;
  /** Layered editor project stored under the same id in the `projects` store. */
  hasProject?: boolean;
  /** Orientation that must be applied manually (RAW previews have their EXIF stripped). */
  orientation?: number;
  thumbVersion: number;
}

export interface Collection {
  id: string;
  name: string;
  createdAt: number;
}

export interface Toast {
  id: string;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface LibraryFilter {
  text: string;
  minRating: number;
  flag: 'all' | 'picked' | 'rejected' | 'unflagged';
  label: ColorLabel | 'any';
  source: 'all' | 'recent' | 'edited' | 'collection';
  collection: string | null;
  /** Capture date: a year, month or day key ('2026', '2026-03', '2026-03-14'; see lib/dates). */
  date: string | null;
}

export type SortKey = 'captured' | 'imported' | 'name' | 'rating';
/** How the Library grid is split into sections. */
export type GroupBy = 'none' | 'event' | 'day' | 'month' | 'year';
export type LibraryViewMode = 'grid' | 'loupe' | 'calendar';

export interface AppState {
  ready: boolean;
  module: Module;
  photos: Photo[];
  collections: Collection[];
  presets: Preset[];
  activeId: string | null;
  selected: string[];
  filter: LibraryFilter;
  sort: SortKey;
  sortDesc: boolean;
  libraryView: LibraryViewMode;
  groupBy: GroupBy;
  /** Events: a new one starts after a gap of more than this many hours between photos. */
  eventGapHours: number;
  collectionSort: 'date' | 'name';
  calendarMode: 'month' | 'year';
  /** Month the calendar shows ('YYYY-MM'); null = the month of the newest photo. */
  calendarMonth: string | null;
  thumbSize: number;
  importing: { done: number; total: number; current: string } | null;
  lastImport: string[];
  toasts: Toast[];
  clipboard: Partial<DevelopSettings> | null;
}

// Library organisation preferences, kept between sessions.
const PREFS_KEY = 'ls.library.prefs';
type LibraryPrefs = Pick<AppState, 'groupBy' | 'eventGapHours' | 'collectionSort' | 'calendarMode'>;
const GROUPINGS: GroupBy[] = ['none', 'event', 'day', 'month', 'year'];
export const EVENT_GAPS = [1, 2, 3, 6, 12, 24];

function loadPrefs(): LibraryPrefs {
  let v: Partial<LibraryPrefs> = {};
  try {
    v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') ?? {};
  } catch {
    /* ignore a damaged value */
  }
  return {
    groupBy: GROUPINGS.includes(v.groupBy as GroupBy) ? (v.groupBy as GroupBy) : 'event',
    eventGapHours: EVENT_GAPS.includes(v.eventGapHours as number) ? (v.eventGapHours as number) : 3,
    collectionSort: v.collectionSort === 'name' ? 'name' : 'date',
    calendarMode: v.calendarMode === 'year' ? 'year' : 'month',
  };
}

export const app = createStore<AppState>({
  ready: false,
  module: 'library',
  photos: [],
  collections: [],
  presets: [],
  activeId: null,
  selected: [],
  filter: { text: '', minRating: 0, flag: 'all', label: 'any', source: 'all', collection: null, date: null },
  sort: 'captured',
  sortDesc: false,
  libraryView: 'grid',
  ...loadPrefs(),
  calendarMonth: null,
  thumbSize: 190,
  importing: null,
  lastImport: [],
  toasts: [],
  clipboard: null,
});

{
  const pick = (s: AppState): LibraryPrefs => ({ groupBy: s.groupBy, eventGapHours: s.eventGapHours, collectionSort: s.collectionSort, calendarMode: s.calendarMode });
  let saved = JSON.stringify(pick(app.get()));
  app.subscribe(() => {
    const next = JSON.stringify(pick(app.get()));
    if (next === saved) return;
    saved = next;
    try {
      localStorage.setItem(PREFS_KEY, next);
    } catch {
      /* storage full or unavailable: the preference just isn't remembered */
    }
  });
}

// ---------------------------------------------------------------- toasts
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3500) {
  const t: Toast = { id: uid('t'), text, kind };
  app.set((s) => ({ toasts: [...s.toasts, t] }));
  setTimeout(() => app.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), ms);
}

// ---------------------------------------------------------------- init
export async function initApp() {
  await requestPersistence();
  const [photos, collections, presets] = await Promise.all([
    dbGetAll<Photo>('photos'),
    dbGetAll<Collection>('collections'),
    dbGetAll<Preset>('presets'),
  ]);
  photos.sort((a, b) => a.importedAt - b.importedAt);
  for (const p of photos) {
    p.thumbVersion ??= 0;
    p.keywords ??= [];
    p.collections ??= [];
  }
  collections.sort((a, b) => a.createdAt - b.createdAt);
  app.set({ ready: true, photos, collections, presets, activeId: photos[0]?.id ?? null });
}

// ---------------------------------------------------------------- thumbnails
const thumbUrls = new Map<string, { v: number; url: string }>();
const thumbWaiters = new Map<string, Promise<string | null>>();

export function thumbUrl(p: Photo): Promise<string | null> {
  const cached = thumbUrls.get(p.id);
  if (cached && cached.v === p.thumbVersion) return Promise.resolve(cached.url);
  const key = `${p.id}:${p.thumbVersion}`;
  let w = thumbWaiters.get(key);
  if (!w) {
    w = dbGet<{ id: string; blob: Blob }>('thumbs', p.id).then((rec) => {
      thumbWaiters.delete(key);
      if (!rec) return null;
      const old = thumbUrls.get(p.id);
      if (old) URL.revokeObjectURL(old.url);
      const url = URL.createObjectURL(rec.blob);
      thumbUrls.set(p.id, { v: p.thumbVersion, url });
      return url;
    });
    thumbWaiters.set(key, w);
  }
  return w;
}

export function cachedThumb(p: Photo): string | null {
  const c = thumbUrls.get(p.id);
  return c && c.v === p.thumbVersion ? c.url : null;
}

export async function setThumbnail(id: string, blob: Blob) {
  await dbPut('thumbs', { id, blob });
  const p = getPhoto(id);
  if (p) updatePhoto(id, { thumbVersion: (p.thumbVersion ?? 0) + 1 });
}

// ---------------------------------------------------------------- photo CRUD
export const getPhoto = (id: string | null | undefined) => (id ? app.get().photos.find((p) => p.id === id) : undefined);

const persistQueue = new Map<string, Photo>();
const flushPersist = debounce(async () => {
  const items = [...persistQueue.values()];
  persistQueue.clear();
  for (const p of items) await dbPut('photos', p);
}, 300);

export function updatePhoto(id: string, patch: Partial<Photo>) {
  let updated: Photo | undefined;
  app.set((s) => ({
    photos: s.photos.map((p) => (p.id === id ? (updated = { ...p, ...patch }) : p)),
  }));
  if (updated) {
    persistQueue.set(id, updated);
    flushPersist();
  }
}

export function updatePhotos(ids: string[], f: (p: Photo) => Partial<Photo>) {
  const set = new Set(ids);
  const changed: Photo[] = [];
  app.set((s) => ({
    photos: s.photos.map((p) => {
      if (!set.has(p.id)) return p;
      const n = { ...p, ...f(p) };
      changed.push(n);
      return n;
    }),
  }));
  for (const p of changed) persistQueue.set(p.id, p);
  flushPersist();
}

export const setRating = (ids: string[], rating: number) => updatePhotos(ids, () => ({ rating }));
export const setFlag = (ids: string[], flag: Flag) => updatePhotos(ids, () => ({ flag }));
export const setLabel = (ids: string[], label: ColorLabel) =>
  updatePhotos(ids, (p) => ({ label: p.label === label ? '' : label }));

export function saveSettings(id: string, settings: DevelopSettings) {
  updatePhoto(id, { settings, editedAt: Date.now() });
}

export async function deletePhotos(ids: string[]) {
  for (const id of ids) {
    await dbDeleteMany(['photos', 'files', 'thumbs', 'projects'], id);
    const t = thumbUrls.get(id);
    if (t) URL.revokeObjectURL(t.url);
    thumbUrls.delete(id);
  }
  const set = new Set(ids);
  app.set((s) => {
    const photos = s.photos.filter((p) => !set.has(p.id));
    return {
      photos,
      selected: s.selected.filter((x) => !set.has(x)),
      activeId: s.activeId && set.has(s.activeId) ? (photos[0]?.id ?? null) : s.activeId,
    };
  });
}

export async function getWorkingBlob(id: string): Promise<Blob | null> {
  const rec = await dbGet<{ id: string; blob: Blob }>('files', id);
  return rec?.blob ?? null;
}

/** Decodes a photo's working image (orientation applied). */
export async function loadPhotoImage(p: Photo, maxSize?: number) {
  const blob = await getWorkingBlob(p.id);
  if (!blob) throw new Error(`Image data for ${p.name} is missing`);
  return decodeImage(blob, { maxSize, manualOrientation: p.orientation });
}

// ---------------------------------------------------------------- import
export const IMPORT_ACCEPT = [
  ...SUPPORTED_IMAGE_EXT.map((e) => `.${e}`),
  '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng', '.orf', '.rw2', '.raf', '.pef', '.srw', '.erf', '.3fr', '.kdc', '.dcr', '.mrw', '.iiq', '.rwl',
  'image/*',
].join(',');

export function isImportable(f: File): boolean {
  const ext = extOf(f.name);
  return SUPPORTED_IMAGE_EXT.includes(ext) || isRawName(f.name) || f.type.startsWith('image/');
}

export async function importFiles(files: File[]): Promise<string[]> {
  const list = files.filter(isImportable);
  if (!list.length) {
    toast('No supported images found. LightShop imports JPEG, PNG, WebP, AVIF, GIF and camera RAW files.', 'error', 5000);
    return [];
  }
  const existing = new Set(app.get().photos.map((p) => `${p.name}|${p.size}`));
  const imported: string[] = [];
  let skipped = 0;
  const failed: string[] = [];
  app.set({ importing: { done: 0, total: list.length, current: list[0].name } });
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    app.set({ importing: { done: i, total: list.length, current: f.name } });
    if (existing.has(`${f.name}|${f.size}`)) {
      skipped++;
      continue;
    }
    try {
      const p = await importOne(f);
      imported.push(p.id);
      existing.add(`${f.name}|${f.size}`);
      app.set((s) => ({ photos: [...s.photos, p] }));
    } catch (e) {
      console.error('Import failed', f.name, e);
      failed.push(f.name);
    }
  }
  app.set((s) => ({
    importing: null,
    lastImport: imported.length ? imported : s.lastImport,
    selected: imported.length ? imported.slice(0, 1) : s.selected,
    activeId: imported[0] ?? s.activeId,
  }));
  const parts = [`Imported ${imported.length} photo${imported.length === 1 ? '' : 's'}`];
  if (skipped) parts.push(`${skipped} duplicate${skipped === 1 ? '' : 's'} skipped`);
  if (failed.length) parts.push(`${failed.length} failed (${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''})`);
  toast(parts.join(' · '), failed.length ? 'error' : 'success', 5000);
  return imported;
}

async function importOne(f: File): Promise<Photo> {
  const id = uid('p');
  const raw = isRawName(f.name);
  let blob: Blob = f;
  let exif: ExifSummary | undefined;
  let orientation: number | undefined;
  if (raw) {
    const buf = await f.arrayBuffer();
    const prev = extractRawPreview(buf);
    if (!prev) throw new Error('No embedded preview found in RAW file');
    blob = prev.blob;
    exif = prev.exif;
    orientation = prev.orientation;
  } else {
    const ext = extOf(f.name);
    if (f.type === 'image/jpeg' || ext === 'jpg' || ext === 'jpeg') {
      exif = parseJpegExif(await f.slice(0, 256 * 1024).arrayBuffer()) ?? undefined;
    }
    if (!f.type) blob = new Blob([f], { type: mimeFor(ext) });
  }
  const img = await decodeImage(blob, { manualOrientation: orientation });
  const thumb = await makeThumbnail(img, 480);
  const width = img.width;
  const height = img.height;
  if ('close' in img) img.close();
  await dbPut('files', { id, blob });
  await dbPut('thumbs', { id, blob: thumb });
  const photo: Photo = {
    id,
    name: f.name,
    type: blob.type || f.type,
    isRaw: raw,
    size: f.size,
    width,
    height,
    importedAt: Date.now(),
    capturedAt: parseExifDate(exif?.dateTaken) ?? f.lastModified,
    exif,
    rating: 0,
    flag: 0,
    label: '',
    keywords: [],
    collections: [],
    settings: null,
    orientation: orientation && orientation !== 1 ? orientation : undefined,
    thumbVersion: 0,
  };
  await dbPut('photos', photo);
  return photo;
}

/** Adds an image produced elsewhere in the app (editor round-trip) to the catalog. */
export async function addGeneratedPhoto(
  blob: Blob,
  name: string,
  width: number,
  height: number,
  opts: { derivedFrom?: string; project?: unknown; replaceId?: string } = {},
): Promise<Photo> {
  const id = opts.replaceId ?? uid('p');
  const img = await decodeImage(blob);
  const thumb = await makeThumbnail(img, 480);
  if ('close' in img) img.close();
  await dbPut('files', { id, blob });
  await dbPut('thumbs', { id, blob: thumb });
  if (opts.project) await dbPut('projects', { id, project: opts.project });
  const prev = getPhoto(id);
  const source = getPhoto(opts.derivedFrom);
  const photo: Photo = {
    ...(prev ?? {
      id,
      importedAt: Date.now(),
      rating: source?.rating ?? 0,
      flag: 0 as Flag,
      label: source?.label ?? '',
      keywords: source?.keywords ?? [],
      collections: source?.collections ?? [],
      capturedAt: source?.capturedAt ?? Date.now(),
      exif: source?.exif,
    }),
    id,
    name,
    type: blob.type,
    isRaw: false,
    size: blob.size,
    width,
    height,
    settings: null,
    derivedFrom: opts.derivedFrom ?? prev?.derivedFrom,
    hasProject: !!opts.project || prev?.hasProject,
    orientation: undefined,
    thumbVersion: (prev?.thumbVersion ?? 0) + 1,
  };
  await dbPut('photos', photo);
  app.set((s) => ({
    photos: prev ? s.photos.map((p) => (p.id === id ? photo : p)) : [...s.photos, photo],
  }));
  return photo;
}

export async function loadProject(id: string): Promise<unknown | null> {
  const rec = await dbGet<{ id: string; project: unknown }>('projects', id);
  return rec?.project ?? null;
}

// ---------------------------------------------------------------- collections
export async function createCollection(name: string, ids: string[] = []): Promise<Collection> {
  const c: Collection = { id: uid('c'), name, createdAt: Date.now() };
  await dbPut('collections', c);
  app.set((s) => ({ collections: [...s.collections, c] }));
  if (ids.length) addToCollection(ids, c.id);
  return c;
}

export async function renameCollection(id: string, name: string) {
  const c = app.get().collections.find((x) => x.id === id);
  if (!c) return;
  const n = { ...c, name };
  await dbPut('collections', n);
  app.set((s) => ({ collections: s.collections.map((x) => (x.id === id ? n : x)) }));
}

export async function deleteCollection(id: string) {
  await dbDelete('collections', id);
  const members = app.get().photos.filter((p) => p.collections.includes(id)).map((p) => p.id);
  updatePhotos(members, (p) => ({ collections: p.collections.filter((c) => c !== id) }));
  app.set((s) => ({
    collections: s.collections.filter((x) => x.id !== id),
    filter: s.filter.collection === id ? { ...s.filter, source: 'all', collection: null } : s.filter,
  }));
}

export function addToCollection(ids: string[], cid: string) {
  updatePhotos(ids, (p) => ({ collections: p.collections.includes(cid) ? p.collections : [...p.collections, cid] }));
}

export function removeFromCollection(ids: string[], cid: string) {
  updatePhotos(ids, (p) => ({ collections: p.collections.filter((c) => c !== cid) }));
}

// ---------------------------------------------------------------- presets
export async function savePreset(p: Preset) {
  await dbPut('presets', p);
  app.set((s) => ({ presets: [...s.presets.filter((x) => x.id !== p.id), p] }));
}

export async function deletePreset(id: string) {
  await dbDelete('presets', id);
  app.set((s) => ({ presets: s.presets.filter((x) => x.id !== id) }));
}

// ---------------------------------------------------------------- filtering
/** When a photo was taken (falls back to when it was imported). */
export const photoTime = (p: Photo) => p.capturedAt ?? p.importedAt;
/** Whether a photo was taken in the year, month or day a date key names. */
export const matchesDate = (p: Photo, key: string) => dayKey(photoTime(p)).startsWith(key);

/** Shows the photos of one year, month or day ('2026', '2026-03', '2026-03-14') in the grid. */
export function openDate(key: string) {
  app.set((s) => ({ filter: { ...s.filter, date: key }, libraryView: 'grid' }));
}

export function filterPhotos(s: Pick<AppState, 'photos' | 'filter' | 'sort' | 'sortDesc' | 'lastImport'>): Photo[] {
  const f = s.filter;
  const text = f.text.trim().toLowerCase();
  const recent = new Set(s.lastImport);
  let list = s.photos.filter((p) => {
    if (f.source === 'recent' && !recent.has(p.id)) return false;
    if (f.source === 'edited' && !isEdited(p.settings) && !p.derivedFrom) return false;
    if (f.source === 'collection' && (!f.collection || !p.collections.includes(f.collection))) return false;
    if (p.rating < f.minRating) return false;
    if (f.flag === 'picked' && p.flag !== 1) return false;
    if (f.flag === 'rejected' && p.flag !== -1) return false;
    if (f.flag === 'unflagged' && p.flag !== 0) return false;
    if (f.label !== 'any' && p.label !== f.label) return false;
    if (text) {
      const hay = [p.name, p.exif?.make, p.exif?.model, p.exif?.lens, ...p.keywords].join(' ').toLowerCase();
      if (!hay.includes(text)) return false;
    }
    if (f.date && !matchesDate(p, f.date)) return false;
    return true;
  });
  const dir = s.sortDesc ? -1 : 1;
  const key = s.sort;
  list = [...list].sort((a, b) => {
    let d = 0;
    if (key === 'name') d = a.name.localeCompare(b.name, undefined, { numeric: true });
    else if (key === 'rating') d = a.rating - b.rating;
    else if (key === 'imported') d = a.importedAt - b.importedAt;
    else d = photoTime(a) - photoTime(b);
    if (d === 0) d = a.importedAt - b.importedAt;
    return d * dir;
  });
  return list;
}

export function setModule(module: Module) {
  app.set({ module });
}

export function openInDevelop(id: string) {
  app.set({ activeId: id, module: 'develop', selected: [id] });
}
