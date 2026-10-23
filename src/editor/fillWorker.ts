// Web Worker that computes the Crop tool's Expand fills (see inpaint.ts) off the main thread.

import { contentAwareFill, softFill } from './inpaint';

export type WorkerFill = 'content' | 'soft';

export interface FillRequest {
  mode: WorkerFill;
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
  known: Uint8Array;
}

export type FillReply =
  | { type: 'ready' }
  | { type: 'progress'; value: number }
  | { type: 'done'; rgba: Uint8ClampedArray<ArrayBuffer> }
  | { type: 'error'; message: string };

// The project's TypeScript lib is the DOM one; the worker scope only needs these two members.
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<FillRequest>) => void) | null;
  postMessage(msg: FillReply, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  const { mode, w, h, rgba, known } = e.data;
  try {
    const out =
      mode === 'content'
        ? contentAwareFill({ w, h, rgba, known }, { onProgress: (value) => scope.postMessage({ type: 'progress', value }) })
        : softFill({ w, h, rgba, known });
    scope.postMessage({ type: 'done', rgba: out }, [out.buffer]);
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

// Tells the page the worker loaded, so it can hand over the pixels.
scope.postMessage({ type: 'ready' });
