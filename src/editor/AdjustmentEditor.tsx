import { useState } from 'react';
import { Segmented, Slider } from '../ui/controls';
import { CurveEditor } from '../ui/widgets';
import type { Adjustment } from './adjust';

type Props = { value: Adjustment; onChange: (a: Adjustment) => void; onCommit: (a: Adjustment) => void };

export function AdjustmentEditor({ value: a, onChange, onCommit }: Props) {
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const [ch, setCh] = useState<'master' | 'red' | 'green' | 'blue'>('master');
  const [mixOut, setMixOut] = useState<'r' | 'g' | 'b'>('r');
  const sl = (label: string, key: string, min: number, max: number, def: number, step = 1, get?: () => number, set?: (v: number) => Adjustment) => (
    <Slider
      key={label}
      label={label}
      value={get ? get() : ((a as unknown as Record<string, number>)[key] ?? def)}
      min={min}
      max={max}
      step={step}
      defaultValue={def}
      onChange={(v) => onChange(set ? set(v) : ({ ...a, [key]: v } as Adjustment))}
      onCommit={(v) => onCommit(set ? set(v) : ({ ...a, [key]: v } as Adjustment))}
    />
  );
  switch (a.type) {
    case 'brightnessContrast':
      return (
        <>
          {sl('Brightness', 'brightness', -150, 150, 0)}
          {sl('Contrast', 'contrast', -50, 100, 0)}
        </>
      );
    case 'levels':
      return (
        <>
          {sl('Input black', 'inBlack', 0, 253, 0)}
          {sl('Gamma', 'gamma', 0.1, 9.99, 1, 0.01)}
          {sl('Input white', 'inWhite', 2, 255, 255)}
          {sl('Output black', 'outBlack', 0, 255, 0)}
          {sl('Output white', 'outWhite', 0, 255, 255)}
        </>
      );
    case 'curves':
      return (
        <>
          <Segmented
            value={ch}
            onChange={setCh}
            options={[
              { value: 'master', label: 'RGB' },
              { value: 'red', label: 'R' },
              { value: 'green', label: 'G' },
              { value: 'blue', label: 'B' },
            ]}
          />
          <CurveEditor points={a[ch]} channel={ch} size={226} onChange={(p) => onChange({ ...a, [ch]: p })} onCommit={(p) => onCommit({ ...a, [ch]: p })} />
        </>
      );
    case 'exposure':
      return (
        <>
          {sl('Exposure', 'exposure', -5, 5, 0, 0.01)}
          {sl('Offset', 'offset', -0.5, 0.5, 0, 0.001)}
          {sl('Gamma', 'gamma', 0.1, 9.99, 1, 0.01)}
        </>
      );
    case 'hueSaturation':
      return (
        <>
          {sl('Hue', 'hue', -180, 180, 0)}
          {sl('Saturation', 'saturation', -100, 100, 0)}
          {sl('Lightness', 'lightness', -100, 100, 0)}
          <label className="check">
            <input type="checkbox" checked={a.colorize} onChange={(e) => onCommit({ ...a, colorize: e.target.checked })} /> Colorize
          </label>
        </>
      );
    case 'colorBalance': {
      const idx = (i: 0 | 1 | 2) => (v: number) => {
        const arr = [...a[tone]] as [number, number, number];
        arr[i] = v;
        return { ...a, [tone]: arr } as Adjustment;
      };
      return (
        <>
          <Segmented
            value={tone}
            onChange={setTone}
            options={[
              { value: 'shadows', label: 'Shadows' },
              { value: 'midtones', label: 'Midtones' },
              { value: 'highlights', label: 'Highlights' },
            ]}
          />
          {sl('Cyan ↔ Red', '', -100, 100, 0, 1, () => a[tone][0], idx(0))}
          {sl('Magenta ↔ Green', '', -100, 100, 0, 1, () => a[tone][1], idx(1))}
          {sl('Yellow ↔ Blue', '', -100, 100, 0, 1, () => a[tone][2], idx(2))}
        </>
      );
    }
    case 'blackWhite':
      return (
        <>
          {sl('Reds', 'red', 0, 200, 30)}
          {sl('Greens', 'green', 0, 200, 59)}
          {sl('Blues', 'blue', 0, 200, 11)}
          <label className="check">
            <input type="checkbox" checked={a.tint} onChange={(e) => onCommit({ ...a, tint: e.target.checked })} /> Tint
            <input type="color" className="color-input" value={a.tintColor} onChange={(e) => onCommit({ ...a, tintColor: e.target.value, tint: true })} aria-label="Tint color" />
          </label>
        </>
      );
    case 'photoFilter':
      return (
        <>
          <label className="check">
            Color <input type="color" className="color-input" value={a.color} onChange={(e) => onCommit({ ...a, color: e.target.value })} aria-label="Filter color" />
          </label>
          {sl('Density', 'density', 0, 100, 25)}
          <label className="check">
            <input type="checkbox" checked={a.preserve} onChange={(e) => onCommit({ ...a, preserve: e.target.checked })} /> Preserve luminosity
          </label>
        </>
      );
    case 'channelMixer': {
      const row = a[mixOut];
      const set = (i: 0 | 1 | 2) => (v: number) => {
        const r = [...row] as [number, number, number];
        r[i] = v;
        return { ...a, [mixOut]: r } as Adjustment;
      };
      return (
        <>
          <Segmented
            value={mixOut}
            onChange={setMixOut}
            options={[
              { value: 'r', label: 'Red out' },
              { value: 'g', label: 'Green out' },
              { value: 'b', label: 'Blue out' },
            ]}
          />
          {sl('Red', '', -200, 200, mixOut === 'r' ? 100 : 0, 1, () => row[0], set(0))}
          {sl('Green', '', -200, 200, mixOut === 'g' ? 100 : 0, 1, () => row[1], set(1))}
          {sl('Blue', '', -200, 200, mixOut === 'b' ? 100 : 0, 1, () => row[2], set(2))}
        </>
      );
    }
    case 'invert':
      return <div className="hint">Inverts the colors of everything below.</div>;
    case 'posterize':
      return sl('Levels', 'levels', 2, 64, 4);
    case 'threshold':
      return sl('Threshold level', 'level', 1, 255, 128);
    case 'gradientMap':
      return (
        <div className="row">
          <span className="muted">Shadows</span>
          <input type="color" className="color-input" value={a.from} onChange={(e) => onCommit({ ...a, from: e.target.value })} aria-label="Shadow color" />
          <span className="muted">Highlights</span>
          <input type="color" className="color-input" value={a.to} onChange={(e) => onCommit({ ...a, to: e.target.value })} aria-label="Highlight color" />
        </div>
      );
  }
}
