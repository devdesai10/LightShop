// Develop module state: current photo settings, edit history (per photo, per session), tools, view.

import { createStore } from '../state/store';
import { app, getPhoto, saveSettings } from '../state/app';
import { debounce, deepClone, deepEqual } from '../lib/util';
import type { Histogram } from './renderer';
import { DevelopSettings, Preset, SpotMode, defaultSettings, normalizeSettings } from './settings';

export type DevTool = 'none' | 'crop' | 'wb' | 'masks' | 'spots';

/** 'fit' fits the photo to the view; a number is device pixels per full-resolution pixel (1 = 1:1). */
export type DevZoom = 'fit' | number;

/** Set by the Develop view: moves the view so the photo point (u, v) is centred (Navigator clicks). */
let navigateHandler: ((u: number, v: number, zoomIfFit: boolean) => void) | null = null;
export function setNavigateHandler(f: typeof navigateHandler) {
  navigateHandler = f;
}
export function navigateTo(u: number, v: number, zoomIfFit: boolean) {
  navigateHandler?.(u, v, zoomIfFit);
}

/** Settings for new touch-up spots (also edited from the panel when no spot is selected). */
export interface SpotOptions {
  mode: SpotMode;
  /** Brush radius as a fraction of the photo's long edge. */
  size: number;
  feather: number;
  opacity: number;
  darken: number;
}

// Defined before the store below, which reads them at module load.
const DEFAULT_SPOT_OPTS: SpotOptions = { mode: 'heal', size: 0.012, feather: 40, opacity: 100, darken: 50 };

function loadSpotOpts(): SpotOptions {
  try {
    const o = { ...DEFAULT_SPOT_OPTS, ...JSON.parse(localStorage.getItem('ls.spotopts') ?? '{}') } as SpotOptions;
    if (!['heal', 'clone', 'redeye'].includes(o.mode)) o.mode = 'heal';
    o.size = Math.min(0.25, Math.max(0.001, Number(o.size) || DEFAULT_SPOT_OPTS.size));
    for (const k of ['feather', 'opacity', 'darken'] as const) o[k] = Math.min(100, Math.max(0, Number(o[k]) || 0));
    return o;
  } catch {
    return { ...DEFAULT_SPOT_OPTS };
  }
}

export interface HistoryStep {
  label: string;
  settings: DevelopSettings;
}

export interface DevState {
  photoId: string | null;
  settings: DevelopSettings;
  history: HistoryStep[];
  hIndex: number;
  tool: DevTool;
  activeMask: string | null;
  /** Selected touch-up spot. */
  activeSpot: string | null;
  spotOpts: SpotOptions;
  zoom: DevZoom;
  /** Offset of the zoomed image from centred, in device pixels. */
  pan: [number, number];
  /** Device pixels per full-resolution pixel as currently shown (also in Fit), for the zoom readout. */
  viewScale: number;
  /** Visible part of the photo in crop-out coordinates (0..1) when zoomed in; null when all of it shows. */
  viewRect: { x: number; y: number; w: number; h: number } | null;
  before: boolean;
  preview: Preset | null;
  loading: boolean;
  histogram: Histogram | null;
  navigator: ImageData | null;
}

export const dev = createStore<DevState>({
  photoId: null,
  settings: defaultSettings(),
  history: [],
  hIndex: -1,
  tool: 'none',
  activeMask: null,
  activeSpot: null,
  spotOpts: loadSpotOpts(),
  zoom: 'fit',
  pan: [0, 0],
  viewScale: 1,
  viewRect: null,
  before: false,
  preview: null,
  loading: false,
  histogram: null,
  navigator: null,
});

const sessions = new Map<string, { history: HistoryStep[]; hIndex: number }>();

const persist = debounce((id: string, s: DevelopSettings) => {
  saveSettings(id, s);
  onPersisted?.(id, s);
}, 400);

/** Hook set by the view to regenerate thumbnails after edits are saved. */
let onPersisted: ((id: string, s: DevelopSettings) => void) | null = null;
export function setPersistListener(f: typeof onPersisted) {
  onPersisted = f;
}

export function loadDevelopPhoto(id: string) {
  const cur = dev.get();
  if (cur.photoId) sessions.set(cur.photoId, { history: cur.history, hIndex: cur.hIndex });
  const p = getPhoto(id);
  const settings = normalizeSettings(p?.settings);
  const sess = sessions.get(id) ?? { history: [{ label: p?.settings ? 'Open (saved edits)' : 'Import', settings: deepClone(settings) }], hIndex: 0 };
  dev.set({ photoId: id, settings, history: sess.history, hIndex: sess.hIndex, activeMask: null, activeSpot: null, preview: null, before: false });
}

/** Live update without a history step (slider drag). */
export function liveSettings(settings: DevelopSettings) {
  dev.set({ settings });
}

/** Commits current/new settings as a history step and persists to the catalog. */
export function commitSettings(label: string, settings = dev.get().settings) {
  const s = dev.get();
  const last = s.history[s.hIndex];
  if (last && deepEqual(last.settings, settings)) {
    if (settings !== s.settings) dev.set({ settings });
    return;
  }
  const history = [...s.history.slice(0, s.hIndex + 1), { label, settings: deepClone(settings) }].slice(-200);
  dev.set({ settings, history, hIndex: history.length - 1 });
  if (s.photoId) persist(s.photoId, settings);
}

export function jumpHistory(i: number) {
  const s = dev.get();
  const step = s.history[i];
  if (!step) return;
  const settings = deepClone(step.settings);
  dev.set({ hIndex: i, settings });
  if (s.photoId) persist(s.photoId, settings);
}

export const undoDevelop = () => jumpHistory(dev.get().hIndex - 1);
export const redoDevelop = () => jumpHistory(dev.get().hIndex + 1);

/** Applies an updater to the current settings and commits it. */
export function updateSettings(label: string, f: (s: DevelopSettings) => void, commit = true) {
  const next = deepClone(dev.get().settings);
  f(next);
  if (commit) commitSettings(label, next);
  else liveSettings(next);
}

export function flushDevelop() {
  persist.cancel();
  const s = dev.get();
  if (s.photoId) {
    const p = getPhoto(s.photoId);
    const saved = normalizeSettings(p?.settings);
    if (!deepEqual(saved, s.settings)) {
      saveSettings(s.photoId, s.settings);
      onPersisted?.(s.photoId, s.settings);
    }
  }
}

/** Copies the look only: geometry, masks and touch-up spots are specific to the photo. */
export function copySettings() {
  const { crop: _c, orient: _o, masks: _m, spots: _s, ...rest } = deepClone(dev.get().settings);
  app.set({ clipboard: rest });
}

// ---------------------------------------------------------------- touch up
export function setSpotOpts(patch: Partial<SpotOptions>) {
  const spotOpts = { ...dev.get().spotOpts, ...patch };
  localStorage.setItem('ls.spotopts', JSON.stringify(spotOpts));
  dev.set({ spotOpts });
}
