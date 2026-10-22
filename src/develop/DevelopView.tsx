import { useEffect, useRef, useState } from 'react';
import {
  Bandage, ChevronLeft, ChevronRight, Circle, ClipboardPaste, Copy, Crop, Download, FlipHorizontal, FlipVertical, Pencil, Pipette, RefreshCw,
  RotateCcw, RotateCw, SquareSplitHorizontal, Trash, X,
} from 'lucide-react';
import { app, getPhoto, loadPhotoImage, setFlag, setRating, toast } from '../state/app';
import { fitCanvas } from '../lib/imageio';
import { wbForNeutral } from '../lib/color';
import { deepClone, isTypingTarget, modKey, uid } from '../lib/util';
import { Button, IconButton, Panel, Segmented, Slider, Stars, cx } from '../ui/controls';
import { ExportDialog } from '../ui/ExportDialog';
import { HistogramView } from '../ui/widgets';
import { Thumb, useVisiblePhotos } from '../library/LibraryView';
import { openPhotoInEditor } from '../editor/session';
import { AdjustmentPanels, DevPanelProps } from './DevelopPanels';
import { HistoryPanel, NavigatorPanel, PresetsPanel } from './LeftPanels';
import { sampleAt } from './auto';
import { Rect, constrainCrop, cropOutSize, fitRect, maxCrop, orientedSize } from './geometry';
import {
  SpotPart, ViewGeom, drawCrop, drawMasks, drawSpots, fitToward, hitCrop, hitSpot, maskHandles, resizeRect, screenScale, screenToSource, toView, Handle,
} from './overlays';
import { DevelopRenderer, computeHistogram, mountRenderer, unmountRenderer } from './renderer';
import { simplifyPath } from './retouch';
import { DevelopSettings, LocalAdjust, RetouchSpot, SpotMode, applyPatch, defaultSettings, newMask } from './settings';
import {
  DevTool, DevZoom, SpotOptions, commitSettings, copySettings, dev, flushDevelop, liveSettings, loadDevelopPhoto, redoDevelop, setNavigateHandler, setPersistListener,
  setSpotOpts, undoDevelop, updateSettings,
} from './state';
import { attachViewGestures } from '../lib/gestures';
import { renderThumbnailFor, thumbFromRenderer } from './thumbs';

const ASPECTS: { label: string; value: number | null | 'orig' }[] = [
  { label: 'Original', value: 'orig' },
  { label: 'Free', value: null },
  { label: '1 : 1', value: 1 },
  { label: '4 : 5', value: 4 / 5 },
  { label: '5 : 7', value: 5 / 7 },
  { label: '2 : 3', value: 2 / 3 },
  { label: '3 : 4', value: 3 / 4 },
  { label: '16 : 9', value: 16 / 9 },
  { label: '3 : 2', value: 3 / 2 },
  { label: '9 : 16', value: 9 / 16 },
];

type Drag =
  | { kind: 'crop-move' | 'crop-rotate'; start: DevelopSettings['crop']; p0: [number, number]; center: [number, number] }
  | { kind: 'crop-handle'; start: DevelopSettings['crop']; h: Handle }
  | { kind: 'mask'; id: string; handle: string; startSrc: [number, number]; start: DevelopSettings['masks'][number] }
  | { kind: 'spot'; id: string; part: SpotPart; startSrc: [number, number]; start: RetouchSpot; moved: boolean }
  | { kind: 'spot-paint'; pts: [number, number][]; screen: [number, number][] }
  | { kind: 'pan'; p0: [number, number]; pan0: [number, number]; moved: boolean };

const MAX_SPOTS = 300;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Largest zoom: device pixels per photo pixel (1600%). */
const MAX_ZOOM = 16;
const FIT_MARGIN = 14;

/** Where the photo sits in the view (device px). Zoomed photos can't be panned past their edges. */
function computeRect(s: DevelopSettings, cropMode: boolean, zoom: DevZoom, pan: [number, number], W: number, H: number, fw: number, fh: number, dpr: number): Rect {
  const out = cropOutSize(s, fw, fh, cropMode);
  if (typeof zoom === 'number' && !cropMode) {
    const w = out.w * zoom;
    const h = out.h * zoom;
    let x = W / 2 - w / 2 + pan[0];
    let y = H / 2 - h / 2 + pan[1];
    x = w > W ? Math.min(0, Math.max(W - w, x)) : (W - w) / 2;
    y = h > H ? Math.min(0, Math.max(H - h, y)) : (H - h) / 2;
    // Whole device pixels keep 1:1 (and other integer zooms) sharp.
    return { x: Math.round(x), y: Math.round(y), w, h };
  }
  return fitRect(out.w, out.h, W, H, (cropMode ? 40 : FIT_MARGIN) * dpr);
}

/** The pan `computeRect` actually applied, after clamping. */
const effectivePan = (r: Rect, W: number, H: number): [number, number] => [r.x - (W - r.w) / 2, r.y - (H - r.h) / 2];

const sameRect = (a: Rect | null, b: Rect | null) =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 1e-4 && Math.abs(a.y - b.y) < 1e-4 && Math.abs(a.w - b.w) < 1e-4 && Math.abs(a.h - b.h) < 1e-4);

export function DevelopView() {
  const visible = useVisiblePhotos();
  const photos = app.use((s) => s.photos);
  const photoId = dev.use((s) => s.photoId);
  if (!photos.some((p) => p.id === photoId) && !visible.length) {
    return (
      <div className="empty">
        <h3>{photos.length ? 'No photos to show' : 'Nothing to develop yet'}</h3>
        <div>{photos.length ? 'No photos match the current Library filter.' : 'Import photos in the Library first.'}</div>
        <Button primary onClick={() => app.set({ module: 'library' })}>
          Go to Library
        </Button>
      </div>
    );
  }
  // The workspace's effects need its view elements, so it only mounts when there is something to show.
  return <DevelopWorkspace />;
}

function DevelopWorkspace() {
  const visible = useVisiblePhotos();
  const activeId = app.use((s) => s.activeId);
  const photos = app.use((s) => s.photos);
  const photoId = dev.use((s) => s.photoId);
  const s = dev.use((x) => x.settings);
  const tool = dev.use((x) => x.tool);
  const activeMask = dev.use((x) => x.activeMask);
  const activeSpot = dev.use((x) => x.activeSpot);
  const spotOpts = dev.use((x) => x.spotOpts);
  // Only whether the photo is zoomed: pinch/scroll changes zoom and pan many times a second, and those
  // redraw the GL view directly instead of re-rendering this whole panel tree.
  const zoomed = dev.use((x) => x.zoom !== 'fit');
  const before = dev.use((x) => x.before);
  const preview = dev.use((x) => x.preview);
  const hist = dev.use((x) => x.histogram);
  const loading = dev.use((x) => x.loading);
  const clipboard = app.use((x) => x.clipboard);

  const viewRef = useRef<HTMLDivElement>(null);
  const glHostRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const rRef = useRef<DevelopRenderer | null>(null);
  const img = useRef<{
    id: string;
    preview: HTMLCanvasElement | ImageBitmap;
    full: HTMLCanvasElement | ImageBitmap | null;
    fullLoading?: boolean;
    fw: number;
    fh: number;
    usingFull: boolean;
  } | null>(null);
  const geom = useRef<ViewGeom | null>(null);
  const drag = useRef<Drag | null>(null);
  const cropStart = useRef<DevelopSettings | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [error, setError] = useState<string | null>(null);
  // Bumped when the GPU source changes (preview/full resolution) to redraw and refresh the "preview" label.
  const [, setLoaded] = useState(0);
  const [exporting, setExporting] = useState(false);
  const photo = photos.find((p) => p.id === photoId);

  // ------------------------------------------------------------ lifecycle
  useEffect(() => {
    const host = glHostRef.current!;
    try {
      rRef.current = mountRenderer(host);
    } catch (e) {
      setError((e as Error).message);
    }
    const thumbTimers = new Map<string, ReturnType<typeof setTimeout>>();
    setPersistListener((id, settings) => {
      clearTimeout(thumbTimers.get(id));
      thumbTimers.set(
        id,
        setTimeout(() => {
          const r = rRef.current;
          if (r && img.current?.id === id && !r.lost) thumbFromRenderer(r, settings, id);
          else renderThumbnailFor(id);
        }, 900),
      );
    });
    return () => {
      flushDevelop();
      setPersistListener((id) => renderThumbnailFor(id));
      unmountRenderer(rRef.current);
      rRef.current = null;
      dev.set({ tool: 'none', preview: null, before: false });
    };
  }, []);

  useEffect(() => {
    const target = activeId ?? visible[0]?.id ?? null;
    if (target && target !== dev.get().photoId) {
      flushDevelop();
      loadDevelopPhoto(target);
    }
  }, [activeId, visible]);

  useEffect(() => {
    const el = viewRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const p = getPhoto(photoId);
    const r = rRef.current;
    if (!p || !r) return;
    let live = true;
    dev.set({ loading: true, zoom: 'fit', pan: [0, 0], viewRect: null, histogram: null, navigator: null });
    setError(null);
    loadPhotoImage(p, 2560)
      .then((bmp) => {
        if (!live) return;
        const prev = img.current;
        if (prev) {
          if ('close' in prev.preview) prev.preview.close();
          if (prev.full && 'close' in prev.full) prev.full.close();
        }
        img.current = { id: p.id, preview: bmp, full: null, fw: p.width, fh: p.height, usingFull: false };
        r.setImage(bmp, p.width, p.height);
        dev.set({ loading: false, zoom: 'fit', pan: [0, 0] });
        setLoaded((n) => n + 1);
      })
      .catch((e) => {
        console.error(e);
        if (live) {
          setError(`Could not load ${p.name}: ${(e as Error).message}`);
          dev.set({ loading: false });
        }
      });
    return () => {
      live = false;
    };
  }, [photoId]);

  // ------------------------------------------------------------ resolution
  // The ≤2560 px preview is used until the photo is shown larger than it, then the full-resolution image.
  // The thresholds differ so zooming around the switch point doesn't flip back and forth.
  const ensureResolution = () => {
    const st = img.current;
    const r = rRef.current;
    if (!st || !r || r.lost) return;
    const z = dev.get().zoom;
    const pLong = Math.max(st.preview.width, st.preview.height);
    const fLong = Math.max(st.fw, st.fh);
    const mag = typeof z === 'number' ? (z * fLong) / pLong : 0; // display px per preview texel
    const want = fLong > pLong * 1.02 && (mag > 1.05 || (st.usingFull && mag > 0.9));
    if (want === st.usingFull) return;
    if (!want) {
      r.setImage(st.preview, st.fw, st.fh);
      st.usingFull = false;
      setLoaded((n) => n + 1);
    } else if (st.full) {
      r.setImage(st.full, st.fw, st.fh);
      st.usingFull = true;
      setLoaded((n) => n + 1);
    } else if (!st.fullLoading) {
      const p = getPhoto(st.id);
      if (!p) return;
      st.fullLoading = true;
      loadPhotoImage(p)
        .then((full) => {
          const fitted = Math.max(full.width, full.height) > r.maxTexture ? fitCanvas(full, r.maxTexture) : full;
          if (fitted !== full && 'close' in full) full.close();
          st.full = fitted;
          st.fullLoading = false;
          if (img.current === st) ensureResolution(); // zoom may have changed while loading
        })
        .catch((e) => {
          st.fullLoading = false;
          console.error(e);
        });
    }
  };
  const resTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Re-checks the resolution once zooming settles (switching textures mid-pinch would stutter). */
  const scheduleResolution = () => {
    if (resTimer.current) clearTimeout(resTimer.current);
    resTimer.current = setTimeout(() => {
      resTimer.current = null;
      ensureResolution();
    }, 160);
  };
  useEffect(() => () => {
    if (resTimer.current) clearTimeout(resTimer.current);
  }, []);

  // ------------------------------------------------------------ drawing
  // Zoom and pan are read from the store at draw time (see the subscription below), not from render props.
  const latest = useRef({ s, tool, before, preview, size, activeMask, activeSpot, spotOpts });
  latest.current = { s, tool, before, preview, size, activeMask, activeSpot, spotOpts };
  const raf = useRef(0);
  const ovRaf = useRef(0);
  const histTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** What the histogram/navigator were last computed for; pan and zoom alone don't change them. */
  const histFor = useRef<{ s: DevelopSettings; preview: unknown; before: boolean; img: unknown } | null>(null);
  /** Pointer position over the view (device px) for the touch-up brush preview. */
  const hoverRef = useRef<[number, number] | null>(null);
  const spaceDown = useRef(false);

  const drawOverlay = () => {
    const g = geom.current;
    const ov = ovRef.current;
    if (!g || !ov) return;
    const L = latest.current;
    const eff = L.preview ? applyPatch(L.s, L.preview.patch) : L.s;
    const ctx = ov.getContext('2d')!;
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (g.cropMode) drawCrop(ctx, g, eff, ov.width, ov.height);
    if (L.tool === 'masks') drawMasks(ctx, g, eff, L.activeMask);
    if (L.tool === 'spots') {
      const d = drag.current;
      drawSpots(ctx, g, eff, L.activeSpot, {
        hover: spaceDown.current || (d && d.kind !== 'spot-paint') ? null : hoverRef.current,
        brushR: L.spotOpts.size * Math.max(g.fullW, g.fullH) * screenScale(g, eff),
        painting: d?.kind === 'spot-paint' ? d.screen : null,
      });
    }
  };
  const scheduleOverlay = () => {
    if (!ovRaf.current)
      ovRaf.current = requestAnimationFrame(() => {
        ovRaf.current = 0;
        drawOverlay();
      });
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(ovRaf.current);
      ovRaf.current = 0; // a stale id would block scheduleOverlay() after a StrictMode remount
    },
    [],
  );

  const drawNow = () => {
    const r = rRef.current;
    const st = img.current;
    if (!r || !st || r.lost) return;
    const L = latest.current;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(L.size.w * dpr);
    const H = Math.round(L.size.h * dpr);
    if (!W || !H) return;
    const eff = L.preview ? applyPatch(L.s, L.preview.patch) : L.s;
    const cropMode = L.tool === 'crop';
    const { zoom, pan } = dev.get();
    const rect = computeRect(eff, cropMode, zoom, pan, W, H, st.fw, st.fh, dpr);
    r.draw(eff, { targetW: W, targetH: H, rect: [rect.x, rect.y, rect.w, rect.h], cropMode, before: L.before, bg: [0.078, 0.078, 0.086] });
    geom.current = { rect, cropMode, fullW: st.fw, fullH: st.fh, dpr };
    const ov = ovRef.current!;
    if (ov.width !== W || ov.height !== H) {
      ov.width = W;
      ov.height = H;
    }
    drawOverlay();

    // Zoom readout and the Navigator's view rectangle.
    const viewScale = rect.w / cropOutSize(eff, st.fw, st.fh, cropMode).w;
    let viewRect: Rect | null = null;
    if (!cropMode && typeof zoom === 'number') {
      const x0 = Math.max(0, -rect.x / rect.w);
      const y0 = Math.max(0, -rect.y / rect.h);
      const x1 = Math.min(1, (W - rect.x) / rect.w);
      const y1 = Math.min(1, (H - rect.y) / rect.h);
      if (x0 > 1e-3 || y0 > 1e-3 || x1 < 1 - 1e-3 || y1 < 1 - 1e-3) viewRect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const cur = dev.get();
    if (Math.abs(cur.viewScale - viewScale) > 1e-6 || !sameRect(cur.viewRect, viewRect)) dev.set({ viewScale, viewRect });

    const hf = histFor.current;
    if (!histTimer.current && !(hf && hf.s === L.s && hf.preview === L.preview && hf.before === L.before && hf.img === st))
      histTimer.current = setTimeout(() => {
        histTimer.current = null;
        const rr = rRef.current;
        const st2 = img.current;
        if (!rr || !st2 || rr.lost) return;
        const L2 = latest.current;
        const e2 = L2.preview ? applyPatch(L2.s, L2.preview.patch) : L2.s;
        const out = cropOutSize(e2, st2.fw, st2.fh);
        const k = Math.min(1, 240 / Math.max(out.w, out.h));
        const im = rr.renderPixels(e2, Math.max(1, Math.round(out.w * k)), Math.max(1, Math.round(out.h * k)), { before: L2.before, key: 'hist' });
        histFor.current = { s: L2.s, preview: L2.preview, before: L2.before, img: st2 };
        dev.set({ histogram: computeHistogram(im.data), navigator: im });
      }, 140);
  };

  const scheduleDraw = () => {
    if (!raf.current)
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        drawNow();
      });
  };
  useEffect(() => scheduleDraw());
  useEffect(() => {
    // Zoom and pan change outside React renders (gestures), so redraw on store changes too.
    let prev = dev.get();
    const unsub = dev.subscribe(() => {
      const cur = dev.get();
      if (cur.zoom !== prev.zoom || cur.pan !== prev.pan) {
        scheduleDraw();
        if (cur.zoom !== prev.zoom) scheduleResolution();
      }
      prev = cur;
    });
    return () => {
      unsub();
      cancelAnimationFrame(raf.current);
      raf.current = 0; // a stale id would block scheduleDraw() after a StrictMode remount
    };
  }, []);

  // ------------------------------------------------------------ interaction helpers
  const live = (f: (d: DevelopSettings) => void) => updateSettings('', f, false);
  const commit = (label: string, f?: (d: DevelopSettings) => void) => (f ? updateSettings(label, f) : commitSettings(label));
  const setTool = (t: DevTool) => {
    const cur = dev.get().tool;
    if (cur === 'crop' && t !== 'crop') commitSettings('Crop');
    if (t === 'crop' && cur !== 'crop') cropStart.current = deepClone(dev.get().settings);
    dev.set({ tool: cur === t ? 'none' : t });
  };
  const orientedFull = () => {
    const st = img.current!;
    return orientedSize(st.fw, st.fh, dev.get().settings.orient.rotate);
  };
  const pt = (e: { clientX: number; clientY: number }): [number, number] => {
    const b = ovRef.current!.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return [(e.clientX - b.left) * dpr, (e.clientY - b.top) * dpr];
  };

  // ------------------------------------------------------------ zoom & pan
  /** View size (device px), the photo's crop-out size and its fit scale; null until something is shown. */
  const viewInfo = () => {
    const st = img.current;
    const g = geom.current;
    if (!st || !g) return null;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(latest.current.size.w * dpr);
    const H = Math.round(latest.current.size.h * dpr);
    if (!W || !H) return null;
    const s = dev.get().settings;
    const out = cropOutSize(s, st.fw, st.fh);
    const fit = Math.min((W - 2 * FIT_MARGIN * dpr) / out.w, (H - 2 * FIT_MARGIN * dpr) / out.h);
    return { st, g, dpr, W, H, s, out, fit, center: [W / 2, H / 2] as [number, number] };
  };
  const zoomFit = () => dev.set({ zoom: 'fit', pan: [0, 0] });
  /**
   * Photo point a zoom gesture started on. While the photo is still smaller than the view it stays centred
   * on that axis, so re-deriving the point from each step would drift; keeping it for the whole gesture
   * brings the pinched spot under the fingers once the photo is large enough.
   */
  const zoomAnchor = useRef<{ x: number; y: number; ux: number; uy: number; t: number } | null>(null);
  /** Zooms to `z` keeping the photo point under the device point `p` in place. */
  const zoomToAt = (z: number, p?: [number, number]) => {
    const v = viewInfo();
    if (!v || v.g.cropMode) return;
    const at = p ?? v.center;
    // Large photos stop at Fit; small ones can go down to 1:1.
    z = Math.min(MAX_ZOOM, Math.max(Math.min(v.fit, 1), z));
    if (Math.abs(z - v.fit) / v.fit < 0.004) {
      zoomAnchor.current = null;
      return zoomFit();
    }
    // Anchor on the current state, not the last drawn frame: a pinch delivers several events per frame.
    const { zoom: z0, pan: p0 } = dev.get();
    const now = performance.now();
    let a = zoomAnchor.current;
    if (!a || now - a.t > 300 || Math.hypot(at[0] - a.x, at[1] - a.y) > 3 * v.dpr) {
      const cur = computeRect(v.s, false, z0, p0, v.W, v.H, v.st.fw, v.st.fh, v.dpr);
      a = { x: at[0], y: at[1], ux: (at[0] - cur.x) / cur.w, uy: (at[1] - cur.y) / cur.h, t: now };
    }
    a.t = now;
    zoomAnchor.current = a;
    const { ux, uy } = a;
    const w = v.out.w * z;
    const h = v.out.h * z;
    const want: [number, number] = [at[0] - ux * w - (v.W - w) / 2, at[1] - uy * h - (v.H - h) / 2];
    const r = computeRect(v.s, false, z, want, v.W, v.H, v.st.fw, v.st.fh, v.dpr);
    dev.set({ zoom: z, pan: effectivePan(r, v.W, v.H) });
  };
  const zoomBy = (f: number, p?: [number, number]) => {
    const v = viewInfo();
    if (!v) return;
    const z = dev.get().zoom;
    zoomToAt((typeof z === 'number' ? z : v.fit) * f, p);
  };
  /** "Zoom in" from Fit: 1:1, or 2× Fit for photos that are shown above 1:1 already. */
  const zoomInTarget = (fit: number) => (fit < 0.95 ? 1 : fit * 2);
  /** Pans the zoomed photo by device pixels, stopping at its edges. */
  const panTo = (pan: [number, number]) => {
    const v = viewInfo();
    const z = dev.get().zoom;
    if (!v || typeof z !== 'number' || v.g.cropMode) return;
    const next = effectivePan(computeRect(v.s, false, z, pan, v.W, v.H, v.st.fw, v.st.fh, v.dpr), v.W, v.H);
    const cur = dev.get().pan;
    if (next[0] !== cur[0] || next[1] !== cur[1]) dev.set({ pan: next });
  };
  const panBy = (dx: number, dy: number) => {
    const [x, y] = dev.get().pan;
    panTo([x + dx, y + dy]);
  };
  /** Centres the photo point (u, v), in crop-out coordinates; from Fit, optionally zooms in there. */
  const centerOn = (u: number, vv: number, zoomIfFit: boolean) => {
    const v = viewInfo();
    if (!v || v.g.cropMode) return;
    let z = dev.get().zoom;
    if (z === 'fit') {
      if (!zoomIfFit) return;
      z = zoomInTarget(v.fit);
    }
    const w = v.out.w * z;
    const h = v.out.h * z;
    const r = computeRect(v.s, false, z, [w / 2 - u * w, h / 2 - vv * h], v.W, v.H, v.st.fw, v.st.fh, v.dpr);
    dev.set({ zoom: z, pan: effectivePan(r, v.W, v.H) });
  };

  // Gesture and Navigator callbacks outlive renders, so they go through a ref to the latest closures.
  const nav = useRef({ zoomBy, panBy, centerOn, step: (_d: number) => {} });
  useEffect(() => {
    const el = viewRef.current!;
    const detach = attachViewGestures(el, {
      zoom: (f, x, y) => nav.current.zoomBy(f, pt({ clientX: x, clientY: y })),
      pan: (dx, dy) => {
        const dpr = window.devicePixelRatio || 1;
        nav.current.panBy(dx * dpr, dy * dpr);
      },
      // In Fit, a sideways two-finger swipe goes to the next or previous photo (like Photos).
      swipe: (dir) => {
        if (dev.get().zoom === 'fit' && dev.get().tool !== 'crop' && !drag.current) nav.current.step(dir);
      },
    });
    setNavigateHandler((u, v, zoomIfFit) => nav.current.centerOn(u, v, zoomIfFit));
    return () => {
      detach();
      setNavigateHandler(null);
    };
  }, []);

  const onDown = (e: React.PointerEvent) => {
    const g = geom.current;
    if (!g || !img.current || e.button !== 0) return;
    const p = pt(e);
    const cur = dev.get().settings;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    if (tool === 'spots' && !spaceDown.current && !before) {
      const hit = hitSpot(g, cur, dev.get().activeSpot, p);
      if (hit) {
        const sp = cur.spots.find((x) => x.id === hit.id)!;
        dev.set({ activeSpot: hit.id });
        drag.current = { kind: 'spot', id: hit.id, part: hit.part, startSrc: screenToSource(g, cur, p), start: deepClone(sp), moved: false };
        return;
      }
      dev.set({ activeSpot: null });
      const uv = toView(g, p);
      if (uv[0] >= 0 && uv[1] >= 0 && uv[0] <= 1 && uv[1] <= 1) {
        drag.current = { kind: 'spot-paint', pts: [screenToSource(g, cur, p)], screen: [p] };
        scheduleOverlay();
      }
      return;
    }
    if (tool === 'crop') {
      const hit = hitCrop(g, cur, p);
      const r = g.rect;
      const c = cur.crop;
      const center: [number, number] = [r.x + (c.x + c.w / 2) * r.w, r.y + (c.y + c.h / 2) * r.h];
      if (hit.kind === 'handle') drag.current = { kind: 'crop-handle', start: { ...c }, h: hit.h };
      else drag.current = { kind: hit.kind === 'move' ? 'crop-move' : 'crop-rotate', start: { ...c }, p0: p, center };
      return;
    }
    if (tool === 'wb') {
      const src = screenToSource(g, cur, p);
      const sample = rRef.current?.sample;
      if (sample && src[0] >= 0 && src[1] >= 0 && src[0] <= 1 && src[1] <= 1) {
        const [rr, gg, bb] = sampleAt(sample, src[0], src[1], 1);
        const wb = wbForNeutral(rr, gg, bb);
        commit('White Balance Selector', (d) => Object.assign(d, wb));
        dev.set({ tool: 'none' });
      }
      return;
    }
    if (tool === 'masks') {
      const m = cur.masks.find((x) => x.id === activeMask);
      const tol = 12 * g.dpr;
      if (m) {
        const h = maskHandles(g, cur, m).find((hh) => Math.hypot(hh.pos[0] - p[0], hh.pos[1] - p[1]) < tol);
        if (h) {
          drag.current = { kind: 'mask', id: m.id, handle: h.id, startSrc: screenToSource(g, cur, p), start: deepClone(m) };
          return;
        }
      }
      for (const other of cur.masks) {
        const h = maskHandles(g, cur, other).find((hh) => (hh.id === 'center' || hh.id === 'mid') && Math.hypot(hh.pos[0] - p[0], hh.pos[1] - p[1]) < tol * 1.5);
        if (h) {
          dev.set({ activeMask: other.id });
          drag.current = { kind: 'mask', id: other.id, handle: h.id, startSrc: screenToSource(g, cur, p), start: deepClone(other) };
          return;
        }
      }
      return;
    }
    drag.current = { kind: 'pan', p0: p, pan0: [...dev.get().pan] as [number, number], moved: false };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const g = geom.current;
    if (tool === 'spots') {
      hoverRef.current = pt(e);
      if (!d) scheduleOverlay();
    }
    if (!d || !g) return;
    const p = pt(e);
    if (d.kind === 'spot-paint') {
      const last = d.screen[d.screen.length - 1];
      const cur = dev.get().settings;
      const brushR = dev.get().spotOpts.size * Math.max(g.fullW, g.fullH) * screenScale(g, cur);
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= Math.max(2 * g.dpr, brushR * 0.2)) {
        d.screen.push(p);
        d.pts.push(screenToSource(g, cur, p));
        scheduleOverlay();
      }
      return;
    }
    if (d.kind === 'spot') {
      const st = img.current!;
      const src = screenToSource(g, dev.get().settings, p);
      const mx0 = src[0] - d.startSrc[0];
      const my0 = src[1] - d.startSrc[1];
      if (!d.moved && Math.hypot(mx0 * st.fw, my0 * st.fh) * screenScale(g, dev.get().settings) < 3 * g.dpr) return;
      d.moved = true;
      live((x) => {
        const sp = x.spots.find((y) => y.id === d.id);
        if (!sp) return;
        const xs = d.start.path.map((q) => q[0]);
        const ys = d.start.path.map((q) => q[1]);
        if (d.part === 'dst') {
          // The destination moves; its source stays put on the image.
          const mx = Math.min(1 - Math.max(...xs), Math.max(-Math.min(...xs), mx0));
          const my = Math.min(1 - Math.max(...ys), Math.max(-Math.min(...ys), my0));
          sp.path = d.start.path.map(([x0, y0]) => [x0 + mx, y0 + my]);
          sp.dx = d.start.dx - mx;
          sp.dy = d.start.dy - my;
        } else if (d.part === 'src') {
          const c = d.start.path[Math.floor(d.start.path.length / 2)];
          sp.dx = clamp01(c[0] + d.start.dx + mx0) - c[0];
          sp.dy = clamp01(c[1] + d.start.dy + my0) - c[1];
        } else {
          const L = Math.max(st.fw, st.fh);
          const dist = Math.min(...d.start.path.map(([x0, y0]) => Math.hypot((src[0] - x0) * st.fw, (src[1] - y0) * st.fh)));
          sp.r = Math.min(0.25, Math.max(1.5 / L, dist / L));
        }
      });
      return;
    }
    if (d.kind === 'pan') {
      const dx = p[0] - d.p0[0];
      const dy = p[1] - d.p0[1];
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      if (d.moved) panTo([d.pan0[0] + dx, d.pan0[1] + dy]);
      return;
    }
    const { w: wo, h: ho } = orientedFull();
    if (d.kind === 'crop-move') {
      const a = toView(g, d.p0);
      const b = toView(g, p);
      const next = { ...d.start, x: d.start.x + b[0] - a[0], y: d.start.y + b[1] - a[1] };
      const fit = fitToward(d.start, next, d.start.angle, wo, ho);
      live((x) => (x.crop = { ...d.start, ...fit }));
    } else if (d.kind === 'crop-handle') {
      const v = toView(g, p);
      const start = { x: d.start.x * wo, y: d.start.y * ho, w: d.start.w * wo, h: d.start.h * ho };
      const rr = resizeRect(start, d.h, v[0] * wo, v[1] * ho, d.start.aspect, 24);
      const next = { x: rr.x / wo, y: rr.y / ho, w: rr.w / wo, h: rr.h / ho };
      const fit = fitToward(d.start, next, d.start.angle, wo, ho);
      live((x) => (x.crop = { ...d.start, ...fit }));
    } else if (d.kind === 'crop-rotate') {
      const a0 = Math.atan2(d.p0[1] - d.center[1], d.p0[0] - d.center[0]);
      const a1 = Math.atan2(p[1] - d.center[1], p[0] - d.center[0]);
      let delta = ((a1 - a0) * 180) / Math.PI;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const angle = Math.max(-45, Math.min(45, Math.round((d.start.angle + delta) * 10) / 10));
      const fit = constrainCrop(d.start, angle, wo, ho);
      live((x) => (x.crop = { ...d.start, ...fit, angle }));
    } else if (d.kind === 'mask') {
      const cur = dev.get().settings;
      const src = screenToSource(g, cur, p);
      const st = img.current!;
      live((x) => {
        const m = x.masks.find((mm) => mm.id === d.id);
        if (!m) return;
        if (m.type === 'radial') {
          const r = m.radial;
          if (d.handle === 'center') {
            r.cx = d.start.radial.cx + src[0] - d.startSrc[0];
            r.cy = d.start.radial.cy + src[1] - d.startSrc[1];
          } else {
            const a = (r.angle * Math.PI) / 180;
            const vx = (src[0] - r.cx) * st.fw;
            const vy = (src[1] - r.cy) * st.fh;
            if (d.handle === 'rx') r.rx = Math.max(0.01, Math.abs(vx * Math.cos(a) + vy * Math.sin(a)) / st.fw);
            else r.ry = Math.max(0.01, Math.abs(-vx * Math.sin(a) + vy * Math.cos(a)) / st.fh);
          }
        } else {
          const l = m.linear;
          if (d.handle === 'start') [l.x0, l.y0] = src;
          else if (d.handle === 'end') [l.x1, l.y1] = src;
          else {
            const dx = src[0] - d.startSrc[0];
            const dy = src[1] - d.startSrc[1];
            l.x0 = d.start.linear.x0 + dx;
            l.y0 = d.start.linear.y0 + dy;
            l.x1 = d.start.linear.x1 + dx;
            l.y1 = d.start.linear.y1 + dy;
          }
        }
      });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === 'spot-paint') {
      addSpot(d);
      scheduleOverlay();
      return;
    }
    if (d.kind === 'spot') {
      if (d.moved) commitSettings(d.part === 'src' ? 'Move Spot Source' : d.part === 'resize' ? 'Resize Spot' : 'Move Spot');
      scheduleOverlay();
      return;
    }
    if (d.kind === 'pan') {
      // A click (no drag) zooms in on that point from Fit, and back to Fit otherwise.
      if (!d.moved && !loading) {
        const v = viewInfo();
        if (!v) return;
        if (dev.get().zoom === 'fit') {
          const uv = toView(v.g, pt(e));
          if (uv[0] >= 0 && uv[0] <= 1 && uv[1] >= 0 && uv[1] <= 1) zoomToAt(zoomInTarget(v.fit), pt(e));
        } else zoomFit();
      }
      return;
    }
    if (d.kind === 'mask') commitSettings('Edit Mask');
    else commitSettings('Crop');
  };

  // ------------------------------------------------------------ touch up
  /** Offsets already offered per spot, so "New Source" keeps finding different areas. */
  const triedSources = useRef(new Map<string, [number, number][]>());
  const pickSource = (sp: RetouchSpot): [number, number] => {
    const r = rRef.current;
    if (!r) return [sp.dx, sp.dy];
    // Search the image without this spot applied, so its own result isn't taken for clean texture.
    const cur = dev.get().settings;
    r.process({ ...cur, spots: cur.spots.filter((x) => x.id !== sp.id) });
    const tried = triedSources.current.get(sp.id) ?? [];
    const o = r.findSpotSource({ ...sp, dx: 0, dy: 0 }, tried);
    triedSources.current.set(sp.id, [...tried, o].slice(-12));
    return o;
  };

  const addSpot = (d: Extract<Drag, { kind: 'spot-paint' }>) => {
    const st = img.current;
    const g = geom.current;
    if (!st || !g || !rRef.current) return;
    const cur = dev.get().settings;
    if (cur.spots.length >= MAX_SPOTS) return toast(`Up to ${MAX_SPOTS} touch-up spots per photo`, 'error');
    const o = dev.get().spotOpts;
    let travel = 0;
    for (let i = 1; i < d.screen.length; i++) travel += Math.hypot(d.screen[i][0] - d.screen[i - 1][0], d.screen[i][1] - d.screen[i - 1][1]);
    const rPx = o.size * Math.max(st.fw, st.fh);
    // Simplify in full-resolution pixels so a brushed path keeps its shape whatever the zoom.
    const path: [number, number][] =
      travel < 4 * g.dpr
        ? [d.pts[0]]
        : simplifyPath(d.pts.map(([x, y]) => [x * st.fw, y * st.fh]), Math.max(0.5, rPx * 0.15))
            .slice(0, 400)
            .map(([x, y]) => [clamp01(x / st.fw), clamp01(y / st.fh)]);
    const spot: RetouchSpot = { id: uid('s'), mode: o.mode, path, r: o.size, dx: 0, dy: 0, feather: o.feather, opacity: o.opacity, darken: o.darken };
    if (spot.mode !== 'redeye') [spot.dx, spot.dy] = pickSource(spot);
    const label = spot.mode === 'redeye' ? 'Red Eye' : path.length > 1 ? 'Brush Spot' : spot.mode === 'clone' ? 'Clone Spot' : 'Heal Spot';
    commitSettings(label, { ...deepClone(cur), spots: [...cur.spots, spot] });
    dev.set({ activeSpot: spot.id });
  };

  const newSource = () => {
    const id = dev.get().activeSpot;
    const sp = dev.get().settings.spots.find((x) => x.id === id);
    if (!sp || sp.mode === 'redeye') return;
    const [dx, dy] = pickSource(sp);
    updateSettings('New Spot Source', (d) => {
      const x = d.spots.find((y) => y.id === id);
      if (x) [x.dx, x.dy] = [dx, dy];
    });
  };

  const deleteSpot = (id: string) => {
    updateSettings('Delete Spot', (d) => (d.spots = d.spots.filter((x) => x.id !== id)));
    if (dev.get().activeSpot === id) dev.set({ activeSpot: null });
  };

  const stepBrush = (dir: 1 | -1) => {
    const st = img.current;
    if (!st) return;
    const L = Math.max(st.fw, st.fh);
    const sp = dev.get().settings.spots.find((x) => x.id === dev.get().activeSpot);
    const px = (sp ? sp.r : dev.get().spotOpts.size) * L;
    const next = Math.min(0.25, Math.max(1 / L, (px * (dir > 0 ? 1.15 : 1 / 1.15) + dir) / L));
    if (sp) updateSettings('Resize Spot', (d) => {
      const x = d.spots.find((y) => y.id === sp.id);
      if (x) x.r = next;
    });
    setSpotOpts({ size: next });
    scheduleOverlay();
  };

  // ------------------------------------------------------------ actions
  const step = (dir: number) => {
    const i = visible.findIndex((p) => p.id === photoId);
    const next = visible[i + dir];
    if (next) app.set({ activeId: next.id, selected: [next.id] });
  };
  nav.current = { zoomBy, panBy, centerOn, step };
  const paste = () => {
    const c = app.get().clipboard;
    if (c) commitSettings('Paste Settings', applyPatch(dev.get().settings, c));
  };
  const reset = () => {
    const d = defaultSettings();
    commitSettings('Reset', d);
  };
  const editInEditor = () => {
    if (!photoId) return;
    flushDevelop();
    openPhotoInEditor(photoId, { developed: true });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.modal')) return;
      const k = e.key.toLowerCase();
      if (modKey(e)) {
        if (k === 'z') {
          e.preventDefault();
          if (e.shiftKey) redoDevelop();
          else undoDevelop();
        } else if (k === 'y') {
          e.preventDefault();
          redoDevelop();
        } else if (e.shiftKey && k === 'c') {
          e.preventDefault();
          copySettings();
          toast('Settings copied');
        } else if (e.shiftKey && k === 'v') {
          e.preventDefault();
          paste();
        } else if (e.shiftKey && k === 'r') {
          e.preventDefault();
          reset();
        } else if (e.shiftKey && k === 'e') {
          e.preventDefault();
          setExporting(true);
        } else if (k === 'e') {
          e.preventDefault();
          editInEditor();
        } else if ((k === '=' || k === '+') && !e.altKey) {
          e.preventDefault();
          zoomBy(1.25);
        } else if (k === '-' && !e.altKey) {
          e.preventDefault();
          zoomBy(0.8);
        } else if (k === '0' && !e.altKey) {
          e.preventDefault();
          zoomFit();
        } else if (k === '1' && !e.altKey) {
          e.preventDefault();
          zoomToAt(1);
        }
        return;
      }
      if (e.altKey) return;
      const spots = dev.get().tool === 'spots';
      if (k === ' ' && spots) {
        e.preventDefault();
        if (!spaceDown.current) {
          spaceDown.current = true;
          scheduleOverlay();
        }
        return;
      }
      if (k === '\\') dev.set({ before: !dev.get().before });
      else if (k === 'r') setTool('crop');
      else if (k === 'q') setTool('spots');
      else if (k === 'w') setTool('wb');
      else if (k === 'm') setTool('masks');
      else if (k === 'z') {
        if (dev.get().zoom === 'fit') zoomToAt(1);
        else zoomFit();
      }
      else if (k === 'escape') {
        if (dev.get().tool === 'crop' && cropStart.current) {
          liveSettings(cropStart.current);
          dev.set({ tool: 'none' });
        } else if (spots && dev.get().activeSpot) dev.set({ activeSpot: null });
        else dev.set({ tool: 'none' });
      } else if (spots && (k === 'delete' || k === 'backspace') && dev.get().activeSpot) {
        e.preventDefault();
        deleteSpot(dev.get().activeSpot!);
      } else if (spots && k === '/') {
        e.preventDefault();
        newSource();
      } else if (spots && (k === '[' || k === ']')) stepBrush(k === ']' ? 1 : -1);
      else if (k === 'enter' && dev.get().tool === 'crop') setTool('none');
      else if (k === 'arrowleft') step(-1);
      else if (k === 'arrowright') step(1);
      else if (k >= '0' && k <= '5' && photoId) setRating([photoId], +k);
      else if (k === 'p' && photoId) setFlag([photoId], 1);
      else if (k === 'x' && photoId) setFlag([photoId], -1);
      else if (k === 'u' && photoId) setFlag([photoId], 0);
      else if (k === 'g') app.set({ module: 'library', libraryView: 'grid' });
      else if (k === 'e') app.set({ module: 'library', libraryView: 'loupe' });
      else if ((k === 'delete' || k === 'backspace') && dev.get().tool === 'masks' && dev.get().activeMask) {
        const id = dev.get().activeMask;
        updateSettings('Delete Mask', (d) => (d.masks = d.masks.filter((m) => m.id !== id)));
        dev.set({ activeMask: null });
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && spaceDown.current) {
        spaceDown.current = false;
        scheduleOverlay();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  });

  const panelProps: DevPanelProps = {
    s,
    live,
    commit,
    sample: rRef.current?.sample ?? null,
    hist,
    onWbPick: () => setTool('wb'),
    wbPicking: tool === 'wb',
  };

  const cursor =
    tool === 'wb' || (tool === 'spots' && !before) ? 'crosshair' : tool === 'crop' || tool === 'masks' ? 'default' : zoomed ? 'grab' : 'zoom-in';

  return (
    <div className="dev">
      <aside className="side left">
        <NavigatorPanel />
        <PresetsPanel />
        <HistoryPanel />
      </aside>
      <main className="dev-center">
        <div className="dev-view" ref={viewRef}>
          <div className="gl-host" ref={glHostRef} />
          <canvas
            ref={ovRef}
            className="overlay"
            style={{ cursor }}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onPointerLeave={() => {
              hoverRef.current = null;
              if (tool === 'spots') scheduleOverlay();
            }}
          />
          {(before || preview) && <div className="dev-label">{before ? 'Before' : `Preview: ${preview!.name}`}</div>}
          {loading && <div className="dev-label" style={{ left: 'auto', right: 10 }}>Loading…</div>}
          {error && (
            <div className="empty" style={{ position: 'absolute', inset: 0 }}>
              <h3>Can't display this photo</h3>
              <div>{error}</div>
            </div>
          )}
        </div>
        <div className="dev-toolbar">
          <IconButton title="Before / After" shortcut="\" active={before} onClick={() => dev.set({ before: !before })}>
            <SquareSplitHorizontal size={15} />
          </IconButton>
          <ZoomControls onFit={zoomFit} onActual={() => zoomToAt(1)} />
          <div className="grow" />
          {photo && <Stars value={photo.rating} onChange={(v) => setRating([photo.id], v)} size={12} />}
          <span className="muted" style={{ margin: '0 8px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {photo?.name}
            {photo?.isRaw ? ' · RAW preview' : ''}
          </span>
          <div className="grow" />
          <IconButton title="Copy settings" shortcut="⇧⌘C" onClick={() => (copySettings(), toast('Settings copied'))}>
            <Copy size={15} />
          </IconButton>
          <IconButton title="Paste settings" shortcut="⇧⌘V" disabled={!clipboard} onClick={paste}>
            <ClipboardPaste size={15} />
          </IconButton>
          <IconButton title="Reset all settings" shortcut="⇧⌘R" onClick={reset}>
            <RotateCcw size={15} />
          </IconButton>
          <IconButton title="Edit in Editor (layers, brushes, retouching)" shortcut="⌘E" onClick={editInEditor}>
            <Pencil size={15} />
          </IconButton>
          <IconButton title="Export" shortcut="⇧⌘E" onClick={() => setExporting(true)}>
            <Download size={15} />
          </IconButton>
          <IconButton title="Previous photo" shortcut="←" onClick={() => step(-1)}>
            <ChevronLeft size={16} />
          </IconButton>
          <IconButton title="Next photo" shortcut="→" onClick={() => step(1)}>
            <ChevronRight size={16} />
          </IconButton>
        </div>
      </main>
      <aside className="side right">
        <div className="hist-wrap">
          <HistogramView data={hist} width={282} />
          <div className="hist-info">
            <span>{photo ? `${photo.width} × ${photo.height}` : ''}</span>
            <span>{img.current?.usingFull ? 'full resolution' : 'preview'}</span>
          </div>
        </div>
        <div className="tool-strip" role="toolbar" aria-label="Develop tools">
          <IconButton title="Crop & straighten" shortcut="R" active={tool === 'crop'} onClick={() => setTool('crop')}>
            <Crop size={16} />
          </IconButton>
          <IconButton title="Touch Up: heal, clone & red eye" shortcut="Q" active={tool === 'spots'} onClick={() => setTool('spots')}>
            <Bandage size={16} />
          </IconButton>
          <IconButton title="Masks: radial & linear gradients" shortcut="M" active={tool === 'masks'} onClick={() => setTool('masks')}>
            <Circle size={16} />
          </IconButton>
          <IconButton title="White balance selector" shortcut="W" active={tool === 'wb'} onClick={() => setTool('wb')}>
            <Pipette size={16} />
          </IconButton>
        </div>
        {tool === 'crop' && <CropPanel s={s} wo={orientedSizeOf(img.current, s).w} ho={orientedSizeOf(img.current, s).h} onDone={() => setTool('none')} onCancel={() => {
          if (cropStart.current) liveSettings(cropStart.current);
          dev.set({ tool: 'none' });
        }} />}
        {tool === 'masks' && <MasksPanel s={s} activeMask={activeMask} />}
        {tool === 'spots' && (
          <TouchUpPanel
            s={s}
            activeSpot={activeSpot}
            opts={spotOpts}
            longEdge={Math.max(img.current?.fw ?? 1000, img.current?.fh ?? 1000)}
            onNewSource={newSource}
            onDelete={deleteSpot}
          />
        )}
        <AdjustmentPanels {...panelProps} />
      </aside>
      <div className="filmstrip" role="listbox" aria-label="Filmstrip">
        {visible.map((p) => (
          <div
            key={p.id}
            className={cx('film', p.id === photoId && 'active')}
            onClick={() => app.set({ activeId: p.id, selected: [p.id] })}
            role="option"
            aria-selected={p.id === photoId}
            title={p.name}
          >
            <Thumb photo={p} />
            {p.rating > 0 && <Stars value={p.rating} size={9} />}
          </div>
        ))}
      </div>
      {exporting && photoId && <ExportDialog ids={[photoId]} onClose={() => setExporting(false)} />}
    </div>
  );
}

/** Fit / 1:1 buttons and the zoom readout. Its own component so zooming doesn't re-render the panels. */
function ZoomControls({ onFit, onActual }: { onFit: () => void; onActual: () => void }) {
  const zoom = dev.use((x) => x.zoom);
  const scale = dev.use((x) => x.viewScale);
  const value = zoom === 'fit' ? 'fit' : Math.abs(zoom - 1) < 1e-6 ? '1:1' : 'other';
  return (
    <>
      <Segmented<'fit' | '1:1' | 'other'>
        value={value}
        onChange={(v) => (v === 'fit' ? onFit() : onActual())}
        options={[
          { value: 'fit', label: 'Fit', title: 'Fit (Z, ⌘0)' },
          { value: '1:1', label: '1:1', title: 'Actual pixels (Z, ⌘1)' },
        ]}
      />
      <span className="zoom-readout" title="Pinch or ⌘-scroll to zoom · two-finger scroll or drag to move · ⌘+ / ⌘− to step">
        {Math.round(scale * 100)}%
      </span>
    </>
  );
}

function orientedSizeOf(st: { fw: number; fh: number } | null, s: DevelopSettings) {
  if (!st) return { w: 1, h: 1 };
  return orientedSize(st.fw, st.fh, s.orient.rotate);
}

function CropPanel({ s, wo, ho, onDone, onCancel }: { s: DevelopSettings; wo: number; ho: number; onDone: () => void; onCancel: () => void }) {
  const c = s.crop;
  const aspectValue = c.aspect === null ? 'free' : Math.abs(c.aspect - wo / ho) < 1e-3 ? 'orig' : String(c.aspect);
  const setAspect = (v: string) => {
    const a = v === 'free' ? null : v === 'orig' ? wo / ho : parseFloat(v);
    const r = maxCrop(a, c.angle, wo, ho);
    commitSettings('Crop Aspect', { ...deepClone(s), crop: { ...c, ...r, aspect: a } });
  };
  const rotate = (deg: 90 | -90) =>
    updateSettings(deg > 0 ? 'Rotate Right' : 'Rotate Left', (d) => {
      d.orient.rotate = (((d.orient.rotate + deg) % 360) + 360) % 360 as 0 | 90 | 180 | 270;
      d.crop = { x: 0, y: 0, w: 1, h: 1, angle: 0, aspect: null };
    });
  const flip = (axis: 'h' | 'v') =>
    updateSettings(axis === 'h' ? 'Flip Horizontal' : 'Flip Vertical', (d) => {
      if (axis === 'h') {
        d.orient.flipH = !d.orient.flipH;
        d.crop.x = 1 - d.crop.x - d.crop.w;
      } else {
        d.orient.flipV = !d.orient.flipV;
        d.crop.y = 1 - d.crop.y - d.crop.h;
      }
      d.crop.angle = -d.crop.angle;
    });
  return (
    <Panel title="Crop & Straighten" id="dev-crop-tool">
      <div className="field">
        <span className="field-label">Aspect</span>
        <select value={aspectValue} onChange={(e) => setAspect(e.target.value)} aria-label="Crop aspect ratio">
          {ASPECTS.map((a) => (
            <option key={a.label} value={a.value === null ? 'free' : a.value === 'orig' ? 'orig' : String(a.value)}>
              {a.label}
            </option>
          ))}
        </select>
      </div>
      <Slider
        label="Angle"
        value={c.angle}
        min={-45}
        max={45}
        step={0.1}
        format={(v) => `${v.toFixed(1)}°`}
        onChange={(angle) => liveSettings({ ...deepClone(s), crop: { ...c, ...constrainCrop(c, angle, wo, ho), angle } })}
        onCommit={(angle) => commitSettings('Straighten', { ...deepClone(s), crop: { ...c, ...constrainCrop(c, angle, wo, ho), angle } })}
      />
      <div className="row wrap" style={{ marginTop: 6 }}>
        <IconButton title="Rotate left" onClick={() => rotate(-90)}>
          <RotateCcw size={15} />
        </IconButton>
        <IconButton title="Rotate right" onClick={() => rotate(90)}>
          <RotateCw size={15} />
        </IconButton>
        <IconButton title="Flip horizontal" onClick={() => flip('h')}>
          <FlipHorizontal size={15} />
        </IconButton>
        <IconButton title="Flip vertical" onClick={() => flip('v')}>
          <FlipVertical size={15} />
        </IconButton>
        <div className="grow" />
        <Button small onClick={() => commitSettings('Reset Crop', { ...deepClone(s), crop: { x: 0, y: 0, w: 1, h: 1, angle: 0, aspect: null } })}>Reset</Button>
      </div>
      <div className="row" style={{ marginTop: 10, justifyContent: 'flex-end' }}>
        <Button small onClick={onCancel}>Cancel</Button>
        <Button small primary onClick={onDone}>Done</Button>
      </div>
      <p className="hint">Drag corners to resize, inside to move, outside the frame to rotate. Enter applies, Esc cancels.</p>
    </Panel>
  );
}

const SPOT_MODES: { value: SpotMode; label: string; title: string }[] = [
  { value: 'heal', label: 'Heal', title: 'Blend texture from a nearby area into the spot' },
  { value: 'clone', label: 'Clone', title: 'Copy a nearby area exactly' },
  { value: 'redeye', label: 'Red Eye', title: 'Neutralize red pupils from flash' },
];

function TouchUpPanel({
  s,
  activeSpot,
  opts,
  longEdge,
  onNewSource,
  onDelete,
}: {
  s: DevelopSettings;
  activeSpot: string | null;
  opts: SpotOptions;
  longEdge: number;
  onNewSource: () => void;
  onDelete: (id: string) => void;
}) {
  const sp = s.spots.find((x) => x.id === activeSpot) ?? null;
  const mode = sp?.mode ?? opts.mode;
  const edit = (label: string, f: (x: RetouchSpot) => void, doCommit = true) =>
    updateSettings(
      label,
      (d) => {
        const x = d.spots.find((y) => y.id === activeSpot);
        if (x) f(x);
      },
      doCommit,
    );
  const setMode = (m: SpotMode) => {
    setSpotOpts({ mode: m });
    if (!sp || sp.mode === m) return;
    // Heal and Clone swap on the selected spot (as in Lightroom). Red eye is a different kind of fix,
    // so switching to or from it deselects instead, and the next click places a new spot.
    if (sp.mode === 'redeye' || m === 'redeye') {
      dev.set({ activeSpot: null });
      return;
    }
    edit('Spot Mode', (x) => (x.mode = m));
  };
  const sizePx = Math.max(1, Math.round((sp ? sp.r : opts.size) * longEdge));
  const maxPx = Math.max(20, Math.min(800, Math.round(longEdge * 0.25)));
  const setSize = (px: number, label: string) => {
    const r = Math.min(0.25, Math.max(1 / longEdge, px / longEdge));
    setSpotOpts({ size: r });
    if (sp) edit(label, (x) => (x.r = r), !!label);
  };
  const pct = (key: 'feather' | 'opacity' | 'darken', label: string, def: number) => (
    <Slider
      label={label}
      value={sp ? sp[key] : opts[key]}
      min={0}
      max={100}
      defaultValue={def}
      onChange={(v) => {
        setSpotOpts({ [key]: v });
        if (sp) edit('', (x) => (x[key] = v), false);
      }}
      onCommit={(v) => sp && edit(`Spot ${label} ${Math.round(v)}`, (x) => (x[key] = v))}
    />
  );
  return (
    <Panel title="Touch Up" id="dev-touchup-tool">
      <Segmented value={mode} onChange={setMode} options={SPOT_MODES} className="full" />
      <Slider
        label={mode === 'redeye' ? 'Pupil Size' : 'Size'}
        value={Math.min(sizePx, maxPx)}
        min={1}
        max={maxPx}
        defaultValue={Math.round(0.012 * longEdge)}
        format={(v) => `${Math.round(v)} px`}
        onChange={(v) => setSize(v, '')}
        onCommit={(v) => sp && setSize(v, `Spot Size ${Math.round(v)}`)}
      />
      {pct('feather', 'Feather', 40)}
      {mode === 'redeye' ? pct('darken', 'Darken', 50) : pct('opacity', 'Opacity', 100)}
      <div className="row wrap" style={{ marginTop: 8 }}>
        {sp && sp.mode !== 'redeye' && (
          <Button small onClick={onNewSource} title="Pick another source area (/)">
            <RefreshCw size={12} /> New Source
          </Button>
        )}
        {sp && (
          <Button small onClick={() => onDelete(sp.id)} title="Delete the selected spot (⌫)">
            <Trash size={12} /> Delete
          </Button>
        )}
        <div className="grow" />
        {s.spots.length > 0 && (
          <Button
            small
            onClick={() => {
              commitSettings('Clear Touch Up', { ...deepClone(s), spots: [] });
              dev.set({ activeSpot: null });
            }}
          >
            Clear All
          </Button>
        )}
      </div>
      <p className="hint">
        {mode === 'redeye'
          ? 'Click each red pupil. Size the circle to cover the pupil; only red pixels change.'
          : 'Click a blemish, or drag to paint over a larger area. LightShop picks a matching source; drag the dashed circle to choose another.'}{' '}
        [ ] change size, / new source, ⌫ deletes, hold Space to pan.
        {s.spots.length > 0 && ` ${s.spots.length} spot${s.spots.length === 1 ? '' : 's'}.`}
      </p>
    </Panel>
  );
}

const LOCAL_SLIDERS: { key: keyof LocalAdjust; label: string; min: number; max: number; step?: number }[] = [
  { key: 'exposure', label: 'Exposure', min: -4, max: 4, step: 0.01 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100 },
  { key: 'temperature', label: 'Temp', min: -100, max: 100 },
  { key: 'tint', label: 'Tint', min: -100, max: 100 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100 },
  { key: 'clarity', label: 'Clarity', min: -100, max: 100 },
];

function MasksPanel({ s, activeMask }: { s: DevelopSettings; activeMask: string | null }) {
  const m = s.masks.find((x) => x.id === activeMask);
  const add = (type: 'radial' | 'linear') => {
    if (s.masks.length >= 8) return toast('Up to 8 masks per photo', 'error');
    const mask = newMask(type, s.masks.length + 1);
    commitSettings(`Add ${type === 'radial' ? 'Radial' : 'Linear'} Mask`, { ...deepClone(s), masks: [...s.masks, mask] });
    dev.set({ activeMask: mask.id });
  };
  const edit = (label: string, f: (mm: DevelopSettings['masks'][number]) => void, doCommit = true) =>
    updateSettings(
      label,
      (d) => {
        const mm = d.masks.find((x) => x.id === activeMask);
        if (mm) f(mm);
      },
      doCommit,
    );
  return (
    <Panel title="Masks" id="dev-masks-tool">
      <div className="row" style={{ marginBottom: 6 }}>
        <Button small onClick={() => add('radial')}>+ Radial</Button>
        <Button small onClick={() => add('linear')}>+ Linear</Button>
      </div>
      {s.masks.map((x) => (
        <div key={x.id} className={cx('mask-item', x.id === activeMask && 'active')} onClick={() => dev.set({ activeMask: x.id })}>
          <input
            type="checkbox"
            checked={x.enabled}
            onClick={(e) => e.stopPropagation()}
            onChange={() => updateSettings('Toggle Mask', (d) => {
              const mm = d.masks.find((y) => y.id === x.id);
              if (mm) mm.enabled = !mm.enabled;
            })}
            aria-label={`Enable ${x.name}`}
          />
          <span className="grow">{x.name}</span>
          <button
            className="icon-btn"
            style={{ width: 20, height: 20 }}
            title="Delete mask"
            onClick={(e) => {
              e.stopPropagation();
              updateSettings('Delete Mask', (d) => (d.masks = d.masks.filter((y) => y.id !== x.id)));
              if (activeMask === x.id) dev.set({ activeMask: null });
            }}
          >
            <Trash size={12} />
          </button>
        </div>
      ))}
      {!s.masks.length && <div className="hint">Add a radial or linear gradient, then drag its handles on the image.</div>}
      {m && (
        <>
          <label className="check">
            <input type="checkbox" checked={m.invert} onChange={() => edit('Invert Mask', (mm) => (mm.invert = !mm.invert))} /> Invert
          </label>
          {m.type === 'radial' && (
            <>
              <Slider label="Feather" value={m.radial.feather} min={0} max={100} defaultValue={50} onChange={(v) => edit('', (mm) => (mm.radial.feather = v), false)} onCommit={(v) => edit('Mask Feather', (mm) => (mm.radial.feather = v))} />
              <Slider label="Angle" value={m.radial.angle} min={-90} max={90} format={(v) => `${Math.round(v)}°`} onChange={(v) => edit('', (mm) => (mm.radial.angle = v), false)} onCommit={(v) => edit('Mask Angle', (mm) => (mm.radial.angle = v))} />
            </>
          )}
          <div className="subhead">Adjustments</div>
          {LOCAL_SLIDERS.map((ls) => (
            <Slider
              key={ls.key}
              label={ls.label}
              value={m.adjust[ls.key]}
              min={ls.min}
              max={ls.max}
              step={ls.step ?? 1}
              format={(v) => (ls.step ? (v > 0 ? '+' : '') + v.toFixed(2) : (v > 0 ? '+' : '') + Math.round(v))}
              onChange={(v) => edit('', (mm) => (mm.adjust[ls.key] = v), false)}
              onCommit={(v) => edit(`Mask ${ls.label}`, (mm) => (mm.adjust[ls.key] = v))}
            />
          ))}
          <Button small onClick={() => dev.set({ activeMask: null })}>
            <X size={12} /> Deselect
          </Button>
        </>
      )}
    </Panel>
  );
}
