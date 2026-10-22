// Bridge to the Electron shell (electron/preload.cjs). Absent when running in a normal browser.

import { isTypingTarget } from './util';

interface DesktopApi {
  platform: string;
  /** Tells the shell whether a text field has focus, so menu shortcuts go to text editing there. */
  setTextFocus(focused: boolean): void;
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
