import { useEffect, useRef } from 'react';

/**
 * @typedef {{
 *   id: number,
 *   onClose: () => void,
 *   poppedByBack: boolean
 * }} OverlayEntry
 */

/**
 * @typedef {{
 *   nextId: number,
 *   stack: OverlayEntry[],
 *   knownIds: Set<number>,
 *   suppressedPopCount: number
 * }} OverlayHistoryState
 */

/** @type {WeakMap<object, OverlayHistoryState>} */
const stateByWindow = new WeakMap();

/**
 * @param {any} [win]
 * @returns {OverlayHistoryState | null}
 */
export function ensureOverlayHistory(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win !== 'object' || !win.history) return null;
  const existing = stateByWindow.get(win);
  if (existing) return existing;

  /** @type {OverlayHistoryState} */
  const state = {
    nextId: 1,
    stack: [],
    knownIds: new Set(),
    suppressedPopCount: 0
  };
  stateByWindow.set(win, state);

  if (typeof win.addEventListener === 'function') {
    const onCapturePopState = (/** @type {any} */ event) => {
      if (state.suppressedPopCount > 0) {
        state.suppressedPopCount -= 1;
        event?.stopImmediatePropagation?.();
        return;
      }
      const top = state.stack[state.stack.length - 1];
      if (!top) return;
      state.stack.pop();
      top.poppedByBack = true;
      event?.stopImmediatePropagation?.();
      top.onClose?.();
    };
    win.addEventListener('popstate', onCapturePopState, true);
  }

  return state;
}

/**
 * Push a dismissible overlay onto the history stack and return its cleanup function.
 *
 * @param {() => void} onClose
 * @param {any} [win]
 * @returns {() => void}
 */
export function registerOverlayBackEntry(onClose, win = typeof window !== 'undefined' ? window : null) {
  const state = ensureOverlayHistory(win);
  if (!state || !win?.history || typeof win.history.pushState !== 'function') {
    return () => {};
  }

  const id = state.nextId++;
  /** @type {OverlayEntry} */
  const entry = {
    id,
    onClose,
    poppedByBack: false
  };
  state.knownIds.add(id);
  state.stack.push(entry);

  const prevState = win.history.state && typeof win.history.state === 'object' ? win.history.state : {};
  win.history.pushState({ ...prevState, __lushuOverlay: id }, '');

  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    const idx = state.stack.indexOf(entry);
    if (idx !== -1) state.stack.splice(idx, 1);
    if (entry.poppedByBack) return;

    const currentOverlayId = win.history?.state?.__lushuOverlay;
    if (currentOverlayId != null && state.knownIds.has(currentOverlayId) && typeof win.history.back === 'function') {
      state.suppressedPopCount += 1;
      win.history.back();
    }
  };
}

/**
 * Reset overlay history state for a window (primarily for isolated unit tests).
 * @param {any} [win]
 */
export function resetOverlayHistoryForTests(win = typeof window !== 'undefined' ? window : null) {
  if (!win || typeof win !== 'object') return;
  const state = stateByWindow.get(win);
  if (state) {
    state.stack.length = 0;
    state.knownIds.clear();
    state.suppressedPopCount = 0;
  }
}

/**
 * Dismiss an open overlay when the user presses the Browser Back button without
 * triggering `App`'s route-level `popstate` navigation, and clean up the pushed
 * history entry when the overlay closes via X, Esc, backdrop, or action completion.
 *
 * @param {boolean} open
 * @param {(() => void) | undefined} onClose
 * @param {{ disabled?: boolean }} [options]
 */
export function useOverlayBackClose(open, onClose, options = {}) {
  const disabled = Boolean(options?.disabled);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (typeof window === 'undefined' || !open || disabled) return undefined;
    return registerOverlayBackEntry(() => {
      onCloseRef.current?.();
    }, window);
  }, [open, disabled]);
}
