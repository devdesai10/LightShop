// Trackpad and mouse-wheel navigation for zoomable views (Develop, Editor, Library).
//
// Chromium, and so the Electron desktop app, reports a trackpad pinch as `wheel` events with ctrlKey
// set and deltaY = -100·ln(scale step). Two-finger scrolling arrives as ordinary pixel-precise wheel
// events, momentum included. Safari reports pinches as GestureEvents instead, so both are handled.

export interface ViewGestureHandlers {
  /** Multiplies the zoom by `factor`, keeping the client point (x, y) where it is. */
  zoom(factor: number, x: number, y: number): void;
  /** Moves the content by (dx, dy) CSS pixels. */
  pan(dx: number, dy: number): void;
  /** A deliberate horizontal two-finger swipe, reported once per gesture (1 = towards the next item). */
  swipe?(dir: -1 | 1): void;
}

/** Wheel deltas in CSS pixels, whatever unit the browser reported them in. */
export function wheelDelta(e: WheelEvent, pageHeight: number): { dx: number; dy: number } {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageHeight : 1;
  let dx = e.deltaX * k;
  let dy = e.deltaY * k;
  // A mouse wheel with Shift held scrolls sideways (macOS already swaps the axes itself).
  if (e.shiftKey && !dx) [dx, dy] = [dy, 0];
  return { dx, dy };
}

/** Zoom step for a zooming wheel event: pinches are fine-grained, mouse-wheel notches coarse. */
export function wheelZoomFactor(dy: number, pinch: boolean): number {
  const f = Math.exp(-dy * (pinch ? 0.01 : 0.0025));
  return Math.min(2, Math.max(0.5, f));
}

/** Wheel events further apart than this start a new gesture (for swipe detection). */
const GESTURE_GAP_MS = 220;

/**
 * Pinch / ⌘-scroll / ⌥-scroll zooms, two-finger scroll pans, and (optionally) a horizontal swipe steps
 * between items. Returns a function that removes the listeners.
 */
export function attachViewGestures(el: HTMLElement, h: ViewGestureHandlers): () => void {
  let pinchScale: number | null = null; // Safari: scale at the previous gesturechange
  let swipe = { x: 0, y: 0, t: 0, done: false };

  const onWheel = (e: WheelEvent) => {
    e.preventDefault(); // no page zoom or scrolling behind the view
    const { dx, dy } = wheelDelta(e, el.clientHeight);
    if (e.ctrlKey || e.metaKey || e.altKey) {
      if (pinchScale === null) h.zoom(wheelZoomFactor(dy, e.ctrlKey), e.clientX, e.clientY);
      return;
    }
    h.pan(-dx, -dy);
    if (!h.swipe) return;
    const now = performance.now();
    if (now - swipe.t > GESTURE_GAP_MS) swipe = { x: 0, y: 0, t: now, done: false };
    swipe.t = now;
    swipe.x += dx;
    swipe.y += dy;
    // Mostly sideways and far enough; the momentum tail belongs to the same gesture, so it fires once.
    if (!swipe.done && Math.abs(swipe.x) > 120 && Math.abs(swipe.x) > 1.6 * Math.abs(swipe.y)) {
      swipe.done = true;
      h.swipe(swipe.x > 0 ? 1 : -1);
    }
  };

  type SafariGesture = Event & { scale: number; clientX: number; clientY: number };
  const onGestureStart = (e: Event) => {
    e.preventDefault();
    pinchScale = 1;
  };
  const onGestureChange = (e: Event) => {
    e.preventDefault();
    const g = e as SafariGesture;
    if (g.scale > 0) h.zoom(g.scale / (pinchScale ?? 1), g.clientX, g.clientY);
    pinchScale = g.scale;
  };
  const onGestureEnd = (e: Event) => {
    e.preventDefault();
    pinchScale = null;
  };

  const opts = { passive: false } as const;
  el.addEventListener('wheel', onWheel, opts);
  el.addEventListener('gesturestart', onGestureStart, opts);
  el.addEventListener('gesturechange', onGestureChange, opts);
  el.addEventListener('gestureend', onGestureEnd, opts);
  return () => {
    el.removeEventListener('wheel', onWheel);
    el.removeEventListener('gesturestart', onGestureStart);
    el.removeEventListener('gesturechange', onGestureChange);
    el.removeEventListener('gestureend', onGestureEnd);
  };
}

/**
 * Stops pinches from zooming the whole page in a browser (the views zoom themselves). Ctrl+wheel is
 * what Chromium reports for a pinch; Safari sends gesture events.
 */
export function preventPageZoom(): () => void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };
  const onGesture = (e: Event) => e.preventDefault();
  const opts = { passive: false } as const;
  window.addEventListener('wheel', onWheel, opts);
  document.addEventListener('gesturestart', onGesture, opts);
  document.addEventListener('gesturechange', onGesture, opts);
  return () => {
    window.removeEventListener('wheel', onWheel);
    document.removeEventListener('gesturestart', onGesture);
    document.removeEventListener('gesturechange', onGesture);
  };
}
