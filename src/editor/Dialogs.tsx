import { useEffect, useRef, useState } from 'react';
import { createStore } from '../state/store';
import { createCanvas, ctx2d, fitCanvas } from '../lib/imageio';
import { debounce } from '../lib/util';
import { Button, Field, Modal, NumberInput, Slider } from '../ui/controls';
import { AdjustmentPanels } from '../develop/DevelopPanels';
import { DevelopRenderer, Histogram, computeHistogram, mountRenderer, unmountRenderer } from '../develop/renderer';
import { DevelopSettings, defaultSettings } from '../develop/settings';
import { fitRect } from '../develop/geometry';
import { toast } from '../state/app';
import { ADJ_LABELS, AdjType, Adjustment, adjustmentFilter, defaultAdjustment } from './adjust';
import { AdjustmentEditor } from './AdjustmentEditor';
import { applyAdjustmentDestructive, applyToActive, featherSelection, resizeCanvas, resizeImage } from './actions';
import { EditorDoc, isPixel } from './doc';
import { FILTERS, blendThroughMask } from './filters';
import { editor, newDocument } from './session';

export type Dialog =
  | { kind: 'new' }
  | { kind: 'imageSize' }
  | { kind: 'canvasSize' }
  | { kind: 'filter'; id: string }
  | { kind: 'adjust'; type: AdjType }
  | { kind: 'develop' }
  | { kind: 'feather' };

export const ui = createStore<{ dialog: Dialog | null }>({ dialog: null });
export const openDialog = (d: Dialog) => ui.set({ dialog: d });
const close = () => ui.set({ dialog: null });

export function Dialogs({ doc }: { doc: EditorDoc | null }) {
  const d = ui.use((s) => s.dialog);
  if (!d) return null;
  if (d.kind === 'new') return <NewDocDialog />;
  if (!doc) return null;
  switch (d.kind) {
    case 'imageSize':
      return <ImageSizeDialog doc={doc} />;
    case 'canvasSize':
      return <CanvasSizeDialog doc={doc} />;
    case 'filter':
      return <FilterDialog doc={doc} id={d.id} key={d.id} />;
    case 'adjust':
      return <AdjustDialog doc={doc} type={d.type} key={d.type} />;
    case 'develop':
      return <DevelopFilterDialog doc={doc} />;
    case 'feather':
      return <FeatherDialog doc={doc} />;
  }
}

const PRESETS: { label: string; w: number; h: number }[] = [
  { label: 'HD 1920 × 1080', w: 1920, h: 1080 },
  { label: '4K 3840 × 2160', w: 3840, h: 2160 },
  { label: 'Square 2048', w: 2048, h: 2048 },
  { label: 'Instagram 1080 × 1350', w: 1080, h: 1350 },
  { label: 'A4 @300ppi', w: 2480, h: 3508 },
  { label: 'Letter @300ppi', w: 2550, h: 3300 },
];

function NewDocDialog() {
  const [name, setName] = useState('Untitled');
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [bg, setBg] = useState<'white' | 'black' | 'transparent' | 'background'>('white');
  const create = () => {
    const fill = bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : bg === 'background' ? editor.get().bg : null;
    newDocument(name || 'Untitled', Math.max(1, Math.min(16000, w)), Math.max(1, Math.min(16000, h)), fill);
    close();
  };
  return (
    <Modal title="New Document" onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button primary onClick={create}>Create</Button></>}>
      <Field label="Name">
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') create(); }} />
      </Field>
      <Field label="Preset">
        <select
          value=""
          onChange={(e) => {
            const p = PRESETS[+e.target.value];
            if (p) {
              setW(p.w);
              setH(p.h);
            }
          }}
        >
          <option value="">Choose…</option>
          {PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Width (px)">
        <NumberInput value={w} min={1} max={16000} onChange={setW} width={90} ariaLabel="Width" />
      </Field>
      <Field label="Height (px)">
        <NumberInput value={h} min={1} max={16000} onChange={setH} width={90} ariaLabel="Height" />
      </Field>
      <Field label="Background">
        <select value={bg} onChange={(e) => setBg(e.target.value as typeof bg)}>
          <option value="white">White</option>
          <option value="black">Black</option>
          <option value="background">Background color</option>
          <option value="transparent">Transparent</option>
        </select>
      </Field>
    </Modal>
  );
}

function ImageSizeDialog({ doc }: { doc: EditorDoc }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [lock, setLock] = useState(true);
  const ratio = doc.width / doc.height;
  const ok = () => {
    resizeImage(doc, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));
    close();
  };
  return (
    <Modal title="Image Size" onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button primary onClick={ok}>OK</Button></>}>
      <Field label="Width (px)">
        <NumberInput value={w} min={1} max={16000} width={90} ariaLabel="Width" onChange={(v) => { setW(v); if (lock) setH(Math.round(v / ratio)); }} />
      </Field>
      <Field label="Height (px)">
        <NumberInput value={h} min={1} max={16000} width={90} ariaLabel="Height" onChange={(v) => { setH(v); if (lock) setW(Math.round(v * ratio)); }} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={lock} onChange={(e) => setLock(e.target.checked)} /> Constrain proportions
      </label>
      <div className="hint">Current: {doc.width} × {doc.height} px. Resampling uses high-quality smoothing.</div>
    </Modal>
  );
}

function CanvasSizeDialog({ doc }: { doc: EditorDoc }) {
  const [w, setW] = useState(doc.width);
  const [h, setH] = useState(doc.height);
  const [anchor, setAnchor] = useState<[number, number]>([0.5, 0.5]);
  const ok = () => {
    resizeCanvas(doc, Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), anchor[0], anchor[1]);
    close();
  };
  return (
    <Modal title="Canvas Size" onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button primary onClick={ok}>OK</Button></>}>
      <Field label="Width (px)">
        <NumberInput value={w} min={1} max={16000} width={90} ariaLabel="Width" onChange={setW} />
      </Field>
      <Field label="Height (px)">
        <NumberInput value={h} min={1} max={16000} width={90} ariaLabel="Height" onChange={setH} />
      </Field>
      <Field label="Anchor">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 22px)', gap: 3 }} role="radiogroup" aria-label="Anchor">
          {[0, 0.5, 1].flatMap((ay) =>
            [0, 0.5, 1].map((ax) => (
              <button
                key={`${ax}-${ay}`}
                role="radio"
                aria-checked={anchor[0] === ax && anchor[1] === ay}
                style={{ width: 22, height: 22, borderRadius: 3, border: '1px solid var(--line2)', background: anchor[0] === ax && anchor[1] === ay ? 'var(--accent)' : 'var(--bg0)' }}
                onClick={() => setAnchor([ax, ay])}
                aria-label={`Anchor ${ax},${ay}`}
              />
            )),
          )}
        </div>
      </Field>
    </Modal>
  );
}

/** Shared live-preview plumbing for filter-like dialogs on the active layer (or its mask). */
function usePreview(doc: EditorDoc, make: (src: HTMLCanvasElement) => HTMLCanvasElement | null, deps: unknown[]) {
  const target = useRef(doc.active);
  const [busy, setBusy] = useState(false);
  const run = useRef(
    debounce((f: typeof make) => {
      const l = target.current;
      if (!l) return;
      const onMask = doc.editMask && !!l.mask;
      const src = onMask ? l.mask! : isPixel(l) ? l.canvas : null;
      if (!src) return;
      const res = f(src);
      if (!res) return;
      if (onMask) {
        doc.preview = { kind: 'mask-replace', layerId: l.id, canvas: doc.selection ? blendThroughMask(src, res, doc.selection.mask, 0, 0) : res };
      } else if (isPixel(l)) {
        doc.preview = { kind: 'replace', layerId: l.id, canvas: doc.selection ? blendThroughMask(src, res, doc.selection.mask, l.x, l.y) : res, x: l.x, y: l.y };
      }
      setBusy(false);
      doc.invalidate();
    }, 120),
  );
  useEffect(() => {
    setBusy(true);
    run.current(make);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(
    () => () => {
      run.current.cancel();
      doc.preview = null;
      doc.invalidate();
    },
    [doc],
  );
  return busy;
}

function FilterDialog({ doc, id }: { doc: EditorDoc; id: string }) {
  const def = FILTERS.find((f) => f.id === id)!;
  const [p, setP] = useState<Record<string, number>>(() => Object.fromEntries(def.params.map((x) => [x.key, x.def])));
  const [flags, setFlags] = useState<Record<string, boolean>>(() => Object.fromEntries((def.checks ?? []).map((x) => [x.key, x.def])));
  const [previewOn, setPreviewOn] = useState(true);
  const colors = { fg: editor.get().fg, bg: editor.get().bg };
  const busy = usePreview(doc, (src) => (previewOn ? def.run(src, p, flags, colors) : src), [p, flags, previewOn]);
  const ok = () => {
    doc.preview = null;
    applyToActive(doc, def.label.replace('…', ''), (src) => def.run(src, p, flags, colors));
    close();
  };
  return (
    <div className="filter-dialog" role="dialog" aria-label={def.label}>
      <header>
        {def.label.replace('…', '')} {busy && <span className="muted">…</span>}
      </header>
      <div className="body">
        {def.params.map((x) => (
          <Slider key={x.key} label={x.label} value={p[x.key]} min={x.min} max={x.max} step={x.step ?? 1} defaultValue={x.def} format={(v) => `${x.step && x.step < 1 ? v.toFixed(1) : Math.round(v)}${x.unit ?? ''}`} onChange={(v) => setP((o) => ({ ...o, [x.key]: v }))} />
        ))}
        {(def.checks ?? []).map((x) => (
          <label key={x.key} className="check">
            <input type="checkbox" checked={flags[x.key]} onChange={(e) => setFlags((o) => ({ ...o, [x.key]: e.target.checked }))} /> {x.label}
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={previewOn} onChange={(e) => setPreviewOn(e.target.checked)} /> Preview
        </label>
      </div>
      <footer>
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={ok}>OK</Button>
      </footer>
    </div>
  );
}

function AdjustDialog({ doc, type }: { doc: EditorDoc; type: AdjType }) {
  const [a, setA] = useState<Adjustment>(() => defaultAdjustment(type));
  const busy = usePreview(
    doc,
    (src) => {
      const out = createCanvas(src.width, src.height);
      const ctx = ctx2d(out);
      ctx.filter = adjustmentFilter(a);
      ctx.drawImage(src, 0, 0);
      return out;
    },
    [a],
  );
  const ok = () => {
    doc.preview = null;
    applyAdjustmentDestructive(doc, a);
    close();
  };
  return (
    <div className="filter-dialog" role="dialog" aria-label={ADJ_LABELS[type]}>
      <header>
        {ADJ_LABELS[type]} {busy && <span className="muted">…</span>}
      </header>
      <div className="body">
        <AdjustmentEditor value={a} onChange={setA} onCommit={setA} />
        <div className="hint">Tip: Layer › New Adjustment Layer applies this non-destructively.</div>
      </div>
      <footer>
        <Button onClick={close}>Cancel</Button>
        <Button primary onClick={ok}>OK</Button>
      </footer>
    </div>
  );
}

function FeatherDialog({ doc }: { doc: EditorDoc }) {
  const [r, setR] = useState(8);
  return (
    <Modal title="Feather Selection" onClose={close} footer={<><Button onClick={close}>Cancel</Button><Button primary onClick={() => { featherSelection(doc, r); close(); }}>OK</Button></>}>
      <Slider label="Feather radius" value={r} min={0.5} max={250} step={0.5} defaultValue={8} format={(v) => `${v.toFixed(1)} px`} onChange={setR} />
    </Modal>
  );
}

/** Develop module as a Photoshop-style "Camera Raw Filter" on the active layer. */
function DevelopFilterDialog({ doc }: { doc: EditorDoc }) {
  const l = doc.active;
  const viewRef = useRef<HTMLDivElement>(null);
  const glHostRef = useRef<HTMLDivElement>(null);
  const rRef = useRef<DevelopRenderer | null>(null);
  const [s, setS] = useState<DevelopSettings>(defaultSettings);
  const [hist, setHist] = useState<Histogram | null>(null);
  const [before, setBefore] = useState(false);
  const [applying, setApplying] = useState(false);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const src = isPixel(l) ? l.canvas : null;

  useEffect(() => {
    if (!src) return;
    let r: DevelopRenderer;
    try {
      r = mountRenderer(glHostRef.current!);
    } catch (e) {
      toast(`Develop filter unavailable: ${(e as Error).message}`, 'error');
      close();
      return;
    }
    rRef.current = r;
    r.setImage(fitCanvas(src, 2048), src.width, src.height);
    const el = viewRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    // A remount gets a fresh renderer, so make the draw effect run again.
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => {
      ro.disconnect();
      unmountRenderer(r);
      rRef.current = null;
    };
  }, [src]);

  useEffect(() => {
    const r = rRef.current;
    if (!r || !size.w || !src) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(size.w * dpr);
    const H = Math.round(size.h * dpr);
    const rect = fitRect(src.width, src.height, W, H, 16 * dpr);
    r.draw(s, { targetW: W, targetH: H, rect: [rect.x, rect.y, rect.w, rect.h], before, bg: [0.08, 0.08, 0.09] });
    const t = setTimeout(() => {
      const k = Math.min(1, 240 / Math.max(src.width, src.height));
      const img = r.renderPixels(s, Math.max(1, Math.round(src.width * k)), Math.max(1, Math.round(src.height * k)), { key: 'hist', before });
      setHist(computeHistogram(img.data));
    }, 120);
    return () => clearTimeout(t);
  }, [s, size, before, src]);

  if (!src || !l || !isPixel(l)) {
    return (
      <Modal title="Develop Filter" onClose={close}>
        Select a pixel layer to use the Develop filter.
      </Modal>
    );
  }

  const apply = async () => {
    setApplying(true);
    await new Promise((r) => setTimeout(r, 30));
    const r = new DevelopRenderer();
    try {
      if (Math.max(src.width, src.height) > r.maxTexture) throw new Error('Layer is too large for the GPU');
      r.setImage(src, src.width, src.height);
      const data = r.renderPixels(s, src.width, src.height);
      applyToActive(doc, 'Develop Filter', (orig) => {
        const out = createCanvas(orig.width, orig.height);
        const ctx = ctx2d(out);
        ctx.putImageData(data, 0, 0);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.drawImage(orig, 0, 0); // keep the layer's transparency
        return out;
      });
      close();
    } catch (e) {
      toast(`Develop filter failed: ${(e as Error).message}`, 'error');
      setApplying(false);
    } finally {
      r.dispose();
    }
  };

  return (
    <div className="dev-filter" role="dialog" aria-label="Develop filter">
      <div className="dev-view" ref={viewRef}>
        <div className="gl-host" ref={glHostRef} />
        <div className="dev-label">Develop Filter · {l.name}{before ? ' · Before' : ''}</div>
      </div>
      <aside className="side right">
        <AdjustmentPanels
          s={s}
          showHistogram
          hist={hist}
          sample={rRef.current?.sample ?? null}
          live={(f) => setS((cur) => { const n = structuredClone(cur); f(n); return n; })}
          commit={(_label, f) => setS((cur) => { const n = structuredClone(cur); f?.(n); return n; })}
        />
      </aside>
      <div className="dev-toolbar">
        <Button small onClick={() => setBefore(!before)}>{before ? 'Show after' : 'Show before'}</Button>
        <Button small onClick={() => setS(defaultSettings())}>Reset</Button>
        <div className="grow" />
        <Button onClick={close} disabled={applying}>Cancel</Button>
        <Button primary onClick={apply} disabled={applying}>{applying ? 'Applying…' : 'OK'}</Button>
      </div>
    </div>
  );
}
