import { useSyncExternalStore } from 'react';

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T> | ((s: T) => Partial<T>)): void;
  subscribe(listener: () => void): () => void;
  /** React hook. The selector must return a stable value (a field or primitive), not a new object. */
  use<U>(selector: (s: T) => U): U;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  const subscribe = (l: () => void) => {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  };
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      listeners.forEach((l) => l());
    },
    subscribe,
    use<U>(selector: (s: T) => U): U {
      return useSyncExternalStore(subscribe, () => selector(state));
    },
  };
}

/** Minimal event emitter used by mutable engine objects (editor documents) to notify React. */
export class Emitter {
  private listeners = new Set<() => void>();
  version = 0;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };
  emit() {
    this.version++;
    this.listeners.forEach((l) => l());
  }
}

export function useEmitter(e: Emitter | null | undefined): number {
  return useSyncExternalStore(
    e ? e.subscribe : noopSubscribe,
    () => (e ? e.version : 0),
  );
}
const noopSubscribe = () => () => {};
