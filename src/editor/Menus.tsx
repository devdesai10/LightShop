import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { app } from '../state/app';
import { modLabel, pickFiles } from '../lib/util';
import { cx } from '../ui/controls';
import { ADJ_LABELS, AdjType, defaultAdjustment } from './adjust';
import * as A from './actions';
import { EditorDoc } from './doc';
import { FILTERS } from './filters';
import { openDialog } from './Dialogs';
import { closeDoc, editor, openFilesInEditor, saveDocToLibrary } from './session';
import { exportAs, exportAsks, quickExport } from './exporting';
import { selectTool } from './tools';
import { fitView, zoomBy, setActualPixels } from './viewState';

export type MenuItem = { label: string; sc?: string; run?: () => void; disabled?: boolean; sub?: MenuItem[] } | '-';

const M = modLabel;
const ADJ_TYPES = Object.keys(ADJ_LABELS) as AdjType[];

export function buildMenus(doc: EditorDoc | null): { label: string; items: MenuItem[] }[] {
  const d = doc;
  const need = !d;
  const run = (f: (doc: EditorDoc) => void) => () => d && f(d);
  const groups = [...new Set(FILTERS.map((f) => f.group))];
  // In the desktop app each format opens a Save dialog first.
  const ell = exportAsks() ? '…' : '';
  return [
    {
      label: 'File',
      items: [
        { label: 'New…', sc: `${M}N`, run: () => openDialog({ kind: 'new' }) },
        { label: 'Open…', sc: `${M}O`, run: async () => openFilesInEditor(await pickFiles('image/*,.psd', true)) },
        { label: 'Open from Library', run: () => app.set({ module: 'library' }) },
        '-',
        { label: 'Save to Library', sc: `${M}S`, disabled: need, run: run((x) => saveDocToLibrary(x)) },
        {
          label: 'Export As',
          disabled: need,
          sub: [
            { label: `PNG${ell}`, run: run((x) => exportAs(x, 'png')) },
            { label: `JPEG${ell}`, run: run((x) => exportAs(x, 'jpeg')) },
            { label: `WebP${ell}`, run: run((x) => exportAs(x, 'webp')) },
            { label: `Photoshop (PSD)${ell}`, run: run((x) => exportAs(x, 'psd')) },
          ],
        },
        { label: 'Quick Export', disabled: need, run: run((x) => quickExport(x)) },
        '-',
        { label: 'Close', sc: `${M}W`, disabled: need, run: run((x) => closeDoc(x.id)) },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: d && d.hIndex >= 0 ? `Undo ${d.history[d.hIndex]?.label}` : 'Undo', sc: `${M}Z`, disabled: !d || d.hIndex < 0, run: run((x) => x.undo()) },
        { label: d && d.hIndex < d.history.length - 1 ? `Redo ${d.history[d.hIndex + 1]?.label}` : 'Redo', sc: `⇧${M}Z`, disabled: !d || d.hIndex >= d.history.length - 1, run: run((x) => x.redo()) },
        '-',
        { label: 'Cut', sc: `${M}X`, disabled: need, run: run(A.cutSelection) },
        { label: 'Copy', sc: `${M}C`, disabled: need, run: run((x) => A.copySelection(x)) },
        { label: 'Copy Merged', sc: `⇧${M}C`, disabled: need, run: run((x) => A.copySelection(x, true)) },
        { label: 'Paste', sc: `${M}V`, disabled: need, run: run((x) => A.pasteInternal(x)) },
        { label: 'Clear', sc: '⌫', disabled: need, run: run((x) => A.clearSelection(x)) },
        '-',
        { label: 'Fill with Foreground', sc: '⌥⌫', disabled: need, run: run((x) => A.fillSelection(x, editor.get().fg)) },
        { label: 'Fill with Background', sc: `${M}⌫`, disabled: need, run: run((x) => A.fillSelection(x, editor.get().bg)) },
        '-',
        { label: 'Scale', sc: `${M}T`, disabled: need, run: () => selectTool('scale') },
        { label: 'Flip Layer Horizontal', disabled: need, run: run((x) => A.flipLayer(x, 'h')) },
        { label: 'Flip Layer Vertical', disabled: need, run: run((x) => A.flipLayer(x, 'v')) },
      ],
    },
    {
      label: 'Image',
      items: [
        {
          label: 'Adjustments',
          disabled: need,
          sub: [
            ...ADJ_TYPES.map((t) => ({ label: `${ADJ_LABELS[t]}${t === 'invert' ? '' : '…'}`, sc: ADJ_SC[t], run: t === 'invert' ? run((x) => A.applyAdjustmentDestructive(x, defaultAdjustment('invert'))) : () => openDialog({ kind: 'adjust', type: t }) })),
            '-' as const,
            { label: 'Desaturate', sc: `⇧${M}U`, run: run((x) => A.applyAdjustmentDestructive(x, { type: 'hueSaturation', hue: 0, saturation: -100, lightness: 0, colorize: false })) },
          ],
        },
        '-',
        { label: 'Image Size…', sc: `⌥${M}I`, disabled: need, run: () => openDialog({ kind: 'imageSize' }) },
        { label: 'Canvas Size…', sc: `⌥${M}C`, disabled: need, run: () => openDialog({ kind: 'canvasSize' }) },
        {
          label: 'Image Rotation',
          disabled: need,
          sub: [
            { label: '180°', run: run((x) => A.rotateCanvas(x, 180)) },
            { label: '90° Clockwise', run: run((x) => A.rotateCanvas(x, 90)) },
            { label: '90° Counter Clockwise', run: run((x) => A.rotateCanvas(x, -90)) },
            '-',
            { label: 'Flip Canvas Horizontal', run: run((x) => A.flipCanvas(x, 'h')) },
            { label: 'Flip Canvas Vertical', run: run((x) => A.flipCanvas(x, 'v')) },
          ],
        },
        { label: 'Crop to Selection', disabled: !d?.selection, run: run(A.cropToSelection) },
      ],
    },
    {
      label: 'Layer',
      items: [
        { label: 'New Layer', sc: `⇧${M}N`, disabled: need, run: run(A.newLayer) },
        { label: 'Duplicate Layer', sc: `${M}J`, disabled: need, run: run(A.duplicateLayer) },
        { label: 'Delete Layer', disabled: need, run: run(A.deleteLayer) },
        '-',
        { label: 'New Adjustment Layer', disabled: need, sub: ADJ_TYPES.map((t) => ({ label: ADJ_LABELS[t], run: run((x) => A.addAdjustmentLayer(x, defaultAdjustment(t))) })) },
        '-',
        {
          label: 'Layer Mask',
          disabled: need,
          sub: [
            { label: 'Reveal All', run: run((x) => A.addLayerMask(x, 'reveal')) },
            { label: 'Hide All', run: run((x) => A.addLayerMask(x, 'hide')) },
            { label: 'Reveal Selection', disabled: !d?.selection, run: run((x) => A.addLayerMask(x, 'selection')) },
            '-',
            { label: 'Invert Mask', disabled: !d?.active?.mask, run: run(A.invertMask) },
            { label: 'Apply Mask', disabled: !d?.active?.mask, run: run((x) => A.deleteLayerMask(x, true)) },
            { label: 'Delete Mask', disabled: !d?.active?.mask, run: run((x) => A.deleteLayerMask(x, false)) },
          ],
        },
        '-',
        { label: 'Rasterize Type', disabled: d?.active?.kind !== 'text', run: run((x) => A.rasterizeLayer(x)) },
        { label: 'Merge Down', sc: `${M}E`, disabled: need, run: run(A.mergeDown) },
        { label: 'Merge Visible', sc: `⇧${M}E`, disabled: need, run: run(A.mergeVisible) },
        { label: 'Flatten Image', disabled: need, run: run(A.flattenImage) },
      ],
    },
    {
      label: 'Select',
      items: [
        { label: 'All', sc: `${M}A`, disabled: need, run: run(A.selectAll) },
        { label: 'Deselect', sc: `${M}D`, disabled: !d?.selection, run: run(A.deselect) },
        { label: 'Inverse', sc: `⇧${M}I`, disabled: need, run: run(A.invertSelection) },
        '-',
        { label: 'Feather…', sc: '⇧F6', disabled: !d?.selection, run: () => openDialog({ kind: 'feather' }) },
        { label: 'Load Layer Transparency', disabled: need, run: run(A.selectLayerPixels) },
      ],
    },
    {
      label: 'Filter',
      items: [
        { label: 'Develop Filter… (Camera Raw style)', sc: `⇧${M}A`, disabled: need, run: () => openDialog({ kind: 'develop' }) },
        '-',
        ...groups.map((g) => ({
          label: g,
          disabled: need,
          sub: FILTERS.filter((f) => f.group === g).map((f) => ({
            label: f.label,
            run: f.params.length ? () => openDialog({ kind: 'filter', id: f.id }) : run((x) => A.applyToActive(x, f.label, (c) => f.run(c, {}, {}, { fg: editor.get().fg, bg: editor.get().bg }))),
          })),
        })),
      ],
    },
    {
      label: 'View',
      items: [
        { label: 'Zoom In', sc: `${M}+`, disabled: need, run: run((x) => zoomBy(x, 1.25)) },
        { label: 'Zoom Out', sc: `${M}−`, disabled: need, run: run((x) => zoomBy(x, 0.8)) },
        { label: 'Fit on Screen', sc: `${M}0`, disabled: need, run: run((x) => fitView(x)) },
        { label: '100% (Actual Pixels)', sc: `${M}1`, disabled: need, run: run((x) => setActualPixels(x)) },
      ],
    },
  ];
}

const ADJ_SC: Partial<Record<AdjType, string>> = {
  levels: `${M}L`,
  curves: `${M}M`,
  hueSaturation: `${M}U`,
  colorBalance: `${M}B`,
  invert: `${M}I`,
};

/** While a submenu is open, hovering another item switches after this long (ms), so the pointer can cross other items on its way into the submenu. */
const SUBMENU_SWITCH_MS = 300;

function MenuList({ items, onDone }: { items: MenuItem[]; onDone: () => void }) {
  const [openSub, setOpenSub] = useState<number | null>(null);
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const hover = (i: number, hasSub: boolean) => {
    clearTimeout(timer.current);
    const next = hasSub ? i : null;
    // Entering the open submenu (or its item) also lands here, which cancels a pending switch.
    if (openSub === null || openSub === next) setOpenSub(next);
    else timer.current = window.setTimeout(() => setOpenSub(next), SUBMENU_SWITCH_MS);
  };
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it === '-' ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <div key={i} style={{ position: 'relative' }} onMouseEnter={() => hover(i, !!it.sub)}>
            <button
              className={cx('menu-item', openSub === i && it.sub && 'open')}
              disabled={it.disabled}
              role="menuitem"
              aria-haspopup={it.sub ? 'menu' : undefined}
              onClick={() => {
                clearTimeout(timer.current);
                if (it.sub) return setOpenSub(i);
                onDone();
                it.run?.();
              }}
            >
              {it.label}
              {it.sc && <span className="sc">{it.sc}</span>}
              {it.sub && <ChevronRight size={12} style={{ marginLeft: 'auto' }} />}
            </button>
            {it.sub && openSub === i && !it.disabled && <MenuList items={it.sub} onDone={onDone} />}
          </div>
        ),
      )}
    </div>
  );
}

export function MenuBar({ doc }: { doc: EditorDoc | null }) {
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const menus = buildMenus(doc);
  return (
    <nav className="menubar" ref={ref} aria-label="Editor menu">
      {menus.map((m, i) => (
        <div key={m.label} className={cx('menu-root', open === i && 'open')} onMouseEnter={() => open !== null && setOpen(i)}>
          <button onClick={() => setOpen(open === i ? null : i)} aria-haspopup="menu" aria-expanded={open === i}>
            {m.label}
          </button>
          {open === i && <MenuList items={m.items} onDone={() => setOpen(null)} />}
        </div>
      ))}
    </nav>
  );
}
