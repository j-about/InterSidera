// jest-dom matchers on Vitest's `expect` (jest-dom 7 exposes them at the `/vitest` subpath).
import '@testing-library/jest-dom/vitest';
// Initialise i18next once per worker so components render the real en.json strings.
import '../i18n';

// jsdom 30 implements `<dialog>` as an empty class (the `open` attribute reflects, nothing else):
// this polyfill gives `showModal()` / `close()` the parts the components rely on (backlog B-65):
// the `open` state, the focus moved inside on open and restored to the previously focused element
// on close, the `close` event React's `onClose` listens to. No top layer, no inert background:
// those are asserted in Playwright. Pure-module tests run under `node` (no DOM at all): both
// shims are skipped there.
const dialogPrototype =
  typeof HTMLDialogElement === 'undefined'
    ? null
    : (HTMLDialogElement.prototype as {
        showModal?: () => void;
        close?: (returnValue?: string) => void;
        returnValue?: string;
      });
if (dialogPrototype !== null && typeof dialogPrototype.showModal !== 'function') {
  const openers = new WeakMap<HTMLDialogElement, Element | null>();
  const FOCUSABLE =
    '[autofocus], button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  dialogPrototype.showModal = function showModal(this: HTMLDialogElement): void {
    if (this.open) {
      throw new DOMException('The dialog is already open.', 'InvalidStateError');
    }
    openers.set(this, document.activeElement);
    this.setAttribute('open', '');
    const first = this.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? this).focus();
  };
  dialogPrototype.close = function close(this: HTMLDialogElement, returnValue?: string): void {
    if (!this.open) {
      return;
    }
    if (returnValue !== undefined) {
      this.returnValue = returnValue;
    }
    this.removeAttribute('open');
    const opener = openers.get(this);
    openers.delete(this);
    if (opener instanceof HTMLElement && opener.isConnected) {
      opener.focus();
    }
    this.dispatchEvent(new Event('close'));
  };
}

// jsdom has no `matchMedia`: the shell reads the `md` breakpoint and the engine reads
// `prefers-reduced-motion` through it. Nothing matches under tests (the phone layout).
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  });
}
