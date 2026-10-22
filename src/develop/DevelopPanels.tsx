import { useState } from 'react';
import { Pipette, RotateCcw } from 'lucide-react';
import { hsvToRgb, rgbToHex } from '../lib/color';
import type { CurvePoint } from '../lib/spline';
import { formatSigned } from '../lib/util';
import { Button, IconButton, Panel, Segmented, Slider } from '../ui/controls';
import { ColorWheel, CurveEditor, HistogramView } from '../ui/widgets';
import { autoTone, autoWhiteBalance } from './auto';
import type { Histogram, SourceSample } from './renderer';
import { DEFAULT_SETTINGS, DevelopSettings, HSL_HUES, HSL_NAMES, Wheel } from './settings';

export interface DevPanelProps {
  s: DevelopSettings;
  live: (f: (d: DevelopSettings) => void) => void;
  commit: (label: string, f?: (d: DevelopSettings) => void) => void;
  sample?: SourceSample | null;
  hist?: Histogram | null;
  onWbPick?: () => void;
  wbPicking?: boolean;
}

type Num = (s: DevelopSettings) => number;

function useSl(p: DevPanelProps) {
  return (
    label: string,
    get: Num,
    set: (d: DevelopSettings, v: number) => void,
    min: number,
    max: number,
    o: { step?: number; def?: number; track?: string; digits?: number; signed?: boolean } = {},
  ) => {
    const digits = o.digits ?? (o.step && o.step < 1 ? 2 : 0);
    const fmt = (v: number) => (o.signed === false ? v.toFixed(digits) : formatSigned(v, digits));
    return (
      <Slider
        key={label}
        label={label}
        value={get(p.s)}
        min={min}
        max={max}
        step={o.step ?? 1}
        defaultValue={o.def ?? 0}
        track={o.track}
        format={fmt}
        onChange={(v) => p.live((d) => set(d, v))}
        onCommit={(v) => p.commit(`${label} ${fmt(v)}`, (d) => set(d, v))}
      />
    );
  };
}

const T_TEMP = 'linear-gradient(90deg,#3f74d6,#c9c9c9 50%,#e2c241)';
const T_TINT = 'linear-gradient(90deg,#3fae4f,#c9c9c9 50%,#c24fc4)';
const T_EXP = 'linear-gradient(90deg,#111,#888 50%,#eee)';
const T_SAT = 'linear-gradient(90deg,#808080,#c96 35%,#e44 60%,#36f 80%,#3c6)';

export function BasicPanel(p: DevPanelProps) {
  const sl = useSl(p);
  const s = p.s;
  return (
    <Panel title="Basic" id="dev-basic">
      <div className="row" style={{ justifyContent: 'space-between', margin: '4px 0 8px' }}>
        <span className="muted">Treatment</span>
        <Segmented
          value={s.treatment}
          onChange={(t) => p.commit(t === 'bw' ? 'Black & White' : 'Color', (d) => (d.treatment = t))}
          options={[
            { value: 'color', label: 'Color' },
            { value: 'bw', label: 'B&W' },
          ]}
        />
      </div>
      <div className="subhead">
        <span>White balance</span>
        <span className="row">
          {p.onWbPick && (
            <IconButton title="White balance selector — click a neutral area" shortcut="W" active={p.wbPicking} onClick={p.onWbPick}>
              <Pipette size={14} />
            </IconButton>
          )}
          {p.sample && (
            <Button small title="Auto white balance" onClick={() => p.commit('Auto White Balance', (d) => Object.assign(d, autoWhiteBalance(p.sample!, d)))}>
              Auto
            </Button>
          )}
        </span>
      </div>
      {sl('Temp', (x) => x.temperature, (d, v) => (d.temperature = v), -100, 100, { track: T_TEMP })}
      {sl('Tint', (x) => x.tint, (d, v) => (d.tint = v), -100, 100, { track: T_TINT })}
      <div className="subhead">
        <span>Tone</span>
        {p.sample && (
          <Button small title="Auto tone: exposure, contrast, highlights, shadows, whites and blacks" onClick={() => p.commit('Auto Tone', (d) => Object.assign(d, autoTone(p.sample!, d)))}>
            Auto
          </Button>
        )}
      </div>
      {sl('Exposure', (x) => x.exposure, (d, v) => (d.exposure = v), -5, 5, { step: 0.01, track: T_EXP })}
      {sl('Contrast', (x) => x.contrast, (d, v) => (d.contrast = v), -100, 100)}
      {sl('Highlights', (x) => x.highlights, (d, v) => (d.highlights = v), -100, 100)}
      {sl('Shadows', (x) => x.shadows, (d, v) => (d.shadows = v), -100, 100)}
      {sl('Whites', (x) => x.whites, (d, v) => (d.whites = v), -100, 100)}
      {sl('Blacks', (x) => x.blacks, (d, v) => (d.blacks = v), -100, 100)}
      <div className="subhead">Presence</div>
      {sl('Texture', (x) => x.texture, (d, v) => (d.texture = v), -100, 100)}
      {sl('Clarity', (x) => x.clarity, (d, v) => (d.clarity = v), -100, 100)}
      {sl('Dehaze', (x) => x.dehaze, (d, v) => (d.dehaze = v), -100, 100)}
      {sl('Vibrance', (x) => x.vibrance, (d, v) => (d.vibrance = v), -100, 100, { track: T_SAT })}
      {sl('Saturation', (x) => x.saturation, (d, v) => (d.saturation = v), -100, 100, { track: T_SAT })}
    </Panel>
  );
}

const CURVE_PRESETS: Record<string, CurvePoint[]> = {
  Linear: [[0, 0], [1, 1]],
  'Medium Contrast': [[0, 0], [0.25, 0.22], [0.5, 0.5], [0.75, 0.79], [1, 1]],
  'Strong Contrast': [[0, 0], [0.25, 0.18], [0.5, 0.5], [0.75, 0.84], [1, 1]],
  Matte: [[0, 0.1], [0.25, 0.24], [0.75, 0.8], [1, 0.95]],
  Fade: [[0, 0.14], [0.5, 0.52], [1, 0.92]],
};

export function ToneCurvePanel(p: DevPanelProps) {
  const [ch, setCh] = useState<'master' | 'red' | 'green' | 'blue'>('master');
  const pts = p.s.curve[ch];
  const hist = p.hist ? (ch === 'master' ? p.hist.l : p.hist[ch === 'red' ? 'r' : ch === 'green' ? 'g' : 'b']) : null;
  const name = { master: 'RGB', red: 'Red', green: 'Green', blue: 'Blue' }[ch];
  return (
    <Panel
      title="Tone Curve"
      id="dev-curve"
      actions={
        <IconButton title="Reset curve" onClick={() => p.commit(`Reset ${name} Curve`, (d) => (d.curve[ch] = DEFAULT_SETTINGS.curve[ch]))}>
          <RotateCcw size={13} />
        </IconButton>
      }
    >
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <Segmented
          value={ch}
          onChange={setCh}
          options={[
            { value: 'master', label: 'RGB' },
            { value: 'red', label: <span style={{ color: '#ff6b6b' }}>R</span> },
            { value: 'green', label: <span style={{ color: '#6bd47a' }}>G</span> },
            { value: 'blue', label: <span style={{ color: '#6b9bff' }}>B</span> },
          ]}
        />
        <select
          value=""
          onChange={(e) => {
            const c = CURVE_PRESETS[e.target.value];
            if (c) p.commit(`Curve: ${e.target.value}`, (d) => (d.curve[ch] = c));
          }}
          aria-label="Curve preset"
        >
          <option value="">Preset…</option>
          {Object.keys(CURVE_PRESETS).map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </div>
      <CurveEditor
        points={pts}
        channel={ch}
        hist={hist}
        onChange={(np) => p.live((d) => (d.curve[ch] = np))}
        onCommit={(np) => p.commit(`${name} Curve`, (d) => (d.curve[ch] = np))}
      />
      <div className="hint">Click to add a point, drag to shape, double-click or drag a point out to remove it.</div>
    </Panel>
  );
}

export function ColorMixerPanel(p: DevPanelProps) {
  const [mode, setMode] = useState<'hue' | 'sat' | 'lum'>('hue');
  const sl = useSl(p);
  const bw = p.s.treatment === 'bw';
  const m = bw ? 'lum' : mode;
  const track = (i: number) => {
    const h = HSL_HUES[i];
    const c = (hh: number, s = 1, v = 1) => rgbToHex(...hsvToRgb(hh, s, v));
    if (m === 'hue') return `linear-gradient(90deg,${c(h - 30)},${c(h)},${c(h + 30)})`;
    if (m === 'sat') return `linear-gradient(90deg,#8a8a8a,${c(h)})`;
    return `linear-gradient(90deg,${c(h, 1, 0.25)},${c(h, 0.9, 0.8)},${c(h, 0.35, 1)})`;
  };
  return (
    <Panel title={bw ? 'B&W Mix' : 'Color Mixer'} id="dev-hsl">
      {!bw && (
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'hue', label: 'Hue' },
            { value: 'sat', label: 'Saturation' },
            { value: 'lum', label: 'Luminance' },
          ]}
        />
      )}
      <div style={{ marginTop: 6 }}>
        {HSL_NAMES.map((n, i) =>
          sl(n, (x) => x.hsl[m][i], (d, v) => {
            d.hsl[m] = [...d.hsl[m]];
            d.hsl[m][i] = v;
          }, -100, 100, { track: track(i) }),
        )}
      </div>
    </Panel>
  );
}

export function ColorGradingPanel(p: DevPanelProps) {
  const sl = useSl(p);
  const g = p.s.grading;
  const wheel = (key: 'shadows' | 'midtones' | 'highlights' | 'global', label: string) => (
    <ColorWheel
      key={key}
      label={label}
      value={g[key]}
      size={112}
      onChange={(w: Wheel) => p.live((d) => (d.grading[key] = w))}
      onCommit={(w: Wheel) => p.commit(`Color Grading ${label}`, (d) => (d.grading[key] = w))}
    />
  );
  return (
    <Panel title="Color Grading" id="dev-grading" defaultOpen={false}>
      <div className="wheels">
        {wheel('shadows', 'Shadows')}
        {wheel('highlights', 'Highlights')}
        {wheel('midtones', 'Midtones')}
        {wheel('global', 'Global')}
      </div>
      {sl('Blending', (x) => x.grading.blending, (d, v) => (d.grading.blending = v), 0, 100, { def: 50, signed: false })}
      {sl('Balance', (x) => x.grading.balance, (d, v) => (d.grading.balance = v), -100, 100)}
    </Panel>
  );
}

export function DetailPanel(p: DevPanelProps) {
  const sl = useSl(p);
  return (
    <Panel title="Detail" id="dev-detail" defaultOpen={false}>
      <div className="subhead">Sharpening</div>
      {sl('Amount', (x) => x.sharpen.amount, (d, v) => (d.sharpen.amount = v), 0, 150, { signed: false })}
      {sl('Radius', (x) => x.sharpen.radius, (d, v) => (d.sharpen.radius = v), 0.5, 3, { step: 0.1, def: 1, digits: 1, signed: false })}
      {sl('Detail', (x) => x.sharpen.detail, (d, v) => (d.sharpen.detail = v), 0, 100, { def: 25, signed: false })}
      {sl('Masking', (x) => x.sharpen.masking, (d, v) => (d.sharpen.masking = v), 0, 100, { signed: false })}
      <div className="subhead">Noise reduction</div>
      {sl('Luminance', (x) => x.noise.luminance, (d, v) => (d.noise.luminance = v), 0, 100, { signed: false })}
      {sl('Color', (x) => x.noise.color, (d, v) => (d.noise.color = v), 0, 100, { signed: false })}
      <div className="hint">Sharpening is resolution dependent: zoom to 1:1 to judge it accurately.</div>
    </Panel>
  );
}

export function EffectsPanel(p: DevPanelProps) {
  const sl = useSl(p);
  return (
    <Panel title="Effects" id="dev-effects" defaultOpen={false}>
      <div className="subhead">Post-crop vignetting</div>
      {sl('Amount', (x) => x.vignette.amount, (d, v) => (d.vignette.amount = v), -100, 100)}
      {sl('Midpoint', (x) => x.vignette.midpoint, (d, v) => (d.vignette.midpoint = v), 0, 100, { def: 50, signed: false })}
      {sl('Roundness', (x) => x.vignette.roundness, (d, v) => (d.vignette.roundness = v), -100, 100)}
      {sl('Feather', (x) => x.vignette.feather, (d, v) => (d.vignette.feather = v), 0, 100, { def: 50, signed: false })}
      {sl('Highlights', (x) => x.vignette.highlights, (d, v) => (d.vignette.highlights = v), 0, 100, { signed: false })}
      <div className="subhead">Grain</div>
      {sl('Amount', (x) => x.grain.amount, (d, v) => (d.grain.amount = v), 0, 100, { signed: false })}
      {sl('Size', (x) => x.grain.size, (d, v) => (d.grain.size = v), 0, 100, { def: 25, signed: false })}
      {sl('Roughness', (x) => x.grain.roughness, (d, v) => (d.grain.roughness = v), 0, 100, { def: 50, signed: false })}
    </Panel>
  );
}

export function AdjustmentPanels(p: DevPanelProps & { showHistogram?: boolean }) {
  return (
    <>
      {p.showHistogram && (
        <div className="hist-wrap">
          <HistogramView data={p.hist ?? null} width={282} />
        </div>
      )}
      <BasicPanel {...p} />
      <ToneCurvePanel {...p} />
      <ColorMixerPanel {...p} />
      <ColorGradingPanel {...p} />
      <DetailPanel {...p} />
      <EffectsPanel {...p} />
    </>
  );
}
