// Scale tool options: the size as percentages (proportions linked or not), the size in pixels, and buttons
// that fit the layer inside the canvas or make it cover the canvas.

import { useRef, useState } from 'react';
import { Link2, Link2Off } from 'lucide-react';
import { isMac } from '../lib/util';
import { Button, IconButton } from '../ui/controls';
import { EditorDoc } from './doc';
import { fitToCanvas, isTextTarget, percentFor, scaleTarget, setScale } from './scale';
import { editor, setOpts } from './session';
import { scaleUi } from './tools';

const ALT = isMac ? '⌥' : 'Alt';

/** A percentage field that applies its value on Enter or when it loses focus (Esc puts the old value back). */
function PercentInput({ label, name, value, onCommit }: { label: string; name: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  const skip = useRef(false);
  const shown = String(+value.toFixed(1));
  return (
    <label className="opt">
      {label}
      <input
        type="text"
        inputMode="decimal"
        className="num-input"
        style={{ width: 64 }}
        value={text ?? shown}
        onChange={(e) => setText(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={() => {
          const v = parseFloat(text ?? '');
          setText(null);
          if (skip.current) skip.current = false;
          else if (v > 0 && Math.abs(v - value) > 0.01) onCommit(Math.min(10000, v));
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            skip.current = true;
            e.currentTarget.blur();
          }
        }}
        aria-label={`${name} in percent`}
      />
      %
    </label>
  );
}

export function ScaleOptions({ doc }: { doc: EditorDoc | null }) {
  const linked = editor.use((s) => s.opts.scale.linked);
  const dragBox = scaleUi.use((s) => s.box);
  if (!doc) return <span className="muted">Open an image to scale its layers.</span>;
  const { target: t, reason } = scaleTarget(doc);
  if (!t) return <span className="muted">{reason}</span>;
  const box = dragBox ?? t.box;
  const k = percentFor(t, box);
  const text = isTextTarget(t);
  const lock = linked || text;
  const setW = (v: number) => setScale(doc, v / 100, lock ? (v / 100) * (k.y / k.x) : k.y);
  const setH = (v: number) => setScale(doc, lock ? (v / 100) * (k.x / k.y) : k.x, v / 100);
  const hint = text
    ? `Type stays editable: it scales by its font size. ${ALT}: from the center.`
    : `Drag a handle to scale. Shift: ${lock ? 'free proportions' : 'keep proportions'}. ${ALT}: from the center. Drag inside to move.`;
  return (
    <>
      <PercentInput label="W" name="Width" value={k.x * 100} onCommit={setW} />
      <IconButton
        title={text ? 'Type layers keep their proportions' : linked ? 'Keep proportions: on' : 'Keep proportions: off'}
        active={lock}
        disabled={text}
        onClick={() => setOpts('scale', { linked: !linked })}
      >
        {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
      </IconButton>
      <PercentInput label="H" name="Height" value={k.y * 100} onCommit={setH} />
      <span className="muted">
        {Math.round(box.w).toLocaleString()} × {Math.round(box.h).toLocaleString()} px{t.kind === 'pixels' ? ' · selected pixels' : ''}
      </span>
      <div className="sep" />
      <Button small onClick={() => fitToCanvas(doc, 'fit')} title="Scale it to fit inside the canvas, keeping its proportions, and center it">
        Fit Canvas
      </Button>
      <Button small onClick={() => fitToCanvas(doc, 'fill')} title="Scale it to cover the whole canvas, keeping its proportions, and center it">
        Fill Canvas
      </Button>
      <div className="sep" />
      <span className="muted">{hint}</span>
    </>
  );
}
