import { ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Star, X } from 'lucide-react';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- Slider
export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  format?: (v: number) => string;
  track?: string; // CSS background for the track
  disabled?: boolean;
  unit?: string;
}

export function Slider({ label, value, min, max, step = 1, defaultValue = 0, onChange, onCommit, format, track, disabled, unit }: SliderProps) {
  const id = useId();
  const [text, setText] = useState<string | null>(null);
  const shown = format ? format(value) : step < 1 ? value.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(value));
  const reset = () => {
    onChange(defaultValue);
    onCommit?.(defaultValue);
  };
  const commitText = () => {
    if (text === null) return;
    const v = parseFloat(text.replace(/[^0-9.+-]/g, ''));
    setText(null);
    if (!isNaN(v)) {
      const c = Math.min(max, Math.max(min, v));
      onChange(c);
      onCommit?.(c);
    }
  };
  const pct = ((value - min) / (max - min)) * 100;
  const zero = ((Math.min(max, Math.max(min, defaultValue)) - min) / (max - min)) * 100;
  return (
    <div className={cx('slider', disabled && 'disabled')}>
      <div className="slider-head">
        <label htmlFor={id} onDoubleClick={reset} title="Double-click to reset">
          {label}
        </label>
        <input
          className="slider-value"
          value={text ?? shown + (unit ?? '')}
          onFocus={(e) => {
            setText(shown);
            requestAnimationFrame(() => e.target.select());
          }}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setText(null);
              (e.target as HTMLInputElement).blur();
            }
            e.stopPropagation();
          }}
          disabled={disabled}
          aria-label={`${label} value`}
        />
      </div>
      <div className="slider-track-wrap" style={track ? { ['--track' as string]: track } : undefined}>
        {!track && (
          <div
            className="slider-fill"
            style={{ left: `${Math.min(pct, zero)}%`, width: `${Math.abs(pct - zero)}%` }}
          />
        )}
        <input
          id={id}
          type="range"
          className={cx('slider-range', track && 'has-track')}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          onPointerUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onCommit?.(parseFloat((e.target as HTMLInputElement).value))}
          onDoubleClick={reset}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Panel
export function Panel({
  title,
  children,
  id,
  actions,
  defaultOpen = true,
  onToggleEnabled,
  enabled,
}: {
  title: string;
  children: ReactNode;
  id: string;
  actions?: ReactNode;
  defaultOpen?: boolean;
  enabled?: boolean;
  onToggleEnabled?: () => void;
}) {
  const key = `ls.panel.${id}`;
  const [open, setOpen] = useState(() => {
    const v = localStorage.getItem(key);
    return v === null ? defaultOpen : v === '1';
  });
  useEffect(() => localStorage.setItem(key, open ? '1' : '0'), [key, open]);
  return (
    <section className={cx('panel', open && 'open')}>
      <header className="panel-head">
        <button className="panel-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span>{title}</span>
        </button>
        <div className="panel-actions">
          {actions}
          {onToggleEnabled && (
            <button
              className={cx('panel-switch', enabled && 'on')}
              onClick={onToggleEnabled}
              title={enabled ? 'Disable' : 'Enable'}
              aria-pressed={enabled}
            />
          )}
        </div>
      </header>
      {open && <div className="panel-body">{children}</div>}
    </section>
  );
}

// ---------------------------------------------------------------- Buttons
export function IconButton({
  title,
  onClick,
  children,
  active,
  disabled,
  className,
  shortcut,
}: {
  title: string;
  onClick?: (e: React.MouseEvent) => void;
  children: ReactNode;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  shortcut?: string;
}) {
  return (
    <button
      className={cx('icon-btn', active && 'active', className)}
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export function Button({
  children,
  onClick,
  primary,
  disabled,
  title,
  className,
  small,
}: {
  children: ReactNode;
  onClick?: (e: React.MouseEvent) => void;
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  small?: boolean;
}) {
  return (
    <button className={cx('btn', primary && 'primary', small && 'small', className)} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  className,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cx('segmented', className)} role="tablist">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          className={cx(o.value === value && 'active')}
          onClick={() => onChange(o.value)}
          title={o.title}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Modal
export function Modal({
  title,
  children,
  onClose,
  footer,
  width = 420,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button.primary')?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', className)} style={{ width }} ref={ref} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Rating
export function Stars({ value, onChange, size = 12 }: { value: number; onChange?: (v: number) => void; size?: number }) {
  return (
    <span className={cx('stars', onChange && 'editable')} role={onChange ? 'radiogroup' : undefined} aria-label={`${value} stars`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          role={onChange ? 'radio' : undefined}
          aria-checked={onChange ? value === i : undefined}
          aria-label={onChange ? `${i} star${i > 1 ? 's' : ''}` : undefined}
          className={cx('star', i <= value && 'on')}
          onClick={
            onChange
              ? (e) => {
                  e.stopPropagation();
                  onChange(value === i ? 0 : i);
                }
              : undefined
          }
        >
          <Star size={size} fill={i <= value ? 'currentColor' : 'none'} />
        </span>
      ))}
    </span>
  );
}

// ---------------------------------------------------------------- Field
export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('field', className)}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  width = 64,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  ariaLabel?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      type="number"
      className="num-input"
      style={{ width }}
      value={text ?? String(value)}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (!isNaN(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
      }}
      onBlur={() => setText(null)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  );
}

/** Generic hook: pointer drag helper that captures the pointer. */
export function startDrag(
  e: React.PointerEvent,
  onMove: (ev: PointerEvent) => void,
  onUp?: (ev: PointerEvent) => void,
) {
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => onMove(ev);
  const up = (ev: PointerEvent) => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    onUp?.(ev);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
