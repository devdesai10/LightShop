// Promise-based replacements for window.prompt/confirm. Electron does not implement prompt(), and
// in-app dialogs look consistent in both the browser and the desktop app.

import { useEffect, useRef, useState } from 'react';
import { createStore } from '../state/store';
import { Button, Modal } from './controls';

type Request =
  | { kind: 'prompt'; title: string; message?: string; value: string; okLabel: string; resolve: (v: string | null) => void }
  | { kind: 'confirm'; title: string; message: string; okLabel: string; cancelLabel: string; danger: boolean; resolve: (v: boolean) => void };

// Requests are queued, so a second dialog waits for the first instead of replacing it.
const queue = createStore<{ reqs: Request[] }>({ reqs: [] });
const ids = new WeakMap<Request, number>();
let nextId = 1;
const enqueue = (r: Request) => {
  ids.set(r, nextId++);
  queue.set((s) => ({ reqs: [...s.reqs, r] }));
};

export function promptText(title: string, initial = '', opts: { message?: string; okLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: 'prompt', title, value: initial, message: opts.message, okLabel: opts.okLabel ?? 'OK', resolve }));
}

/** Resolves true for the OK button; false for the cancel button, Escape or closing the dialog. */
export function confirmDialog(title: string, message: string, opts: { okLabel?: string; cancelLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) =>
    enqueue({ kind: 'confirm', title, message, okLabel: opts.okLabel ?? 'OK', cancelLabel: opts.cancelLabel ?? 'Cancel', danger: !!opts.danger, resolve }),
  );
}

export function DialogHost() {
  const req = queue.use((s) => s.reqs[0] ?? null);
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (req?.kind === 'prompt') {
      setValue(req.value);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [req]);
  if (!req) return null;
  const finish = (ok: boolean) => {
    queue.set((s) => ({ reqs: s.reqs.filter((r) => r !== req) }));
    if (req.kind === 'prompt') req.resolve(ok ? value : null);
    else req.resolve(ok);
  };
  return (
    <Modal
      key={ids.get(req)}
      title={req.title}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>{req.kind === 'confirm' ? req.cancelLabel : 'Cancel'}</Button>
          <Button primary onClick={() => finish(true)} disabled={req.kind === 'prompt' && !value.trim()}>
            {req.okLabel}
          </Button>
        </>
      }
    >
      {req.message && <p style={{ marginTop: 0 }}>{req.message}</p>}
      {req.kind === 'prompt' && (
        <input
          ref={inputRef}
          className="text-input"
          style={{ width: '100%' }}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter' && value.trim()) finish(true);
          }}
          aria-label={req.title}
        />
      )}
    </Modal>
  );
}
