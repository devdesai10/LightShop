// Hover tooltips for tool buttons: the tool's name, its keyboard shortcuts and a line about what it does.
// One tooltip shows at a time, in a portal so toolbars that scroll or clip can't cut it off. The first one
// appears after a short pause; while one is showing (or just after), moving to the next button shows its
// tooltip straight away, as in macOS. Keyboard focus shows it too.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { createStore } from '../state/store';

export interface TipContent {
  title: string;
  /** Shortcuts as printed on the keys, e.g. ['V'] or ['K', '⌘T']. */
  keys?: string[];
  /** What it does, in a sentence or two. */
  text?: string;
}

/** Which side of the button the tooltip prefers (it flips when there's no room). */
export type TipSide = 'right' | 'bottom';

interface Shown {
  anchor: HTMLElement;
  content: TipContent;
  side: TipSide;
}

const tipStore = createStore<{ shown: Shown | null }>({ shown: null });

/** Pause before the first tooltip (ms). */
const DELAY = 450;
/** After a tooltip hides, the next one shows at once for this long (ms). */
const WARM = 600;

let timer = 0;
let lastHidden = -Infinity;
/** The button just clicked: its tooltip stays hidden until the pointer leaves it. */
let suppressed: HTMLElement | null = null;

function show(anchor: HTMLElement, content: TipContent, side: TipSide, now: boolean) {
  clearTimeout(timer);
  if (suppressed === anchor) return;
  const go = () => anchor.isConnected && tipStore.set({ shown: { anchor, content, side } });
  if (now || tipStore.get().shown || performance.now() - lastHidden < WARM) go();
  else timer = window.setTimeout(go, DELAY);
}

/** Hides the tooltip (only if it belongs to `anchor`, when given). */
export function hideTip(anchor?: HTMLElement) {
  clearTimeout(timer);
  const cur = tipStore.get().shown;
  if (!cur || (anchor && cur.anchor !== anchor)) return;
  lastHidden = performance.now();
  tipStore.set({ shown: null });
}

/** The shortcuts in aria-keyshortcuts form ("Shift+G", "Meta+T"; alternatives separated by spaces). */
function ariaKeys(keys: string[]) {
  return keys
    .map((k) => k.replace('Ctrl+', 'Control+').replace(/⌘/g, 'Meta+').replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+').replace(/\s+/g, ''))
    .join(' ');
}

/** Props that give an element a tooltip. */
export function tipProps(content: TipContent, side: TipSide = 'right') {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => show(e.currentTarget, content, side, false),
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      if (suppressed === e.currentTarget) suppressed = null;
      hideTip(e.currentTarget);
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      suppressed = e.currentTarget;
      hideTip();
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget, content, side, true);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => hideTip(e.currentTarget),
    'aria-keyshortcuts': content.keys?.length ? ariaKeys(content.keys) : undefined,
    'aria-description': content.text,
  };
}

/** Renders the current tooltip. Mount once, near the root. */
export function TooltipHost() {
  const shown = tipStore.use((s) => s.shown);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!shown || !el) return setPos(null);
    const a = shown.anchor.getBoundingClientRect();
    const t = el.getBoundingClientRect();
    const M = 8;
    const GAP = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    let left: number;
    let top: number;
    if (shown.side === 'right') {
      left = a.right + GAP;
      if (left + t.width > vw - M) left = a.left - GAP - t.width;
      top = clamp(a.top + a.height / 2 - t.height / 2, M, vh - M - t.height);
    } else {
      top = a.bottom + GAP;
      if (top + t.height > vh - M) top = a.top - GAP - t.height;
      left = clamp(a.left + a.width / 2 - t.width / 2, M, vw - M - t.width);
    }
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const off = () => hideTip();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && hideTip();
    window.addEventListener('scroll', off, true);
    window.addEventListener('resize', off);
    window.addEventListener('blur', off);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('scroll', off, true);
      window.removeEventListener('resize', off);
      window.removeEventListener('blur', off);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [shown]);

  if (!shown || !shown.anchor.isConnected) return null;
  const c = shown.content;
  return createPortal(
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      <div className="tip-head">
        <span className="tip-title">{c.title}</span>
        {c.keys && c.keys.length > 0 && (
          <span className="tip-keys">
            {c.keys.map((k) => (
              <kbd key={k}>{k}</kbd>
            ))}
          </span>
        )}
      </div>
      {c.text && <div className="tip-text">{c.text}</div>}
    </div>,
    document.body,
  );
}
