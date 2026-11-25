import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(', ');

const NATIVELY_FOCUSABLE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'A']);

/** @type {WeakMap<object, { lastOutsideMenu: HTMLElement | null, lastOutsideOverlay: HTMLElement | null }>} */
const trackerByDoc = new WeakMap();

/**
 * @param {any} el
 * @returns {boolean}
 */
function isMenuElement(el) {
  if (!el || typeof el !== 'object') return false;
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : el.role;
  if (role === 'menu' || role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return true;
  if (typeof el.closest === 'function' && el.closest('[role="menu"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]')) {
    return true;
  }
  return false;
}

/**
 * @param {any} el
 * @returns {boolean}
 */
function isDialogElement(el) {
  if (!el || typeof el !== 'object') return false;
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : el.role;
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (typeof el.closest === 'function' && el.closest('[role="dialog"], [role="alertdialog"]')) return true;
  return false;
}

/**
 * @param {any} el
 * @returns {boolean}
 */
function isNativelyFocusable(el) {
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  if (tag === 'A') return Boolean(typeof el.hasAttribute === 'function' ? el.hasAttribute('href') : el.href);
  return NATIVELY_FOCUSABLE_TAGS.has(tag);
}

/**
 * @param {any} el
 * @returns {boolean}
 */
function isElementHidden(el) {
  if (!el || typeof el !== 'object') return true;
  if (el.hidden === true) return true;
  if (typeof el.closest === 'function' && el.closest('[hidden], [inert]')) return true;
  if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
    try {
      const style = window.getComputedStyle(el);
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
    } catch {
      // Non-native test doubles are allowed through.
    }
  }
  return false;
}

/**
 * @param {any} el
 * @param {any} [doc]
 * @returns {el is HTMLElement}
 */
export function isUsableFocusTarget(el, doc = typeof document !== 'undefined' ? document : null) {
  if (!el || typeof el !== 'object' || typeof el.focus !== 'function') return false;
  if (doc && (el === doc.body || el === doc.documentElement)) return false;
  if (el.isConnected === false) return false;
  if ('disabled' in el && Boolean(/** @type {any} */ (el).disabled)) return false;
  if (isElementHidden(el)) return false;
  return true;
}

/**
 * @param {any} target
 * @param {any} doc
 * @returns {HTMLElement | null}
 */
function findFocusableCandidate(target, doc) {
  if (!target || typeof target !== 'object') return null;
  if (typeof target.closest === 'function') {
    const matched = target.closest(FOCUSABLE_SELECTOR);
    if (matched && isUsableFocusTarget(matched, doc)) return /** @type {HTMLElement} */ (matched);
  }
  if (isUsableFocusTarget(target, doc)) return /** @type {HTMLElement} */ (target);
  return null;
}

/**
 * @param {any} target
 * @param {any} [doc]
 */
export function recordFocusTrigger(target, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return;
  const state = ensureTriggerTracker(doc);
  if (!state) return;
  const candidate = findFocusableCandidate(target, doc);
  if (!candidate || isMenuElement(candidate)) return;
  state.lastOutsideMenu = candidate;
  if (!isDialogElement(candidate)) {
    state.lastOutsideOverlay = candidate;
  }
}

/**
 * @param {any} [doc]
 * @returns {{ lastOutsideMenu: HTMLElement | null, lastOutsideOverlay: HTMLElement | null } | null}
 */
export function ensureTriggerTracker(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc !== 'object') return null;
  const existing = trackerByDoc.get(doc);
  if (existing) return existing;
  const state = { lastOutsideMenu: null, lastOutsideOverlay: null };
  trackerByDoc.set(doc, state);
  if (typeof doc.addEventListener === 'function') {
    const onActivate = (/** @type {any} */ event) => {
      recordFocusTrigger(event?.target, doc);
    };
    doc.addEventListener('pointerdown', onActivate, true);
    doc.addEventListener('keydown', onActivate, true);
    doc.addEventListener('focusin', onActivate, true);
  }
  return state;
}

/**
 * Reset tracked triggers for a document (primarily for isolated unit tests).
 * @param {any} [doc]
 */
export function resetRestoreFocusTracker(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc || typeof doc !== 'object') return;
  const state = trackerByDoc.get(doc);
  if (state) {
    state.lastOutsideMenu = null;
    state.lastOutsideOverlay = null;
  }
}

/**
 * @param {any} menuItemEl
 * @param {any} doc
 * @returns {HTMLElement | null}
 */
function resolveMenuTrigger(menuItemEl, doc) {
  if (!doc) return null;
  const menu = typeof menuItemEl?.closest === 'function' ? menuItemEl.closest('[role="menu"]') : null;
  const menuId = menu?.id;
  if (menuId && typeof doc.querySelectorAll === 'function') {
    const triggers = doc.querySelectorAll('[aria-haspopup="menu"], [aria-controls]');
    for (const trigger of triggers) {
      const controls = typeof trigger.getAttribute === 'function' ? trigger.getAttribute('aria-controls') : trigger.ariaControls;
      if (controls === menuId && isUsableFocusTarget(trigger, doc)) {
        return /** @type {HTMLElement} */ (trigger);
      }
    }
  }
  if (typeof doc.querySelector === 'function') {
    const expanded = doc.querySelector('[aria-haspopup="menu"][aria-expanded="true"], [aria-haspopup="menu"][data-state="open"]');
    if (expanded && isUsableFocusTarget(expanded, doc)) {
      return /** @type {HTMLElement} */ (expanded);
    }
  }
  return null;
}

/**
 * Snapshot the element that should receive focus when an overlay closes.
 * Resolves menu triggers when opened from a `[role="menuitem"]` and falls back to
 * the most recently activated trigger if `activeElement` already dropped to `body`.
 *
 * @param {any} [doc]
 * @returns {HTMLElement | null}
 */
export function captureRestoreTarget(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;
  const tracker = ensureTriggerTracker(doc);
  const active = /** @type {HTMLElement | null} */ (doc.activeElement ?? null);

  if (active && isMenuElement(active)) {
    const menuTrigger = resolveMenuTrigger(active, doc);
    if (menuTrigger) return menuTrigger;
    if (isUsableFocusTarget(tracker?.lastOutsideMenu, doc)) return tracker.lastOutsideMenu;
    if (isUsableFocusTarget(tracker?.lastOutsideOverlay, doc)) return tracker.lastOutsideOverlay;
    return null;
  }

  if (isUsableFocusTarget(active, doc)) {
    return active;
  }

  if (isUsableFocusTarget(tracker?.lastOutsideMenu, doc)) {
    return tracker.lastOutsideMenu;
  }
  if (isUsableFocusTarget(tracker?.lastOutsideOverlay, doc)) {
    return tracker.lastOutsideOverlay;
  }
  return null;
}

/**
 * @param {any} fallback
 * @param {any} [doc]
 * @returns {HTMLElement | null}
 */
export function resolveFallbackElement(fallback, doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return null;

  if (typeof fallback === 'function') {
    const resolved = fallback();
    if (resolved) return resolved;
  } else if (fallback && typeof fallback === 'object' && 'current' in fallback) {
    if (fallback.current) return fallback.current;
  } else if (fallback && typeof fallback === 'object' && typeof fallback.focus === 'function') {
    return /** @type {HTMLElement} */ (fallback);
  } else if (typeof fallback === 'string' && fallback.trim()) {
    const selector = fallback.trim();
    if (selector === '#main' && typeof doc.getElementById === 'function') {
      const byId = doc.getElementById('main');
      if (byId) return byId;
    }
    if (typeof doc.querySelector === 'function') {
      const matched = doc.querySelector(selector);
      if (matched) return /** @type {HTMLElement} */ (matched);
    }
  }

  if (fallback === undefined && typeof doc.querySelectorAll === 'function') {
    const openDialogs = doc.querySelectorAll('[role="dialog"], [role="alertdialog"]');
    for (let i = openDialogs.length - 1; i >= 0; i -= 1) {
      const dialog = openDialogs[i];
      if (isUsableFocusTarget(dialog, doc)) {
        const inner = typeof dialog.querySelector === 'function' ? dialog.querySelector(FOCUSABLE_SELECTOR) : null;
        if (isUsableFocusTarget(inner, doc)) return /** @type {HTMLElement} */ (inner);
        return /** @type {HTMLElement} */ (dialog);
      }
    }
  }

  if (typeof doc.getElementById === 'function') {
    const mainById = doc.getElementById('main');
    if (mainById) return mainById;
  }
  if (typeof doc.querySelector === 'function') {
    const landmark = doc.querySelector('#main, main, h1, [tabindex]');
    if (landmark) return /** @type {HTMLElement} */ (landmark);
  }
  return null;
}

/**
 * @param {any} el
 */
function ensureProgrammaticFocusable(el) {
  if (!el || isNativelyFocusable(el)) return;
  const hasTabIndexAttr = typeof el.hasAttribute === 'function' ? el.hasAttribute('tabindex') : typeof el.tabIndex === 'number';
  if (hasTabIndexAttr) return;
  if (typeof el.setAttribute === 'function') {
    el.setAttribute('tabindex', '-1');
    el.setAttribute('data-restore-focus-temp', 'true');
  } else {
    el.tabIndex = -1;
  }
  if (typeof el.addEventListener === 'function') {
    el.addEventListener(
      'blur',
      () => {
        if (typeof el.hasAttribute === 'function' && el.hasAttribute('data-restore-focus-temp')) {
          el.removeAttribute?.('tabindex');
          el.removeAttribute?.('data-restore-focus-temp');
        }
      },
      { once: true }
    );
  }
}

/**
 * @param {any} el
 * @param {any} doc
 * @returns {boolean}
 */
function focusElementSafely(el, doc) {
  if (!isUsableFocusTarget(el, doc)) return false;
  ensureProgrammaticFocusable(el);
  try {
    el.focus({ preventScroll: true });
  } catch {
    try {
      el.focus();
    } catch {
      return false;
    }
  }
  if (doc && 'activeElement' in doc && doc.activeElement != null) {
    return doc.activeElement === el;
  }
  return true;
}

/**
 * Restore focus to `target` if still connected and focusable; otherwise fall back to `fallback` / `#main`.
 * Never leaves focus stranded on `document.body` when a valid fallback landmark exists.
 *
 * @param {{ target?: HTMLElement | null, fallback?: any, doc?: any }} params
 * @returns {HTMLElement | null}
 */
export function restoreFocusTarget({ target = null, fallback = undefined, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!doc) return null;

  const currentActive = /** @type {HTMLElement | null} */ (doc.activeElement ?? null);
  if (currentActive && currentActive !== doc.body && currentActive !== doc.documentElement && currentActive.isConnected !== false && currentActive !== target) {
    const activeOverlay = typeof currentActive.closest === 'function' ? currentActive.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') : null;
    const targetOverlay = target && typeof target.closest === 'function' ? target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') : null;
    if (activeOverlay && activeOverlay.isConnected !== false && activeOverlay !== targetOverlay) {
      return currentActive;
    }
  }

  if (focusElementSafely(target, doc)) {
    return target;
  }

  const fallbackEl = resolveFallbackElement(fallback, doc);
  if (focusElementSafely(fallbackEl, doc)) {
    return fallbackEl;
  }

  if (fallback !== undefined) {
    const defaultEl = resolveFallbackElement(undefined, doc);
    if (defaultEl && defaultEl !== fallbackEl && focusElementSafely(defaultEl, doc)) {
      return defaultEl;
    }
  }

  return null;
}

if (typeof document !== 'undefined') {
  ensureTriggerTracker(document);
}

/**
 * Hook that remembers the active trigger when an overlay mounts and restores focus
 * on close/unmount (with fallback when the trigger was unmounted).
 *
 * @param {import('react').RefObject<HTMLElement | null> | HTMLElement | (() => HTMLElement | null) | string} [fallback]
 * @param {{ enabled?: boolean }} [options]
 */
export function useRestoreFocus(fallback, options = {}) {
  const enabled = options?.enabled !== false;
  const targetRef = useRef(/** @type {HTMLElement | null} */ (null));
  const capturedRef = useRef(false);
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;

  if (enabled && !capturedRef.current && typeof document !== 'undefined') {
    targetRef.current = captureRestoreTarget(document);
    capturedRef.current = true;
  }
  if (!enabled && capturedRef.current) {
    capturedRef.current = false;
    targetRef.current = null;
  }

  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return undefined;
    if (!capturedRef.current) {
      targetRef.current = captureRestoreTarget(document);
      capturedRef.current = true;
    }
    const remembered = targetRef.current;
    return () => {
      capturedRef.current = false;
      const doc = typeof document !== 'undefined' ? document : null;
      if (!doc) return;
      const restoreIfNeeded = () => {
        const active = doc.activeElement;
        const lostFocus = !active || active === doc.body || active === doc.documentElement || active.isConnected === false;
        if (lostFocus || active === remembered) {
          restoreFocusTarget({ target: remembered, fallback: fallbackRef.current, doc });
        }
      };
      queueMicrotask(restoreIfNeeded);
      setTimeout(restoreIfNeeded, 0);
    };
  }, [enabled]);
}

/**
 * Mount-scoped helper component to place inside portal content (`DialogPrimitive.Content` / `VaulDrawer.Content`)
 * so `useRestoreFocus` activates strictly while the overlay content is open and mounted.
 *
 * @param {{ fallback?: any }} props
 */
export function RestoreFocusScope({ fallback }) {
  useRestoreFocus(fallback);
  return null;
}
