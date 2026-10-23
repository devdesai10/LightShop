// Crop tool options (ratio, Expand to a size, fill for the new area) and the progress sheet for slow fills.

import { useMemo } from 'react';
import { Button, Modal, cx } from '../ui/controls';
import { EditorDoc } from './doc';
import { ExpandFill, FILLS, SIZE_PRESETS, SizePreset, displayPreset, expandJob } from './expand';
import { editor, setOpts } from './session';
import { applyCrop, clearCrop, clearCropOut, cropUi, setCropAspect, startPreset, toolCtx } from './tools';

const RATIOS: { label: string; value: number }[] = [
  { label: '1 : 1', value: 1 },
  { label: '4 : 5', value: 4 / 5 },
  { label: '3 : 2', value: 3 / 2 },
  { label: '2 : 3', value: 2 / 3 },
  { label: '16 : 9', value: 16 / 9 },
  { label: '16 : 10', value: 16 / 10 },
  { label: '9 : 16', value: 9 / 16 },
];

const GROUPS: { id: string; label: string }[] = [
  { id: 'Mac', label: 'Mac displays' },
  { id: 'Desktop', label: 'Desktop sizes' },
  { id: 'iPhone', label: 'iPhone wallpapers' },
];

const px = (w: number, h: number) => `${w.toLocaleString()} × ${h.toLocaleString()}`;

/** The Expand sizes as grouped options: this display first, then Mac displays, desktop sizes and iPhones. */
export function SizePresetOptions({ display }: { display: SizePreset | null }) {
  return (
    <>
      {display && (
        <optgroup label="This Mac">
          <option value="display">This display · {px(display.w, display.h)}</option>
        </optgroup>
      )}
      {GROUPS.map((g) => (
        <optgroup key={g.id} label={g.label}>
          {SIZE_PRESETS.filter((p) => p.group === g.id).map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} · {px(p.w, p.h)}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function CropOptions({ doc }: { doc: EditorDoc | null }) {
  const o = editor.use((s) => s.opts.crop);
  const pending = cropUi.use((s) => s.pending);
  const cur = doc && pending?.docId === doc.id ? pending : null;
  const display = useMemo(displayPreset, []);
  const W = doc?.width ?? 1;
  const H = doc?.height ?? 1;
  const a = o.aspect;
  const ratio = a === null ? '' : doc && Math.abs(a - W / H) < 1e-3 ? 'orig' : (RATIOS.find((r) => Math.abs(r.value - a) < 1e-6)?.value.toString() ?? 'custom');
  const r = cur?.rect;
  const outside = !!r && doc !== null && (r.x < -0.5 || r.y < -0.5 || r.x + r.w > W + 0.5 || r.y + r.h > H + 0.5);
  const redraw = () => doc?.onRender.emit();
  const fill = FILLS.find((f) => f.value === o.fill)!;
  return (
    <>
      <select
        value={ratio}
        onChange={(e) => {
          const v = e.target.value;
          setCropAspect(doc, v === '' ? null : v === 'orig' ? W / H : parseFloat(v));
          redraw();
        }}
        aria-label="Crop ratio"
        title="Keep the box to this shape"
      >
        <option value="">Free ratio</option>
        {doc && <option value="orig">Original</option>}
        {RATIOS.map((x) => (
          <option key={x.label} value={x.value.toString()}>
            {x.label}
          </option>
        ))}
        {ratio === 'custom' && a !== null && (
          <option value="custom" disabled>
            {a >= 1 ? `${+a.toFixed(2)} : 1` : `1 : ${+(1 / a).toFixed(2)}`}
          </option>
        )}
      </select>
      <div className="sep" />
      <label className="opt">
        Expand to
        <select
          value={cur?.out?.presetId ?? ''}
          disabled={!doc}
          onChange={(e) => {
            if (!doc) return;
            if (e.target.value) startPreset(doc, e.target.value);
            else clearCropOut(doc);
          }}
          aria-label="Expand to size"
          title="Grow the canvas to this shape around the photo; the result is exactly this many pixels"
          style={{ maxWidth: 230 }}
        >
          <option value="">{cur ? 'Box size (no scaling)' : 'Choose a size…'}</option>
          <SizePresetOptions display={display} />
        </select>
      </label>
      <label className="opt" title={fill.title}>
        Fill
        <select
          value={o.fill}
          onChange={(e) => {
            setOpts('crop', { fill: e.target.value as ExpandFill });
            redraw();
          }}
          aria-label="Fill for the new area"
        >
          {FILLS.map((f) => (
            <option key={f.value} value={f.value} title={f.title}>
              {f.label}
            </option>
          ))}
        </select>
      </label>
      {o.fill === 'color' && (
        <input
          type="color"
          className="color-input"
          value={o.fillColor}
          onChange={(e) => {
            setOpts('crop', { fillColor: e.target.value });
            redraw();
          }}
          aria-label="Fill color"
          title="Fill color"
        />
      )}
      <span className="muted crop-summary">
        {cur && r
          ? `${cur.out ? `${cur.out.label} · ${px(cur.out.w, cur.out.h)} px` : `${px(Math.round(r.w), Math.round(r.h))} px`}${outside ? ` · ${fill.value === 'none' ? 'new area left empty' : `new area: ${fill.label}`}` : ''}`
          : 'Drag on the canvas to crop. Drag past its edges, or choose a size, to expand it.'}
      </span>
      {cur && doc && (
        <>
          <Button
            small
            onClick={() => {
              clearCrop();
              redraw();
            }}
          >
            Cancel
          </Button>
          <Button small primary onClick={() => applyCrop(toolCtx(doc))} title="Apply (Enter)">
            {outside ? 'Expand' : 'Crop'}
          </Button>
        </>
      )}
    </>
  );
}

/** Progress of a content-aware or edge fill, with Cancel. */
export function ExpandProgress() {
  const job = expandJob.use((s) => s.job);
  if (!job) return null;
  const pct = job.progress === null ? null : Math.round(job.progress * 100);
  return (
    <Modal title={job.title} onClose={job.cancel} width={380} closeOnBackdrop={false} footer={<Button onClick={job.cancel}>Cancel</Button>}>
      <div>{job.detail}</div>
      <div className={cx('progress-bar', pct === null && 'indeterminate')} role="progressbar" aria-label="Fill progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
      <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }} aria-live="polite">
        {pct === null ? 'Working…' : `${pct}%`}
      </div>
    </Modal>
  );
}
