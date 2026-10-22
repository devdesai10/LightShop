import { useEffect, useRef } from 'react';
import { hsvToRgb } from '../lib/color';
import { CurvePoint, makeCurve } from '../lib/spline';
import type { Histogram } from '../develop/renderer';
import type { Wheel } from '../develop/settings';
import { Slider } from './controls';

function useCanvas(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void, deps: unknown[], w: number, h: number) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) c.width = Math.round(w * dpr);
    if (c.height !== Math.round(h * dpr)) c.height = Math.round(h * dpr);
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    draw(ctx, w, h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, w, h]);
  return ref;
}

// ---------------------------------------------------------------- Histogram
export function HistogramView({ data, width = 268, height = 96 }: { data: Histogram | null; width?: number; height?: number }) {
  const ref = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = '#151517';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      for (let i = 1; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo((w * i) / 4 + 0.5, 0);
        ctx.lineTo((w * i) / 4 + 0.5, h);
        ctx.stroke();
      }
      if (!data) return;
      let max = 1;
      for (const ch of [data.r, data.g, data.b]) for (let i = 2; i < 254; i++) max = Math.max(max, ch[i]);
      const plot = (ch: Uint32Array, color: string) => {
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let i = 0; i < 256; i++) {
          const v = Math.min(1, ch[i] / max);
          ctx.lineTo((i / 255) * w, h - v * (h - 4));
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };
      ctx.globalCompositeOperation = 'lighter';
      plot(data.r, 'rgba(220,60,60,0.75)');
      plot(data.g, 'rgba(60,200,80,0.75)');
      plot(data.b, 'rgba(70,110,235,0.75)');
      ctx.globalCompositeOperation = 'source-over';
      const lo = (data.l[0] / data.total) > 0.002;
      const hi = (data.l[255] / data.total) > 0.002;
      const tri = (x: number, on: boolean, left: boolean) => {
        ctx.fillStyle = on ? '#fff' : 'rgba(255,255,255,0.18)';
        ctx.beginPath();
        if (left) {
          ctx.moveTo(x, 4);
          ctx.lineTo(x + 9, 4);
          ctx.lineTo(x, 13);
        } else {
          ctx.moveTo(x, 4);
          ctx.lineTo(x - 9, 4);
          ctx.lineTo(x, 13);
        }
        ctx.fill();
      };
      tri(4, lo, true);
      tri(w - 4, hi, false);
    },
    [data],
    width,
    height,
  );
  return <canvas ref={ref} className="histogram" style={{ width, height }} aria-label="Histogram" role="img" />;
}

// ---------------------------------------------------------------- Curve editor
const CURVE_COLORS: Record<string, string> = { master: '#e8e8e8', red: '#ff5a5a', green: '#5ad46a', blue: '#5a8cff' };

export function CurveEditor({
  points,
  channel,
  onChange,
  onCommit,
  size = 236,
  hist,
}: {
  points: CurvePoint[];
  channel: 'master' | 'red' | 'green' | 'blue';
  onChange: (p: CurvePoint[]) => void;
  onCommit: (p: CurvePoint[]) => void;
  size?: number;
  hist?: Uint32Array | null;
}) {
  const pad = 6;
  const inner = size - pad * 2;
  const drag = useRef<{ i: number; pts: CurvePoint[] } | null>(null);
  const ref = useCanvas(
    (ctx, w, h) => {
      ctx.fillStyle = '#151517';
      ctx.fillRect(0, 0, w, h);
      if (hist) {
        let max = 1;
        for (let i = 2; i < 254; i++) max = Math.max(max, hist[i]);
        ctx.beginPath();
        ctx.moveTo(pad, pad + inner);
        for (let i = 0; i < 256; i++) ctx.lineTo(pad + (i / 255) * inner, pad + inner - Math.min(1, hist[i] / max) * inner * 0.9);
        ctx.lineTo(pad + inner, pad + inner);
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fill();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 4; i++) {
        const t = pad + (inner * i) / 4 + 0.5;
        ctx.beginPath();
        ctx.moveTo(t, pad);
        ctx.lineTo(t, pad + inner);
        ctx.moveTo(pad, t);
        ctx.lineTo(pad + inner, t);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.beginPath();
      ctx.moveTo(pad, pad + inner);
      ctx.lineTo(pad + inner, pad);
      ctx.stroke();
      const f = makeCurve(points);
      ctx.strokeStyle = CURVE_COLORS[channel];
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i <= inner; i++) {
        const x = i / inner;
        const y = Math.min(1, Math.max(0, f(x)));
        const px = pad + i;
        const py = pad + (1 - y) * inner;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
      for (const [x, y] of points) {
        ctx.fillStyle = '#1b1b1d';
        ctx.strokeStyle = CURVE_COLORS[channel];
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pad + x * inner, pad + (1 - y) * inner, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    },
    [points, channel, hist],
    size,
    size,
  );

  const toCurve = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = ref.current!.getBoundingClientRect();
    return [(e.clientX - r.left - pad) / inner, 1 - (e.clientY - r.top - pad) / inner];
  };

  const onDown = (e: React.PointerEvent) => {
    const [x, y] = toCurve(e);
    const pts = points.map((p) => [...p] as CurvePoint);
    let idx = pts.findIndex((p) => Math.hypot((p[0] - x) * inner, (p[1] - y) * inner) < 9);
    if (idx < 0) {
      const cx = Math.min(0.99, Math.max(0.01, x));
      const f = makeCurve(pts);
      const cy = Math.abs(f(cx) - y) * inner < 14 ? f(cx) : y;
      pts.push([cx, Math.min(1, Math.max(0, cy))]);
      pts.sort((a, b) => a[0] - b[0]);
      idx = pts.findIndex((p) => p[0] === cx);
      onChange(pts);
    }
    drag.current = { i: idx, pts };
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, y] = toCurve(e);
    const pts = d.pts.map((p) => [...p] as CurvePoint);
    const i = d.i;
    const isEnd = i === 0 || i === pts.length - 1;
    const outside = y < -0.12 || y > 1.12 || x < -0.12 || x > 1.12;
    if (!isEnd && outside) {
      onChange(pts.filter((_, k) => k !== i));
      return;
    }
    const lo = i === 0 ? 0 : pts[i - 1][0] + 0.01;
    const hi = i === pts.length - 1 ? 1 : pts[i + 1][0] - 0.01;
    pts[i] = [Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))];
    d.pts = pts;
    onChange(pts);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const [x, y] = toCurve(e);
    const isEnd = d.i === 0 || d.i === d.pts.length - 1;
    const outside = y < -0.12 || y > 1.12 || x < -0.12 || x > 1.12;
    onCommit(!isEnd && outside ? d.pts.filter((_, k) => k !== d.i) : d.pts);
  };
  const onDbl = (e: React.MouseEvent) => {
    const [x, y] = toCurve(e);
    const idx = points.findIndex((p) => Math.hypot((p[0] - x) * inner, (p[1] - y) * inner) < 9);
    if (idx > 0 && idx < points.length - 1) {
      const pts = points.filter((_, k) => k !== idx);
      onChange(pts);
      onCommit(pts);
    }
  };
  return (
    <canvas
      ref={ref}
      className="curve-editor"
      style={{ width: size, height: size, touchAction: 'none' }}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onDoubleClick={onDbl}
      role="img"
      aria-label={`${channel} tone curve editor. Click to add points, drag to adjust, double-click a point to remove it.`}
    />
  );
}

// ---------------------------------------------------------------- Color wheel
let wheelCache: HTMLCanvasElement | null = null;
function wheelImage(size: number): HTMLCanvasElement {
  if (wheelCache && wheelCache.width === size) return wheelCache;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const r0 = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - r0;
      const dy = r0 - (y + 0.5);
      const r = Math.hypot(dx, dy) / r0;
      const i = (y * size + x) * 4;
      if (r > 1) continue;
      const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
      const [R, G, B] = hsvToRgb(hue, Math.min(1, r) * 0.85, 0.82);
      img.data[i] = R * 255;
      img.data[i + 1] = G * 255;
      img.data[i + 2] = B * 255;
      img.data[i + 3] = r > 0.985 ? Math.round(((1 - r) / 0.015) * 255) : 255;
    }
  ctx.putImageData(img, 0, 0);
  wheelCache = c;
  return c;
}

export function ColorWheel({
  label,
  value,
  onChange,
  onCommit,
  size = 120,
}: {
  label: string;
  value: Wheel;
  onChange: (w: Wheel) => void;
  onCommit: (w: Wheel) => void;
  size?: number;
}) {
  const latest = useRef(value);
  latest.current = value;
  const ref = useCanvas(
    (ctx, w) => {
      ctx.drawImage(wheelImage(256), 0, 0, w, w);
      const a = (value.hue * Math.PI) / 180;
      const r = (value.sat / 100) * (w / 2);
      const x = w / 2 + Math.cos(a) * r;
      const y = w / 2 - Math.sin(a) * r;
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath();
      ctx.moveTo(w / 2 - 6, w / 2);
      ctx.lineTo(w / 2 + 6, w / 2);
      ctx.moveTo(w / 2, w / 2 - 6);
      ctx.lineTo(w / 2, w / 2 + 6);
      ctx.stroke();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    },
    [value.hue, value.sat],
    size,
    size,
  );
  const fromEvent = (e: { clientX: number; clientY: number }): Wheel => {
    const rc = ref.current!.getBoundingClientRect();
    const dx = e.clientX - rc.left - size / 2;
    const dy = size / 2 - (e.clientY - rc.top);
    const hue = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360);
    const sat = Math.round(Math.min(1, Math.hypot(dx, dy) / (size / 2)) * 100);
    return { ...latest.current, hue, sat };
  };
  return (
    <div className="color-wheel">
      <div className="color-wheel-label">{label}</div>
      <canvas
        ref={ref}
        style={{ width: size, height: size, touchAction: 'none' }}
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          onChange(fromEvent(e));
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) onChange(fromEvent(e));
        }}
        onPointerUp={() => onCommit(latest.current)}
        onDoubleClick={() => {
          const w = { ...latest.current, hue: 0, sat: 0 };
          onChange(w);
          onCommit(w);
        }}
        role="img"
        aria-label={`${label} color wheel: hue ${value.hue}, saturation ${value.sat}`}
      />
      <div className="color-wheel-readout">
        H {value.hue}° · S {value.sat}
      </div>
      <Slider
        label="Luminance"
        value={value.lum}
        min={-100}
        max={100}
        onChange={(lum) => onChange({ ...latest.current, lum })}
        onCommit={(lum) => onCommit({ ...latest.current, lum })}
      />
    </div>
  );
}
