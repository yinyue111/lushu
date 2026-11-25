import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  captureRestoreTarget,
  ensureTriggerTracker,
  recordFocusTrigger,
  resetRestoreFocusTracker,
  resolveFallbackElement,
  restoreFocusTarget
} from '../../src/lib/useRestoreFocus.js';
import { ensureOverlayHistory, registerOverlayBackEntry, resetOverlayHistoryForTests } from '../../src/lib/overlayHistory.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Lightweight DOM fixture supporting tree parent/child links, attribute queries,
 * focus rules (connected, non-disabled, natively focusable or explicit tabindex),
 * and capture/bubble event listeners.
 */
function createMockDom() {
  /** @type {Map<string, any[]>} */
  const docListeners = new Map();

  const doc = {
    activeElement: null,
    documentElement: null,
    body: null,
    addEventListener(type, fn, capture = false) {
      const list = docListeners.get(type) ?? [];
      list.push({ fn, capture: Boolean(capture) });
      docListeners.set(type, list);
    },
    dispatchEvent(type, target) {
      const event = { type, target };
      for (const item of docListeners.get(type) ?? []) {
        if (item.capture) item.fn(event);
      }
      for (const item of docListeners.get(type) ?? []) {
        if (!item.capture) item.fn(event);
      }
    },
    getElementById(id) {
      return findFirst(doc.documentElement, (el) => el.id === id);
    },
    querySelector(selector) {
      return queryAll(doc.documentElement, selector)[0] ?? null;
    },
    querySelectorAll(selector) {
      return queryAll(doc.documentElement, selector);
    },
    createElement(tagName, attrs = {}) {
      const attrsMap = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]));
      /** @type {Map<string, Array<{ fn: Function, once: boolean }>>} */
      const elListeners = new Map();
      const el = {
        tagName: tagName.toUpperCase(),
        id: attrs.id ?? '',
        disabled: Boolean(attrs.disabled),
        hidden: Boolean(attrs.hidden),
        parentElement: null,
        children: [],
        lastFocusOptions: null,
        get isConnected() {
          let cur = el;
          while (cur) {
            if (cur === doc.documentElement) return true;
            cur = cur.parentElement;
          }
          return false;
        },
        getAttribute(name) {
          if (name === 'id') return el.id || null;
          return attrsMap.has(name) ? attrsMap.get(name) : null;
        },
        setAttribute(name, value) {
          if (name === 'id') el.id = String(value);
          attrsMap.set(name, String(value));
        },
        hasAttribute(name) {
          if (name === 'id') return Boolean(el.id);
          return attrsMap.has(name);
        },
        removeAttribute(name) {
          if (name === 'id') el.id = '';
          attrsMap.delete(name);
        },
        appendChild(child) {
          if (child.parentElement) child.remove();
          child.parentElement = el;
          el.children.push(child);
          return child;
        },
        remove() {
          const parent = el.parentElement;
          if (!parent) return;
          const idx = parent.children.indexOf(el);
          if (idx !== -1) parent.children.splice(idx, 1);
          el.parentElement = null;
          if (doc.activeElement === el || (doc.activeElement && !doc.activeElement.isConnected)) {
            doc.activeElement = doc.body;
          }
        },
        closest(selector) {
          let cur = el;
          while (cur) {
            if (matchesSelectorList(cur, selector)) return cur;
            cur = cur.parentElement;
          }
          return null;
        },
        querySelector(selector) {
          for (const child of el.children) {
            const hit = queryAll(child, selector)[0];
            if (hit) return hit;
          }
          return null;
        },
        addEventListener(type, fn, opts = {}) {
          const list = elListeners.get(type) ?? [];
          list.push({ fn, once: Boolean(opts?.once) });
          elListeners.set(type, list);
        },
        blur() {
          if (doc.activeElement === el) {
            doc.activeElement = doc.body;
            const list = [...(elListeners.get('blur') ?? [])];
            elListeners.set(
              'blur',
              list.filter((item) => !item.once)
            );
            for (const item of list) item.fn({ type: 'blur', target: el });
          }
        },
        focus(options) {
          if (!el.isConnected || el.disabled || el.hidden) return;
          const nativelyFocusable =
            ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(el.tagName) || (el.tagName === 'A' && el.hasAttribute('href'));
          if (!nativelyFocusable && !el.hasAttribute('tabindex')) return;
          el.lastFocusOptions = options ?? null;
          doc.activeElement = el;
          doc.dispatchEvent('focusin', el);
        }
      };
      return el;
    }
  };

  doc.documentElement = doc.createElement('html');
  doc.body = doc.createElement('body', { tabindex: '-1' });
  doc.documentElement.appendChild(doc.body);
  doc.activeElement = doc.body;
  ensureTriggerTracker(doc);
  resetRestoreFocusTracker(doc);
  return doc;
}

function findFirst(root, predicate) {
  if (!root) return null;
  if (predicate(root)) return root;
  for (const child of root.children ?? []) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function queryAll(root, selectorList, out = []) {
  if (!root) return out;
  if (matchesSelectorList(root, selectorList)) out.push(root);
  for (const child of root.children ?? []) queryAll(child, selectorList, out);
  return out;
}

function matchesSelectorList(el, selectorList) {
  return selectorList
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .some((sel) => matchesSimpleSelector(el, sel));
}

function matchesSimpleSelector(el, sel) {
  if (!el || !sel) return false;
  if (sel === '#main') return el.id === 'main';
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel === 'button:not([disabled])') return el.tagName === 'BUTTON' && !el.disabled;
  if (sel === 'a[href]') return el.tagName === 'A' && el.hasAttribute('href');
  if (sel === 'input:not([disabled]):not([type="hidden"])') {
    return el.tagName === 'INPUT' && !el.disabled && el.getAttribute('type') !== 'hidden';
  }
  if (sel === 'select:not([disabled])') return el.tagName === 'SELECT' && !el.disabled;
  if (sel === 'textarea:not([disabled])') return el.tagName === 'TEXTAREA' && !el.disabled;
  if (sel === 'summary') return el.tagName === 'SUMMARY';
  if (sel === '[tabindex]:not([tabindex="-1"])') return el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1';
  if (sel === '[tabindex]') return el.hasAttribute('tabindex');
  if (sel === 'main') return el.tagName === 'MAIN';
  if (sel === 'h1') return el.tagName === 'H1';
  if (sel === '[hidden]') return Boolean(el.hidden) || el.hasAttribute('hidden');
  if (sel === '[inert]') return el.hasAttribute('inert');
  if (sel === '[aria-controls]') return el.hasAttribute('aria-controls');
  if (sel === '[aria-haspopup="menu"]') return el.getAttribute('aria-haspopup') === 'menu';
  if (sel === '[aria-haspopup="menu"][aria-expanded="true"]') {
    return el.getAttribute('aria-haspopup') === 'menu' && el.getAttribute('aria-expanded') === 'true';
  }
  if (sel === '[aria-haspopup="menu"][data-state="open"]') {
    return el.getAttribute('aria-haspopup') === 'menu' && el.getAttribute('data-state') === 'open';
  }
  const roleMatch = /^\[role="([^"]+)"\]$/.exec(sel);
  if (roleMatch) return el.getAttribute('role') === roleMatch[1];
  return el.tagName === sel.toUpperCase();
}

function createMockWindow() {
  /** @type {Array<{ state: any, url: string }>} */
  const entries = [{ state: null, url: '/route/hz-1' }];
  let index = 0;
  /** @type {Array<{ fn: Function, capture: boolean }>} */
  const listeners = [];

  const dispatchPopState = () => {
    let stoppedImmediate = false;
    const event = {
      state: entries[index]?.state ?? null,
      stopImmediatePropagation() {
        stoppedImmediate = true;
      }
    };
    for (const item of [...listeners]) {
      if (!item.capture) continue;
      item.fn(event);
      if (stoppedImmediate) return;
    }
    for (const item of [...listeners]) {
      if (item.capture) continue;
      item.fn(event);
      if (stoppedImmediate) return;
    }
  };

  const win = {
    history: {
      get state() {
        return entries[index]?.state ?? null;
      },
      get length() {
        return entries.length;
      },
      pushState(state, _unused, url) {
        entries.splice(index + 1);
        entries.push({ state, url: url || entries[index]?.url || '/' });
        index = entries.length - 1;
      },
      back() {
        if (index <= 0) return;
        index -= 1;
        dispatchPopState();
      }
    },
    get pathname() {
      return entries[index]?.url ?? '/';
    },
    addEventListener(type, fn, capture = false) {
      if (type !== 'popstate') return;
      listeners.push({ fn, capture: Boolean(capture) });
    },
    pressBrowserBack() {
      win.history.back();
    }
  };

  ensureOverlayHistory(win);
  resetOverlayHistoryForTests(win);
  return win;
}

test('useRestoreFocus restores focus to connected trigger with preventScroll', () => {
  const doc = createMockDom();
  const main = doc.body.appendChild(doc.createElement('main', { id: 'main', tabindex: '-1' }));
  const trigger = main.appendChild(doc.createElement('button'));
  trigger.focus();

  const captured = captureRestoreTarget(doc);
  assert.equal(captured, trigger);

  // Simulate overlay closing and dropping activeElement to body.
  doc.activeElement = doc.body;
  const restored = restoreFocusTarget({ target: captured, doc });
  assert.equal(restored, trigger);
  assert.equal(doc.activeElement, trigger);
  assert.deepEqual(trigger.lastFocusOptions, { preventScroll: true });
});

test('useRestoreFocus falls back to #main or custom fallback when trigger unmounted (never stays on body)', () => {
  const doc = createMockDom();
  const main = doc.body.appendChild(doc.createElement('main', { id: 'main', tabindex: '-1' }));
  const heading = main.appendChild(doc.createElement('h1', { id: 'route-heading' }));
  const trigger = main.appendChild(doc.createElement('button'));
  trigger.focus();

  const captured = captureRestoreTarget(doc);
  assert.equal(captured, trigger);

  // Trigger unmounts (e.g. deleted day's ⋯ button or login button replaced after sign-in).
  trigger.remove();
  assert.equal(trigger.isConnected, false);
  assert.equal(doc.activeElement, doc.body);

  // Default fallback -> #main.
  const restoredMain = restoreFocusTarget({ target: captured, doc });
  assert.equal(restoredMain, main);
  assert.equal(doc.activeElement, main);
  assert.notEqual(doc.activeElement, doc.body);

  // Custom selector fallback -> <h1> without natural tabindex gets temporary tabindex="-1" and cleans up on blur.
  doc.activeElement = doc.body;
  assert.equal(heading.hasAttribute('tabindex'), false);
  const restoredHeading = restoreFocusTarget({ target: captured, fallback: '#route-heading', doc });
  assert.equal(restoredHeading, heading);
  assert.equal(doc.activeElement, heading);
  assert.equal(heading.getAttribute('tabindex'), '-1');
  heading.blur();
  assert.equal(heading.hasAttribute('tabindex'), false);

  // React ref fallback.
  const altButton = main.appendChild(doc.createElement('button'));
  doc.activeElement = doc.body;
  const restoredRef = restoreFocusTarget({ target: captured, fallback: { current: altButton }, doc });
  assert.equal(restoredRef, altButton);
  assert.equal(doc.activeElement, altButton);

  // Getter fallback.
  doc.activeElement = doc.body;
  assert.equal(
    resolveFallbackElement(() => altButton, doc),
    altButton
  );
});

test('useRestoreFocus falls back when remembered trigger became disabled or hidden', () => {
  const doc = createMockDom();
  const main = doc.body.appendChild(doc.createElement('main', { id: 'main', tabindex: '-1' }));
  const trigger = main.appendChild(doc.createElement('button'));
  trigger.focus();
  const captured = captureRestoreTarget(doc);

  trigger.disabled = true;
  doc.activeElement = doc.body;
  restoreFocusTarget({ target: captured, doc });
  assert.equal(doc.activeElement, main);

  trigger.disabled = false;
  trigger.hidden = true;
  doc.activeElement = doc.body;
  restoreFocusTarget({ target: captured, doc });
  assert.equal(doc.activeElement, main);
});

test('useRestoreFocus resolves real trigger button when opened from a menuitem or lazy-loaded after click', () => {
  const doc = createMockDom();
  const main = doc.body.appendChild(doc.createElement('main', { id: 'main', tabindex: '-1' }));
  const menuTrigger = main.appendChild(
    doc.createElement('button', {
      'aria-haspopup': 'menu',
      'aria-expanded': 'true',
      'aria-controls': 'day-menu-1'
    })
  );
  const menu = main.appendChild(doc.createElement('ul', { id: 'day-menu-1', role: 'menu' }));
  const menuItem = menu.appendChild(doc.createElement('button', { role: 'menuitem' }));

  // User activates menuTrigger first, then clicks menuItem.
  doc.dispatchEvent('pointerdown', menuTrigger);
  menuTrigger.focus();
  doc.dispatchEvent('pointerdown', menuItem);
  menuItem.focus();

  // Case 1: Dialog captures while menuItem still has focus -> resolves menuTrigger instead of menuItem.
  const capturedWhileMenuOpen = captureRestoreTarget(doc);
  assert.equal(capturedWhileMenuOpen, menuTrigger);

  // Case 2: Menu already unmounted (leaving activeElement === body) before React.lazy Sheet mounted.
  menu.remove();
  menuTrigger.setAttribute('aria-expanded', 'false');
  assert.equal(doc.activeElement, doc.body);
  const capturedAfterLazyLoad = captureRestoreTarget(doc);
  assert.equal(capturedAfterLazyLoad, menuTrigger);

  const restored = restoreFocusTarget({ target: capturedAfterLazyLoad, doc });
  assert.equal(restored, menuTrigger);
  assert.equal(doc.activeElement, menuTrigger);
});

test('useRestoreFocus preserves focus in newly opened dialog and keeps stacked confirm inside outer dialog', () => {
  const doc = createMockDom();
  const main = doc.body.appendChild(doc.createElement('main', { id: 'main', tabindex: '-1' }));
  const pageTrigger = main.appendChild(doc.createElement('button'));
  pageTrigger.focus();
  const captured = captureRestoreTarget(doc);

  // Another dialog opened immediately as the previous overlay closed.
  const nextDialog = doc.body.appendChild(doc.createElement('div', { role: 'dialog', tabindex: '-1' }));
  const dialogInput = nextDialog.appendChild(doc.createElement('input'));
  dialogInput.focus();

  restoreFocusTarget({ target: captured, doc });
  assert.equal(doc.activeElement, dialogInput);

  // Stacked ConfirmDialog inside outer dialog: inner trigger became disabled, focus stays inside outer dialog.
  const innerTrigger = nextDialog.appendChild(doc.createElement('button'));
  recordFocusTrigger(innerTrigger, doc);
  innerTrigger.disabled = true;
  doc.activeElement = doc.body;
  const restoredInDialog = restoreFocusTarget({ target: innerTrigger, doc });
  assert.equal(restoredInDialog, dialogInput);
});

test('overlayHistory: Browser Back dismisses top overlay without firing App popstate, and X/Esc cleans history silently', () => {
  const win = createMockWindow();
  let appPopCount = 0;
  win.addEventListener('popstate', () => {
    appPopCount += 1;
  });

  // 1. Open Sheet, dismiss via Browser Back -> Sheet closes, App popstate NOT called.
  let sheetClosed = 0;
  const cleanupSheet1 = registerOverlayBackEntry(() => {
    sheetClosed += 1;
  }, win);
  assert.equal(win.history.length, 2);
  win.pressBrowserBack();
  cleanupSheet1();
  assert.equal(sheetClosed, 1);
  assert.equal(appPopCount, 0);
  assert.equal(win.pathname, '/route/hz-1');

  // 2. Open Sheet, dismiss via X/Esc (cleanup without Back) -> history popped silently, App popstate NOT called.
  let sheet2Closed = 0;
  const cleanupSheet2 = registerOverlayBackEntry(() => {
    sheet2Closed += 1;
  }, win);
  assert.equal(win.history.length, 2);
  cleanupSheet2();
  assert.equal(sheet2Closed, 0);
  assert.equal(appPopCount, 0);
  assert.equal(win.history.state, null);

  // 3. Nested overlays (Sheet + ConfirmDialog): Back closes ConfirmDialog first, then Sheet.
  const closedOrder = [];
  const cleanupOuter = registerOverlayBackEntry(() => closedOrder.push('sheet'), win);
  const cleanupInner = registerOverlayBackEntry(() => closedOrder.push('confirm'), win);
  win.pressBrowserBack();
  cleanupInner();
  assert.deepEqual(closedOrder, ['confirm']);
  assert.equal(appPopCount, 0);

  win.pressBrowserBack();
  cleanupOuter();
  assert.deepEqual(closedOrder, ['confirm', 'sheet']);
  assert.equal(appPopCount, 0);

  // 4. Action inside overlay navigates via pushState before unmount -> does NOT undo navigation.
  const cleanupNavOverlay = registerOverlayBackEntry(() => {}, win);
  win.history.pushState({}, '', '/builder');
  cleanupNavOverlay();
  assert.equal(win.pathname, '/builder');
  assert.equal(appPopCount, 0);
});

test('DayActionsMenu, SharePreview, StopEditor, DrawerContent, and DialogContent wiring contracts', () => {
  const dayMenu = readFileSync(`${ROOT}/src/components/Route/DayActionsMenu.jsx`, 'utf8');
  assert.match(dayMenu, /setOpen\(false\);\s*triggerRef\.current\?\.focus\(\);\s*action\?\.\(\);/);
  assert.doesNotMatch(dayMenu, /setTimeout\(\(\)\s*=>\s*triggerRef\.current\?\.focus\(\)/);

  const sharePreview = readFileSync(`${ROOT}/src/components/Route/SharePreview.jsx`, 'utf8');
  assert.doesNotMatch(sharePreview, /window\.confirm\(/);
  assert.match(sharePreview, /<ConfirmDialog/);

  const stopEditor = readFileSync(`${ROOT}/src/components/Route/StopEditor.jsx`, 'utf8');
  assert.match(stopEditor, /<details[\s\S]*?<summary[^>]*>高级（经纬度）<\/summary>[\s\S]*?label="纬度"[\s\S]*?label="经度"[\s\S]*?<\/details>/);

  const drawer = readFileSync(`${ROOT}/src/components/ui/drawer.jsx`, 'utf8');
  assert.match(drawer, /useRestoreFocus/);
  assert.match(drawer, /aria-label="关闭"/);

  const dialog = readFileSync(`${ROOT}/src/components/ui/dialog.jsx`, 'utf8');
  assert.match(dialog, /useRestoreFocus/);
  assert.match(dialog, /aria-label="关闭"/);
});
