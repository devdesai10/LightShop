import { useEffect, useRef, useState } from 'react';
import { Copy, Eye, EyeOff, Lock, LockOpen, Plus, SlidersHorizontal, SquareDashed, Trash, Type } from 'lucide-react';
import { useEmitter } from '../state/store';
import { IconButton, Panel, Slider, cx } from '../ui/controls';
import { ADJ_LABELS, AdjType, Adjustment, defaultAdjustment } from './adjust';
import { AdjustmentEditor } from './AdjustmentEditor';
import { addAdjustmentLayer, addLayerMask, deleteLayer, duplicateLayer, moveLayer, newLayer, setLayerProps, updateText } from './actions';
import { BLEND_MODES, BlendMode, EditorDoc, Layer } from './doc';
import { editor } from './session';

function LayerThumb({ doc, layer, mask }: { doc: EditorDoc; layer: Layer; mask?: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = useEmitter(doc);
  useEffect(() => {
    const t = setTimeout(() => {
      const c = ref.current;
      if (!c) return;
      const src = mask ? layer.mask : layer.kind !== 'adjust' ? layer.canvas : null;
      if (!src) return;
      const k = Math.min(32 / doc.width, 32 / doc.height);
      c.width = Math.max(1, Math.round(doc.width * k));
      c.height = Math.max(1, Math.round(doc.height * k));
      const ctx = c.getContext('2d')!;
      ctx.clearRect(0, 0, c.width, c.height);
      if (mask) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(src, 0, 0, c.width, c.height);
      } else if (layer.kind !== 'adjust') {
        ctx.drawImage(src, layer.x * k, layer.y * k, src.width * k, src.height * k);
      }
    }, 120);
    return () => clearTimeout(t);
  }, [version, layer, mask, doc]);
  return <canvas ref={ref} />;
}

const ADJ_TYPES = Object.keys(ADJ_LABELS) as AdjType[];

export function LayersPanel({ doc }: { doc: EditorDoc }) {
  useEmitter(doc);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const active = doc.active;
  const layersTop = [...doc.layers].reverse();
  return (
    <Panel title="Layers" id="ed-layers">
      {active && (
        <>
          <div className="layer-controls">
            <select
              value={active.blend}
              onChange={(e) => setLayerProps(doc, active.id, { blend: e.target.value as BlendMode }, 'Blending Change')}
              aria-label="Blend mode"
            >
              {BLEND_MODES.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
            <IconButton title={active.locked ? 'Unlock layer' : 'Lock layer'} active={active.locked} onClick={() => setLayerProps(doc, active.id, { locked: !active.locked }, active.locked ? 'Unlock Layer' : 'Lock Layer')}>
              {active.locked ? <Lock size={14} /> : <LockOpen size={14} />}
            </IconButton>
          </div>
          <Slider
            label="Opacity"
            value={Math.round(active.opacity * 100)}
            min={0}
            max={100}
            defaultValue={100}
            format={(v) => `${Math.round(v)}%`}
            onChange={(v) => {
              if (!startOpacity.has(active.id)) startOpacity.set(active.id, active.opacity);
              active.opacity = v / 100;
              doc.invalidate();
              doc.emit();
            }}
            onCommit={(v) => {
              const orig = startOpacity.get(active.id) ?? active.opacity;
              startOpacity.delete(active.id);
              active.opacity = orig;
              if (Math.abs(orig - v / 100) > 1e-6) setLayerProps(doc, active.id, { opacity: v / 100 }, 'Opacity Change');
              else doc.invalidate();
            }}
          />
        </>
      )}
      <ul className="layers" role="listbox" aria-label="Layers">
        {layersTop.map((l) => (
          <li
            key={l.id}
            className={cx('layer', l.id === doc.activeId && 'active', overId === l.id && dragId !== l.id && 'drag-over')}
            onClick={() => {
              if (doc.activeId !== l.id) {
                doc.activeId = l.id;
                doc.editMask = l.kind === 'adjust' && !!l.mask;
                doc.emit();
              }
            }}
            draggable
            onDragStart={(e) => {
              setDragId(l.id);
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', l.id);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              setOverId(l.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setOverId(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId && dragId !== l.id) moveLayer(doc, doc.indexOf(dragId), doc.indexOf(l.id));
              setDragId(null);
              setOverId(null);
            }}
            role="option"
            aria-selected={l.id === doc.activeId}
          >
            <button
              className={cx('vis', l.visible && 'on')}
              onClick={(e) => {
                e.stopPropagation();
                setLayerProps(doc, l.id, { visible: !l.visible }, l.visible ? 'Hide Layer' : 'Show Layer');
              }}
              aria-label={l.visible ? `Hide ${l.name}` : `Show ${l.name}`}
            >
              {l.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </button>
            <div
              className={cx('lthumb', l.kind !== 'raster' && 'icon', l.id === doc.activeId && !doc.editMask && 'sel')}
              onClick={(e) => {
                e.stopPropagation();
                doc.activeId = l.id;
                doc.editMask = false;
                doc.emit();
              }}
              title="Edit layer pixels"
            >
              {l.kind === 'adjust' ? <SlidersHorizontal size={16} /> : l.kind === 'text' ? <Type size={16} /> : <LayerThumb doc={doc} layer={l} />}
            </div>
            {l.mask && (
              <div
                className={cx('lthumb', l.id === doc.activeId && doc.editMask && 'sel')}
                style={{ opacity: l.maskEnabled ? 1 : 0.4 }}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) return setLayerProps(doc, l.id, { maskEnabled: !l.maskEnabled }, l.maskEnabled ? 'Disable Layer Mask' : 'Enable Layer Mask');
                  doc.activeId = l.id;
                  doc.editMask = true;
                  doc.emit();
                }}
                title="Edit layer mask (Shift-click to disable)"
              >
                <LayerThumb doc={doc} layer={l} mask />
              </div>
            )}
            <span className="lname" onDoubleClick={() => setRenaming(l.id)}>
              {renaming === l.id ? (
                <input
                  className="text-input"
                  autoFocus
                  defaultValue={l.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== l.name) setLayerProps(doc, l.id, { name: v }, 'Rename Layer');
                    setRenaming(null);
                  }}
                />
              ) : (
                l.name
              )}
            </span>
            {l.locked && <Lock size={11} className="muted" />}
            {l.blend !== 'normal' && <span className="muted" style={{ fontSize: 10 }}>{BLEND_MODES.find((b) => b.value === l.blend)?.label}</span>}
          </li>
        ))}
      </ul>
      <div className="layer-buttons">
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) addAdjustmentLayer(doc, defaultAdjustment(e.target.value as AdjType));
          }}
          aria-label="New adjustment layer"
          title="New adjustment layer"
          style={{ marginRight: 'auto', width: 120 }}
        >
          <option value="">+ Adjustment…</option>
          {ADJ_TYPES.map((t) => (
            <option key={t} value={t}>
              {ADJ_LABELS[t]}
            </option>
          ))}
        </select>
        <IconButton title="Add layer mask" onClick={() => addLayerMask(doc, doc.selection ? 'selection' : 'reveal')}>
          <SquareDashed size={14} />
        </IconButton>
        <IconButton title="Duplicate layer" shortcut="⌘J" onClick={() => duplicateLayer(doc)}>
          <Copy size={14} />
        </IconButton>
        <IconButton title="New layer" shortcut="⇧⌘N" onClick={() => newLayer(doc)}>
          <Plus size={14} />
        </IconButton>
        <IconButton title="Delete layer" onClick={() => deleteLayer(doc)}>
          <Trash size={14} />
        </IconButton>
      </div>
    </Panel>
  );
}

const startOpacity = new Map<string, number>();

export function HistoryPanel({ doc }: { doc: EditorDoc }) {
  useEmitter(doc);
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    ref.current?.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }, [doc.hIndex, doc.history.length]);
  return (
    <Panel title="History" id="ed-history">
      <ul className="history-list" ref={ref}>
        <li className={cx(doc.hIndex === -1 && 'current')} onClick={() => doc.jumpTo(-1)}>
          {doc.openLabel}
        </li>
        {doc.history.map((h, i) => (
          <li key={i} className={cx(i === doc.hIndex && 'current', i > doc.hIndex && 'future')} onClick={() => doc.jumpTo(i)}>
            {h.label}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function PropertiesPanel({ doc }: { doc: EditorDoc }) {
  useEmitter(doc);
  const l = doc.active;
  const [liveAdj, setLiveAdj] = useState<{ id: string; orig: Adjustment } | null>(null);
  if (!l) return null;
  if (l.kind === 'adjust') {
    const change = (a: Adjustment) => {
      if (!liveAdj || liveAdj.id !== l.id) setLiveAdj({ id: l.id, orig: structuredClone(l.adj) });
      l.adj = a;
      doc.invalidate();
      doc.emit();
    };
    const commit = (a: Adjustment) => {
      const orig = liveAdj?.id === l.id ? liveAdj.orig : structuredClone(l.adj);
      setLiveAdj(null);
      l.adj = orig;
      setLayerProps(doc, l.id, { adj: a } as Partial<Layer>, ADJ_LABELS[a.type]);
    };
    return (
      <Panel title={`Properties · ${ADJ_LABELS[l.adj.type]}`} id="ed-props">
        <AdjustmentEditor value={l.adj} onChange={change} onCommit={commit} />
        <div className="hint" style={{ marginTop: 6 }}>Paint on the adjustment layer's mask with black to hide the effect.</div>
      </Panel>
    );
  }
  if (l.kind === 'text') return <TextProperties doc={doc} l={l} />;
  return <RasterProperties l={l} />;
}

function TextProperties({ doc, l }: { doc: EditorDoc; l: Extract<Layer, { kind: 'text' }> }) {
  const [size, setSize] = useState<number | null>(null);
  const t = l.text;
  return (
      <Panel title="Properties · Type" id="ed-props">
        <textarea
          style={{ width: '100%', minHeight: 54 }}
          defaultValue={t.text}
          key={l.id + t.text}
          onKeyDown={(e) => e.stopPropagation()}
          onBlur={(e) => e.target.value !== t.text && updateText(doc, l.id, { text: e.target.value })}
          aria-label="Text content"
        />
        <div className="field">
          <span className="field-label">Font</span>
          <select value={t.font} onChange={(e) => updateText(doc, l.id, { font: e.target.value })} aria-label="Font family">
            {FONTS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <Slider
          label="Size"
          value={size ?? t.size}
          min={4}
          max={600}
          defaultValue={64}
          format={(v) => `${Math.round(v)} px`}
          onChange={setSize}
          onCommit={(v) => {
            setSize(null);
            updateText(doc, l.id, { size: Math.round(v) });
          }}
        />
        <div className="row">
          <input type="color" className="color-input" value={t.color} onChange={(e) => updateText(doc, l.id, { color: e.target.value }, 'Type Color')} aria-label="Text color" />
          <IconButton title="Bold" active={t.bold} onClick={() => updateText(doc, l.id, { bold: !t.bold })}>
            <b>B</b>
          </IconButton>
          <IconButton title="Italic" active={t.italic} onClick={() => updateText(doc, l.id, { italic: !t.italic })}>
            <i>I</i>
          </IconButton>
          <select value={t.align} onChange={(e) => updateText(doc, l.id, { align: e.target.value as 'left' })} aria-label="Alignment">
            <option value="left">Left</option>
            <option value="center">Center</option>
            <option value="right">Right</option>
          </select>
        </div>
      </Panel>
  );
}

function RasterProperties({ l }: { l: Extract<Layer, { kind: 'raster' }> }) {
  return (
    <Panel title="Properties" id="ed-props" defaultOpen={false}>
      <table className="meta-table">
        <tbody>
          <tr>
            <td>Layer</td>
            <td>{l.name}</td>
          </tr>
          <tr>
            <td>Position</td>
            <td>
              {l.x}, {l.y}
            </td>
          </tr>
          <tr>
            <td>Size</td>
            <td>
              {l.canvas.width} × {l.canvas.height}
            </td>
          </tr>
          <tr>
            <td>Mask</td>
            <td>{l.mask ? (l.maskEnabled ? 'Enabled' : 'Disabled') : 'None'}</td>
          </tr>
        </tbody>
      </table>
    </Panel>
  );
}

export const FONTS = [
  { label: 'Helvetica / Arial', value: 'Helvetica, Arial, sans-serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times', value: '"Times New Roman", Times, serif' },
  { label: 'Courier', value: '"Courier New", Courier, monospace' },
  { label: 'Futura', value: 'Futura, "Trebuchet MS", sans-serif' },
  { label: 'Impact', value: 'Impact, Haettenschweiler, sans-serif' },
  { label: 'Palatino', value: 'Palatino, "Palatino Linotype", serif' },
  { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
];

const SWATCHES = [
  '#000000', '#404040', '#808080', '#c0c0c0', '#ffffff', '#ff0000', '#ff8000', '#ffff00', '#80ff00', '#00ff00',
  '#00ff80', '#00ffff', '#0080ff', '#0000ff', '#8000ff', '#ff00ff', '#ff0080', '#800000', '#804000', '#808000',
  '#008000', '#008080', '#000080', '#400080', '#800040', '#f4c7a1', '#d99a6c', '#a0643c', '#5c3a21', '#2e1d10',
];

export function ColorPanel() {
  const fg = editor.use((s) => s.fg);
  const bg = editor.use((s) => s.bg);
  return (
    <Panel title="Color" id="ed-color">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="muted">Foreground</span>
        <input type="color" className="color-input" value={fg} onChange={(e) => editor.set({ fg: e.target.value })} aria-label="Foreground color" />
        <span className="muted">Background</span>
        <input type="color" className="color-input" value={bg} onChange={(e) => editor.set({ bg: e.target.value })} aria-label="Background color" />
      </div>
      <div className="swatch-grid">
        {SWATCHES.map((c) => (
          <button key={c} style={{ background: c }} title={`${c} (Alt-click for background)`} aria-label={`Swatch ${c}`} onClick={(e) => editor.set(e.altKey ? { bg: c } : { fg: c })} />
        ))}
      </div>
    </Panel>
  );
}
