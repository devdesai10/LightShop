import { useEffect, useRef, useState } from 'react';
import {
  Brush, Crop, Eraser, FilePlus, FolderOpen, Hand, Lasso, Move, PaintBucket, Pipette, Bandage, Save, Scaling, Shapes, SquareDashed, Stamp, Type, WandSparkles, X, ZoomIn, Blend,
} from 'lucide-react';
import { app, toast } from '../state/app';
import { useEmitter } from '../state/store';
import { checkerPattern, decodeImage, createCanvas, ctx2d } from '../lib/imageio';
import { isMac, isTypingTarget, modKey, modLabel, pickFiles } from '../lib/util';
import { Button, IconButton, cx } from '../ui/controls';
import { tipProps } from '../ui/Tooltip';
import { ADJ_LABELS, defaultAdjustment } from './adjust';
import * as A from './actions';
import { EditorDoc, TextProps, textFont } from './doc';
import { Dialogs, openDialog, ui } from './Dialogs';
import { MenuBar } from './Menus';
import { ColorPanel, FONTS, HistoryPanel, LayersPanel, PropertiesPanel } from './Panels';
import { ToolId, closeDoc, editor, openFilesInEditor, saveDocToLibrary, setOpts, showDoc } from './session';
import { TOOLS, Tool, ToolCtx, ToolEvent, applyCrop, hand, hasPendingCrop, isMoving, selectTool, toolCtx } from './tools';
import { dpr, fitView, getView, refit, setActualPixels, setView, setViewportSize, zoomBy } from './viewState';
import { attachViewGestures } from '../lib/gestures';
import { CropOptions, ExpandProgress } from './CropOptions';
import { ScaleOptions } from './ScaleOptions';
import { carryMoveTo, clearTabHover, drawDropPreview, dropMoveOnTab, hoverTab, layerDrag, rowDragLeave, rowDragOver, rowDrop, tabAt, tabDragProps } from './layerDrag';

const ALT = isMac ? '⌥' : 'Alt';

/** The toolbox, top to bottom: name, shortcut keys and what it does (shown when hovering). `sep` starts a group. */
const TOOL_LIST: { id: ToolId; label: string; keys: string[]; tip: string; icon: React.ReactNode; sep?: boolean }[] = [
  { id: 'move', label: 'Move', keys: ['V'], tip: "Drag to move the layer or the selected pixels. Drag onto another document's tab to copy it there.", icon: <Move size={17} /> },
  { id: 'scale', label: 'Scale', keys: ['K', `${modLabel}T`], tip: `Drag a handle to resize the layer or the selected pixels. Shift frees the proportions; ${ALT} scales from the center.`, icon: <Scaling size={17} /> },
  { id: 'marquee', label: 'Marquee', keys: ['M'], tip: `Drag to select a rectangle or an ellipse (⇧M switches). Shift adds to the selection; ${ALT} subtracts.`, icon: <SquareDashed size={17} /> },
  { id: 'lasso', label: 'Lasso', keys: ['L'], tip: 'Drag to draw a freehand selection. ⇧L switches to straight sides (polygonal).', icon: <Lasso size={17} /> },
  { id: 'wand', label: 'Magic Wand', keys: ['W'], tip: 'Click to select an area of similar color.', icon: <WandSparkles size={17} /> },
  { id: 'crop', label: 'Crop', keys: ['C'], tip: 'Drag to crop. Drag past the edges, or pick a size, to expand the canvas.', icon: <Crop size={17} />, sep: true },
  { id: 'eyedropper', label: 'Eyedropper', keys: ['I'], tip: `Click to pick the foreground color; ${ALT}-click picks the background color.`, icon: <Pipette size={17} /> },
  { id: 'heal', label: 'Spot Healing Brush', keys: ['J'], tip: 'Paint over spots and blemishes to blend them into their surroundings.', icon: <Bandage size={17} />, sep: true },
  { id: 'brush', label: 'Brush', keys: ['B'], tip: 'Paint with the foreground color. [ and ] change the size; 1 to 0 set the opacity.', icon: <Brush size={17} /> },
  { id: 'clone', label: 'Clone Stamp', keys: ['S'], tip: `${ALT}-click to set the source, then paint to copy from it.`, icon: <Stamp size={17} /> },
  { id: 'eraser', label: 'Eraser', keys: ['E'], tip: 'Erase to transparency. [ and ] change the size.', icon: <Eraser size={17} /> },
  { id: 'gradient', label: 'Gradient', keys: ['G'], tip: 'Drag to draw a gradient from the foreground to the background color.', icon: <Blend size={17} /> },
  { id: 'bucket', label: 'Paint Bucket', keys: ['⇧G'], tip: 'Click to fill an area of similar color with the foreground color.', icon: <PaintBucket size={17} /> },
  { id: 'text', label: 'Type', keys: ['T'], tip: 'Click to add text, or click existing text to edit it.', icon: <Type size={17} />, sep: true },
  { id: 'shape', label: 'Shape', keys: ['U'], tip: 'Drag to draw a rectangle, ellipse or line.', icon: <Shapes size={17} /> },
  { id: 'hand', label: 'Hand', keys: ['H', 'Space'], tip: 'Drag to move around the image. Hold Space to use it with any tool.', icon: <Hand size={17} />, sep: true },
  { id: 'zoom', label: 'Zoom', keys: ['Z'], tip: `Click to zoom in; ${ALT}-click zooms out.`, icon: <ZoomIn size={17} /> },
];

const KEY_TOOLS: Record<string, ToolId> = { v: 'move', k: 'scale', m: 'marquee', l: 'lasso', w: 'wand', c: 'crop', i: 'eyedropper', j: 'heal', b: 'brush', s: 'clone', e: 'eraser', g: 'gradient', t: 'text', u: 'shape', h: 'hand', z: 'zoom' };

const setTool = selectTool;

// ---------------------------------------------------------------- Toolbar
function Toolbar() {
  const tool = editor.use((s) => s.tool);
  const fg = editor.use((s) => s.fg);
  const bg = editor.use((s) => s.bg);
  const fgRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLInputElement>(null);
  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      {TOOL_LIST.map((t) => (
        <span key={t.id} style={{ display: 'contents' }}>
          {t.sep && <div className="tool-sep" />}
          <IconButton title={t.label} active={tool === t.id} onClick={() => setTool(t.id)} tip={{ keys: t.keys, text: t.tip }}>
            {t.icon}
          </IconButton>
        </span>
      ))}
      <div className="swatches">
        <button
          className="sw fg"
          style={{ background: fg }}
          onClick={() => fgRef.current?.click()}
          aria-label="Foreground color"
          {...tipProps({ title: 'Foreground color', text: 'The brush, type, shapes and fills use it. Click to change it.' })}
        />
        <button
          className="sw bg"
          style={{ background: bg }}
          onClick={() => bgRef.current?.click()}
          aria-label="Background color"
          {...tipProps({ title: 'Background color', text: 'Gradients run to it and shape outlines use it. Click to change it.' })}
        />
        <button className="swap" onClick={() => editor.set({ fg: bg, bg: fg })} aria-label="Swap colors" {...tipProps({ title: 'Swap colors', keys: ['X'] })}>
          ⇄
        </button>
        <button
          className="reset"
          onClick={() => editor.set({ fg: '#000000', bg: '#ffffff' })}
          aria-label="Default colors"
          {...tipProps({ title: 'Default colors', keys: ['D'], text: 'Black foreground, white background.' })}
        />
        <input ref={fgRef} type="color" value={fg} onChange={(e) => editor.set({ fg: e.target.value })} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }} tabIndex={-1} />
        <input ref={bgRef} type="color" value={bg} onChange={(e) => editor.set({ bg: e.target.value })} style={{ position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 }} tabIndex={-1} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Options bar
function Range({ label, value, min, max, onChange, suffix = '' }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void; suffix?: string }) {
  return (
    <label className="opt">
      {label}
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(+e.target.value)} aria-label={label} />
      <span style={{ width: 42, color: 'var(--text)' }}>
        {Math.round(value)}
        {suffix}
      </span>
    </label>
  );
}

function Check({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="opt">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function ModeSelect({ value, onChange }: { value: string; onChange: (v: 'new' | 'add' | 'subtract' | 'intersect') => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as 'new')} aria-label="Selection mode" title="Shift = add, Alt = subtract">
      <option value="new">New selection</option>
      <option value="add">Add to selection</option>
      <option value="subtract">Subtract</option>
      <option value="intersect">Intersect</option>
    </select>
  );
}

function OptionsBar({ doc }: { doc: EditorDoc | null }) {
  const tool = editor.use((s) => s.tool);
  const o = editor.use((s) => s.opts);
  const sep = <div className="sep" />;
  const brush = (k: 'brush' | 'eraser' | 'clone') => (
    <>
      <Range label="Size" value={o[k].size} min={1} max={500} suffix="px" onChange={(size) => setOpts(k, { size })} />
      <Range label="Hardness" value={o[k].hardness * 100} min={0} max={100} suffix="%" onChange={(v) => setOpts(k, { hardness: v / 100 })} />
      {sep}
      <Range label="Opacity" value={o[k].opacity * 100} min={1} max={100} suffix="%" onChange={(v) => setOpts(k, { opacity: v / 100 })} />
      <Range label="Flow" value={o[k].flow * 100} min={1} max={100} suffix="%" onChange={(v) => setOpts(k, { flow: v / 100 })} />
    </>
  );
  let body: React.ReactNode = null;
  switch (tool) {
    case 'brush':
    case 'eraser':
      body = brush(tool);
      break;
    case 'clone':
      body = (
        <>
          {brush('clone')}
          {sep}
          <Check label="Aligned" value={o.clone.aligned} onChange={(aligned) => setOpts('clone', { aligned })} />
          <Check label="Sample all layers" value={o.clone.sampleAll} onChange={(sampleAll) => setOpts('clone', { sampleAll })} />
          <span className="muted">Alt-click to set source</span>
        </>
      );
      break;
    case 'heal':
      body = (
        <>
          <Range label="Size" value={o.heal.size} min={2} max={300} suffix="px" onChange={(size) => setOpts('heal', { size })} />
          <Range label="Hardness" value={o.heal.hardness * 100} min={0} max={100} suffix="%" onChange={(v) => setOpts('heal', { hardness: v / 100 })} />
          <span className="muted">Paint over spots and blemishes; texture is borrowed from nearby pixels.</span>
        </>
      );
      break;
    case 'marquee':
      body = (
        <>
          <select value={o.marquee.shape} onChange={(e) => setOpts('marquee', { shape: e.target.value as 'rect' })} aria-label="Marquee shape">
            <option value="rect">Rectangle</option>
            <option value="ellipse">Ellipse</option>
          </select>
          <ModeSelect value={o.marquee.mode} onChange={(mode) => setOpts('marquee', { mode })} />
          <Range label="Feather" value={o.marquee.feather} min={0} max={100} suffix="px" onChange={(feather) => setOpts('marquee', { feather })} />
        </>
      );
      break;
    case 'lasso':
      body = (
        <>
          <Check label="Polygonal" value={o.lasso.polygonal} onChange={(polygonal) => setOpts('lasso', { polygonal })} />
          <ModeSelect value={o.lasso.mode} onChange={(mode) => setOpts('lasso', { mode })} />
          <Range label="Feather" value={o.lasso.feather} min={0} max={100} suffix="px" onChange={(feather) => setOpts('lasso', { feather })} />
          {o.lasso.polygonal && <span className="muted">Click to add points; double-click or Enter to close</span>}
        </>
      );
      break;
    case 'wand':
      body = (
        <>
          <ModeSelect value={o.wand.mode} onChange={(mode) => setOpts('wand', { mode })} />
          <Range label="Tolerance" value={o.wand.tolerance} min={0} max={255} onChange={(tolerance) => setOpts('wand', { tolerance })} />
          <Check label="Contiguous" value={o.wand.contiguous} onChange={(contiguous) => setOpts('wand', { contiguous })} />
          <Check label="Sample all layers" value={o.wand.sampleAll} onChange={(sampleAll) => setOpts('wand', { sampleAll })} />
        </>
      );
      break;
    case 'bucket':
      body = (
        <>
          <Range label="Tolerance" value={o.bucket.tolerance} min={0} max={255} onChange={(tolerance) => setOpts('bucket', { tolerance })} />
          <Range label="Opacity" value={o.bucket.opacity * 100} min={1} max={100} suffix="%" onChange={(v) => setOpts('bucket', { opacity: v / 100 })} />
          <Check label="Contiguous" value={o.bucket.contiguous} onChange={(contiguous) => setOpts('bucket', { contiguous })} />
          <Check label="Sample all layers" value={o.bucket.sampleAll} onChange={(sampleAll) => setOpts('bucket', { sampleAll })} />
        </>
      );
      break;
    case 'gradient':
      body = (
        <>
          <select value={o.gradient.type} onChange={(e) => setOpts('gradient', { type: e.target.value as 'linear' })} aria-label="Gradient type">
            <option value="linear">Linear</option>
            <option value="radial">Radial</option>
          </select>
          <Check label="Foreground to transparent" value={o.gradient.toTransparent} onChange={(toTransparent) => setOpts('gradient', { toTransparent })} />
          <Range label="Opacity" value={o.gradient.opacity * 100} min={1} max={100} suffix="%" onChange={(v) => setOpts('gradient', { opacity: v / 100 })} />
        </>
      );
      break;
    case 'text':
      body = (
        <>
          <select value={o.text.font} onChange={(e) => setOpts('text', { font: e.target.value })} aria-label="Font">
            {FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <Range label="Size" value={o.text.size} min={6} max={400} suffix="px" onChange={(size) => setOpts('text', { size })} />
          <Check label="Bold" value={o.text.bold} onChange={(bold) => setOpts('text', { bold })} />
          <Check label="Italic" value={o.text.italic} onChange={(italic) => setOpts('text', { italic })} />
          <select value={o.text.align} onChange={(e) => setOpts('text', { align: e.target.value as 'left' })} aria-label="Alignment">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
          <span className="muted">Click to type · {`⌘↩`} to commit · Esc to cancel</span>
        </>
      );
      break;
    case 'shape':
      body = (
        <>
          <select value={o.shape.type} onChange={(e) => setOpts('shape', { type: e.target.value as 'rect' })} aria-label="Shape">
            <option value="rect">Rectangle</option>
            <option value="ellipse">Ellipse</option>
            <option value="line">Line</option>
          </select>
          <Check label="Fill (foreground)" value={o.shape.fill} onChange={(fill) => setOpts('shape', { fill })} />
          <Range label="Stroke (background)" value={o.shape.strokeWidth} min={0} max={50} suffix="px" onChange={(strokeWidth) => setOpts('shape', { strokeWidth })} />
        </>
      );
      break;
    case 'crop':
      body = <CropOptions doc={doc} />;
      break;
    case 'scale':
      body = <ScaleOptions doc={doc} />;
      break;
    case 'move':
      body = (
        <>
          <Check label="Auto-select layer" value={o.move.autoSelect} onChange={(autoSelect) => setOpts('move', { autoSelect })} />
          <span className="muted">
            Drag to move; with a selection, moves the selected pixels (Alt duplicates). Arrow keys nudge. Drag onto another document's tab to copy it there.
          </span>
        </>
      );
      break;
    case 'eyedropper':
      body = <span className="muted">Click to pick foreground; Alt-click for background.</span>;
      break;
    case 'hand':
    case 'zoom':
      body = doc && (
        <>
          <Button small onClick={() => fitView(doc)}>Fit Screen</Button>
          <Button small onClick={() => setActualPixels(doc)}>100%</Button>
        </>
      );
      break;
  }
  return (
    <div className="optionsbar" role="toolbar" aria-label="Tool options">
      <strong style={{ minWidth: 90 }}>{TOOL_LIST.find((t) => t.id === tool)?.label}</strong>
      <div className="sep" />
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- Viewport
interface TextEditState {
  layerId: string | null;
  x: number;
  y: number;
  value: string;
  props: TextProps;
}

function Viewport({ doc }: { doc: EditorDoc }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursor, setCursor] = useState('default');
  const [textEdit, setTextEdit] = useState<TextEditState | null>(null);
  const hover = useRef<{ x: number; y: number } | null>(null);
  const spaceDown = useRef(false);
  const dragging = useRef<Tool | null>(null);
  const antsPhase = useRef(0);
  const raf = useRef(0);
  const statusRef = useRef<HTMLSpanElement>(null);
  const tool = editor.use((s) => s.tool);
  useEmitter(doc);

  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      setViewportSize(el.clientWidth, el.clientHeight);
    });
    ro.observe(el);
    setViewportSize(el.clientWidth, el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const ctxFor = (): ToolCtx => ({
    doc,
    st: editor.get(),
    view: getView(doc),
    setView: (v, a) => (Object.keys(v).length ? setView(doc, v, a) : refit(doc)),
    redraw: () => schedule(),
    editText: (layerId, x, y) => startText(layerId, x, y),
    hover: hover.current,
  });

  const sizeRef = useRef(size);
  sizeRef.current = size;
  const draw = () => {
    const c = canvasRef.current;
    const sz = sizeRef.current;
    if (!c || !sz.w) return;
    const d = dpr();
    const W = Math.round(sz.w * d);
    const H = Math.round(sz.h * d);
    if (c.width !== W || c.height !== H) {
      c.width = W;
      c.height = H;
    }
    const g = c.getContext('2d')!;
    const v = getView(doc);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#262629';
    g.fillRect(0, 0, W, H);
    // Snap the document to whole device pixels so the checkerboard can't bleed through its edges.
    const x = Math.round(v.panX * d);
    const y = Math.round(v.panY * d);
    const w = Math.round((v.panX + doc.width * v.zoom) * d) - x;
    const h = Math.round((v.panY + doc.height * v.zoom) * d) - y;
    g.save();
    g.shadowColor = 'rgba(0,0,0,0.5)';
    g.shadowBlur = 14;
    g.fillStyle = checkerPattern(g);
    g.fillRect(x, y, w, h);
    g.restore();
    const comp = doc.getComposite();
    g.imageSmoothingEnabled = v.zoom * d < 2;
    g.imageSmoothingQuality = 'high';
    g.drawImage(comp, x, y, w, h);
    // selection outline (marching ants)
    if (doc.selection) {
      const z = v.zoom * d;
      g.save();
      g.setTransform(z, 0, 0, z, x, y);
      g.lineWidth = 1 / z;
      g.setLineDash([4 / z, 4 / z]);
      g.strokeStyle = '#000';
      g.lineDashOffset = -antsPhase.current / z;
      g.stroke(doc.selection.outline);
      g.strokeStyle = '#fff';
      g.lineDashOffset = -(antsPhase.current + 4) / z;
      g.stroke(doc.selection.outline);
      g.restore();
    }
    // active layer bounds for the move tool
    const al = doc.active;
    if (editor.get().tool === 'move' && al && al.kind !== 'adjust') {
      g.save();
      g.strokeStyle = 'rgba(61,139,253,0.7)';
      g.lineWidth = 1;
      g.strokeRect(x + al.x * v.zoom * d + 0.5, y + al.y * v.zoom * d + 0.5, al.canvas.width * v.zoom * d, al.canvas.height * v.zoom * d);
      g.restore();
    }
    // a layer being dragged in from another document
    drawDropPreview(g, doc, x, y, v.zoom * d);
    g.setTransform(d, 0, 0, d, 0, 0);
    const t = spaceDown.current ? hand : TOOLS[editor.get().tool];
    t.overlay?.(g, ctxFor());
    if (statusRef.current) {
      const p = hover.current;
      statusRef.current.textContent = `${Math.round(v.zoom * d * 100)}%   ·   ${doc.width} × ${doc.height} px${p ? `   ·   ${Math.floor(p.x)}, ${Math.floor(p.y)}` : ''}${doc.selection ? `   ·   selection ${doc.selection.bounds.w} × ${doc.selection.bounds.h}` : ''}`;
    }
  };

  // Always draw with the latest render's closure, even if the frame was requested earlier.
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const schedule = () => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      drawRef.current();
    });
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      raf.current = 0; // a stale id would block schedule() after a StrictMode remount
    },
    [],
  );

  useEffect(() => {
    const u1 = doc.onRender.subscribe(schedule);
    const u2 = layerDrag.subscribe(schedule);
    schedule();
    return () => {
      u1();
      u2();
    };
  });

  useEffect(() => {
    if (!doc.selection) return;
    const id = setInterval(() => {
      antsPhase.current = (antsPhase.current + 1) % 8;
      schedule();
    }, 90);
    return () => clearInterval(id);
  });

  useEffect(() => {
    setCursor(TOOLS[tool].cursor(ctxFor()));
    schedule();
  }, [tool]);

  // ---------------------------------------------------------------- text editing
  const startText = (layerId: string | null, x: number, y: number) => {
    const o = editor.get().opts.text;
    const l = layerId ? doc.layer(layerId) : null;
    const props: TextProps = l && l.kind === 'text' ? { ...l.text } : { ...o, text: '', color: editor.get().fg };
    const pad = Math.ceil(props.size * 0.25);
    if (l && l.kind === 'text') {
      doc.preview = { kind: 'replace', layerId: l.id, canvas: createCanvas(1, 1), x: 0, y: 0 };
      doc.invalidate();
      setTextEdit({ layerId, x: l.x + pad, y: l.y + pad, value: props.text, props });
    } else setTextEdit({ layerId: null, x, y, value: '', props });
  };
  const finishText = (commit: boolean) => {
    const te = textEdit;
    setTextEdit(null);
    doc.preview = null;
    doc.invalidate();
    if (!te || !commit) return;
    const pad = Math.ceil(te.props.size * 0.25);
    if (te.layerId) {
      if (te.value !== te.props.text) A.updateText(doc, te.layerId, { text: te.value }, 'Edit Type');
    } else if (te.value.trim()) {
      A.insertLayer(doc, doc.newText({ ...te.props, text: te.value }, Math.round(te.x - pad), Math.round(te.y - pad)), 'Type Tool');
    }
  };

  // ---------------------------------------------------------------- events
  const toEvent = (e: React.PointerEvent | PointerEvent): ToolEvent => {
    const r = canvasRef.current!.getBoundingClientRect();
    const v = getView(doc);
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    return {
      x: (sx - v.panX) / v.zoom,
      y: (sy - v.panY) / v.zoom,
      sx,
      sy,
      shift: e.shiftKey,
      alt: e.altKey,
      mod: modKey(e),
      pressure: e.pressure || 0.5,
      pen: e.pointerType === 'pen',
      dbl: (e as PointerEvent).detail === 2,
    };
  };

  const onDown = (e: React.PointerEvent) => {
    if (textEdit) {
      finishText(true);
      return;
    }
    if (e.button === 1 || (e.button === 0 && spaceDown.current)) {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragging.current = hand;
      hand.down!(toEvent(e), ctxFor());
      return;
    }
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const t = TOOLS[editor.get().tool];
    dragging.current = t;
    t.down?.(toEvent(e), ctxFor());
    schedule();
  };
  const lastClient = useRef({ x: 0, y: 0 });
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const onMove = (e: React.PointerEvent) => {
    const ev = toEvent(e);
    hover.current = { x: ev.x, y: ev.y };
    lastClient.current = { x: e.clientX, y: e.clientY };
    const live = spaceDown.current ? hand : TOOLS[editor.get().tool];
    if (live.liveCursor) {
      const c = live.cursor(ctxFor());
      if (c !== cursorRef.current) setCursor(c);
    }
    const t = dragging.current;
    if (t) {
      const coalesced = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [];
      if (coalesced.length > 1 && t !== hand) for (const ce of coalesced) t.move?.(toEvent(ce), ctxFor());
      else t.move?.(ev, ctxFor());
      // Moving onto another document's tab: after a moment that document opens and the drag carries a copy.
      if (t === TOOLS.move && isMoving()) {
        const tab = tabAt(e.clientX, e.clientY);
        if (tab && tab !== doc.id) hoverTab(tab, () => isMoving() && carryMoveTo(doc, tab, lastClient.current));
        else clearTabHover();
      }
    } else if (editor.get().tool === 'lasso' && editor.get().opts.lasso.polygonal) TOOLS.lasso.move?.(ev, ctxFor());
    schedule();
  };
  const onUp = (e: React.PointerEvent) => {
    const t = dragging.current;
    dragging.current = null;
    clearTabHover();
    const tab = t === TOOLS.move && isMoving() ? tabAt(e.clientX, e.clientY) : null;
    if (tab && tab !== doc.id) dropMoveOnTab(doc, tab);
    else t?.up?.(toEvent(e), ctxFor());
    setCursor((spaceDown.current ? hand : TOOLS[editor.get().tool]).cursor(ctxFor()));
    schedule();
  };
  useEffect(() => {
    const el = wrapRef.current!;
    // Pinch or ⌘/⌥-scroll zooms at the pointer; two-finger scroll (or the wheel) moves around.
    const detachGestures = attachViewGestures(el, {
      zoom: (f, x, y) => {
        const r = el.getBoundingClientRect();
        const v = getView(doc);
        setView(doc, { zoom: Math.min(64, Math.max(0.01, v.zoom * f)) }, { sx: x - r.left, sy: y - r.top });
      },
      pan: (dx, dy) => {
        const v = getView(doc);
        setView(doc, { panX: v.panX + dx, panY: v.panY + dy });
      },
    });
    const kd = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target) && !spaceDown.current) {
        spaceDown.current = true;
        setCursor('grab');
        e.preventDefault();
      }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceDown.current = false;
        setCursor(TOOLS[editor.get().tool].cursor(ctxFor()));
      }
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => {
      detachGestures();
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
    };
  }, [doc]);

  const v = getView(doc);
  const te = textEdit;
  return (
    <>
      <div
        className="viewport"
        ref={wrapRef}
        data-doc-view={doc.id}
        onDragOver={(e) => {
          if (rowDragOver(e, doc)) return;
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDragLeave={rowDragLeave}
        onDrop={async (e) => {
          if (rowDrop(e, doc)) return;
          const files = Array.from(e.dataTransfer.files);
          if (!files.length) return;
          e.preventDefault();
          e.stopPropagation();
          for (const f of files) {
            if (/\.psd$/i.test(f.name)) await openFilesInEditor([f]);
            else {
              try {
                const img = await decodeImage(f);
                const c = createCanvas(img.width, img.height);
                ctx2d(c).drawImage(img, 0, 0);
                A.pasteCanvas(doc, c, undefined, undefined, f.name.replace(/\.[^.]+$/, ''));
              } catch {
                toast(`Could not place ${f.name}`, 'error');
              }
            }
          }
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ cursor }}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => {
            hover.current = null;
            schedule();
          }}
          onContextMenu={(e) => e.preventDefault()}
          aria-label={`Canvas for ${doc.name}`}
          role="img"
        />
        {te && (
          <textarea
            className="text-edit"
            autoFocus
            value={te.value}
            onChange={(e) => setTextEdit({ ...te, value: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') finishText(false);
              if (e.key === 'Enter' && modKey(e)) finishText(true);
            }}
            onBlur={() => finishText(true)}
            spellCheck={false}
            style={{
              left: te.x * v.zoom + v.panX,
              top: te.y * v.zoom + v.panY,
              font: textFont({ ...te.props, size: te.props.size * v.zoom }),
              lineHeight: `${te.props.size * te.props.lineHeight * v.zoom}px`,
              color: te.props.color,
              textAlign: te.props.align,
              width: Math.max(40, (Math.max(...te.value.split('\n').map((l) => l.length), 2) + 1) * te.props.size * 0.62 * v.zoom),
              height: (te.value.split('\n').length * te.props.lineHeight + 0.2) * te.props.size * v.zoom,
            }}
            aria-label="Type text"
          />
        )}
      </div>
      <div className="statusbar">
        <span ref={statusRef} />
        <span className="grow" />
        <span>{doc.dirty ? 'Unsaved changes' : doc.savedPhotoId ? 'Saved to Library' : ''}</span>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- shortcuts
function useEditorShortcuts(doc: EditorDoc | null) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || document.querySelector('.modal') || ui.get().dialog?.kind === 'develop') return;
      const k = e.key.toLowerCase();
      const mod = modKey(e);
      if (doc) {
        const t = TOOLS[editor.get().tool];
        const ctx: ToolCtx = { doc, st: editor.get(), view: getView(doc), setView: (v, a) => (Object.keys(v).length ? setView(doc, v, a) : refit(doc)), redraw: () => doc.onRender.emit(), editText: () => {}, hover: null };
        if (!mod && t.key?.(e, ctx)) {
          e.preventDefault();
          return;
        }
      }
      if (mod) {
        const map: Record<string, () => void> = {
          t: () => doc && setTool('scale'),
          n: () => (e.shiftKey ? doc && A.newLayer(doc) : openDialog({ kind: 'new' })),
          o: async () => openFilesInEditor(await pickFiles('image/*,.psd', true)),
          s: () => doc && saveDocToLibrary(doc),
          w: () => doc && closeDoc(doc.id),
          z: () => doc && (e.shiftKey ? doc.redo() : doc.undo()),
          y: () => doc?.redo(),
          a: () => (e.shiftKey ? doc && openDialog({ kind: 'develop' }) : doc && A.selectAll(doc)),
          d: () => doc && A.deselect(doc),
          i: () => doc && (e.shiftKey ? A.invertSelection(doc) : e.altKey ? openDialog({ kind: 'imageSize' }) : A.applyAdjustmentDestructive(doc, defaultAdjustment('invert'))),
          c: () => doc && (e.altKey ? openDialog({ kind: 'canvasSize' }) : A.copySelection(doc, e.shiftKey)),
          x: () => doc && A.cutSelection(doc),
          j: () => doc && A.duplicateLayer(doc),
          e: () => doc && (e.shiftKey ? A.mergeVisible(doc) : A.mergeDown(doc)),
          l: () => doc && openDialog({ kind: 'adjust', type: 'levels' }),
          m: () => doc && openDialog({ kind: 'adjust', type: 'curves' }),
          u: () => doc && (e.shiftKey ? A.applyAdjustmentDestructive(doc, { type: 'hueSaturation', hue: 0, saturation: -100, lightness: 0, colorize: false }) : openDialog({ kind: 'adjust', type: 'hueSaturation' })),
          b: () => doc && openDialog({ kind: 'adjust', type: 'colorBalance' }),
          '0': () => doc && fitView(doc),
          '1': () => doc && setActualPixels(doc),
          '=': () => doc && zoomBy(doc, 1.25),
          '+': () => doc && zoomBy(doc, 1.25),
          '-': () => doc && zoomBy(doc, 0.8),
          backspace: () => doc && A.fillSelection(doc, editor.get().bg),
        };
        const f = map[k];
        if (f) {
          e.preventDefault();
          f();
        }
        return;
      }
      if (!doc) return;
      if (k === 'backspace' || k === 'delete') {
        e.preventDefault();
        if (e.altKey) A.fillSelection(doc, editor.get().fg);
        else A.clearSelection(doc);
        return;
      }
      if (e.key === 'F6' && e.shiftKey) return openDialog({ kind: 'feather' });
      if (k === 'x') return editor.set((s) => ({ fg: s.bg, bg: s.fg }));
      if (k === 'd') return editor.set({ fg: '#000000', bg: '#ffffff' });
      if (k === '[' || k === ']' || k === '{' || k === '}') {
        const tool = editor.get().tool;
        const key = tool === 'eraser' ? 'eraser' : tool === 'clone' ? 'clone' : tool === 'heal' ? 'heal' : 'brush';
        const o = editor.get().opts[key];
        if (k === '[' || k === ']') {
          const step = o.size < 10 ? 1 : o.size < 50 ? 5 : o.size < 200 ? 10 : 25;
          setOpts(key, { size: Math.max(1, Math.min(1000, o.size + (k === ']' ? step : -step))) });
        } else setOpts(key, { hardness: Math.max(0, Math.min(1, o.hardness + (k === '}' ? 0.25 : -0.25))) });
        doc.onRender.emit();
        return;
      }
      if (/^[0-9]$/.test(k) && ['brush', 'eraser', 'clone'].includes(editor.get().tool)) {
        const key = editor.get().tool as 'brush' | 'eraser' | 'clone';
        setOpts(key, { opacity: k === '0' ? 1 : +k / 10 });
        return;
      }
      if (k === 'enter' && editor.get().tool === 'crop' && hasPendingCrop(doc)) {
        applyCrop(toolCtx(doc));
        return;
      }
      if (k === 'm' && e.shiftKey) return setOpts('marquee', { shape: editor.get().opts.marquee.shape === 'rect' ? 'ellipse' : 'rect' });
      if (k === 'l' && e.shiftKey) return setOpts('lasso', { polygonal: !editor.get().opts.lasso.polygonal });
      if (k === 'g' && e.shiftKey) return setTool('bucket');
      const tool = KEY_TOOLS[k];
      if (tool && !e.altKey) setTool(tool);
    };
    const onPaste = async (e: ClipboardEvent) => {
      if (!doc || isTypingTarget(e.target)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      e.preventDefault();
      if (file) {
        const img = await decodeImage(file);
        const c = createCanvas(img.width, img.height);
        ctx2d(c).drawImage(img, 0, 0);
        A.pasteCanvas(doc, c);
      } else if (!A.pasteInternal(doc)) toast('Nothing to paste');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
  }, [doc]);
}

// ---------------------------------------------------------------- root
export function EditorView() {
  const docs = editor.use((s) => s.docs);
  const activeId = editor.use((s) => s.activeDoc);
  const busy = editor.use((s) => s.busy);
  const doc = docs.find((d) => d.id === activeId) ?? null;
  useEmitter(doc);
  useEditorShortcuts(doc);

  return (
    <div className="ed">
      <MenuBar doc={doc} />
      <OptionsBar doc={doc} />
      <div className="ed-main">
        <Toolbar />
        <div className="ed-center">
          <div className="doc-tabs" role="tablist" aria-label="Open documents">
            {docs.map((d) => (
              <div
                key={d.id}
                className={cx('doc-tab', d.id === activeId && 'active')}
                onClick={() => showDoc(d)}
                role="tab"
                aria-selected={d.id === activeId}
                data-doc-tab={d.id}
                {...tabDragProps(d.id)}
                title={d.devLink ? 'Linked to Develop: edits made there show up here' : 'Drag a layer here (Move tool or Layers panel) to copy it into this document'}
              >
                {d.name}
                {d.dirty ? ' •' : ''}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    closeDoc(d.id);
                  }}
                  aria-label={`Close ${d.name}`}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
          {busy && (
            <div className="ed-busy" role="status">
              <span className="spinner" aria-hidden />
              {busy}
            </div>
          )}
          {doc ? (
            <Viewport doc={doc} key={doc.id} />
          ) : busy ? null : (
            <div className="empty" style={{ gridRow: '2 / 4' }}>
              <h3>No open documents</h3>
              <div>Open a photo from the Library (⌘E), start a blank canvas, or open an image / PSD file.</div>
              <div className="row">
                <Button primary onClick={() => openDialog({ kind: 'new' })}>
                  <FilePlus size={14} /> New…
                </Button>
                <Button onClick={async () => openFilesInEditor(await pickFiles('image/*,.psd', true))}>
                  <FolderOpen size={14} /> Open file…
                </Button>
                <Button onClick={() => app.set({ module: 'library' })}>Go to Library</Button>
              </div>
            </div>
          )}
        </div>
        <aside className="side right">
          {doc && (
            <>
              <div className="row" style={{ padding: '8px 10px', borderBottom: '1px solid var(--line)' }}>
                <Button small primary onClick={() => saveDocToLibrary(doc)} title="Save flattened image + layers back to the Library (⌘S)">
                  <Save size={13} /> Save to Library
                </Button>
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) A.addAdjustmentLayer(doc, defaultAdjustment(e.target.value as keyof typeof ADJ_LABELS));
                  }}
                  aria-label="Add adjustment layer"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <option value="">Adjustment…</option>
                  {Object.entries(ADJ_LABELS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              <PropertiesPanel doc={doc} />
              <LayersPanel doc={doc} key={doc.id} />
              <HistoryPanel doc={doc} />
            </>
          )}
          <ColorPanel />
        </aside>
      </div>
      <Dialogs doc={doc} />
      <ExpandProgress />
    </div>
  );
}
