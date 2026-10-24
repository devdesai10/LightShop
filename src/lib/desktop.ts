// Bridge to the Electron shell (electron/preload.cjs). Absent when running in a normal browser.

import { isTypingTarget } from './util';

/** What the shell reports after saving a file. `folder` is the folder's name ("Downloads"). */
export type SaveResult =
  | { ok: true; token: string; name: string; folder: string }
  | { ok: false; error: 'denied' | 'full' | 'other'; message: string; folder: string };

interface DesktopApi {
  platform: string;
  /** Tells the shell whether a text field has focus, so menu shortcuts go to text editing there. */
  setTextFocus(focused: boolean): void;
  /** Shows a Save dialog suggesting `name`; resolves with a token for the chosen file, or null when cancelled. */
  chooseSaveFile?(o: { name: string; ext: string }): Promise<{ token: string; name: string } | null>;
  /** Writes the file chosen with chooseSaveFile. */
  writeSaveFile?(token: string, data: Uint8Array): Promise<SaveResult>;
  /** Saves a new file in the Downloads folder (numbered when the name is taken). */
  quickSave?(o: { name: string; data: Uint8Array }): Promise<SaveResult>;
  /** Shows a saved file in Finder. */
  revealFile?(token: string): void;
}

export const desktop: DesktopApi | null = (window as unknown as { lightshopDesktop?: DesktopApi }).lightshopDesktop ?? null;

export function initDesktop() {
  if (!desktop) return;
  document.documentElement.classList.add('desktop', `platform-${desktop.platform}`);
  let last: boolean | null = null;
  const report = () => {
    const typing = isTypingTarget(document.activeElement);
    if (typing !== last) {
      last = typing;
      desktop!.setTextFocus(typing);
    }
  };
  document.addEventListener('focusin', report);
  document.addEventListener('focusout', () => setTimeout(report, 0));
  report();
}
