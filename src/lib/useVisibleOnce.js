import { useEffect, useRef } from 'react';

/**
 * F19: call `onVisible` once when at least `threshold` of the element is on
 * screen. Without IntersectionObserver (very old browsers) it fires on mount,
 * matching the previous behaviour.
 * @param {() => void} onVisible
 * @param {{ threshold?: number }} [options]
 */
export function useVisibleOnce(onVisible, { threshold = 0.5 } = {}) {
  const ref = useRef(/** @type {HTMLElement | null} */ (null));
  const callbackRef = useRef(onVisible);
  callbackRef.current = onVisible;
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    if (typeof IntersectionObserver !== 'function') {
      callbackRef.current?.();
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= threshold)) {
          observer.disconnect();
          callbackRef.current?.();
        }
      },
      { threshold }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [threshold]);
  return ref;
}
