import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';
import { TAP_TARGET } from './tap-target.js';

/**
 * Lightweight status toast (aria-live polite; never moves focus). Auto-dismisses after `duration` ms;
 * the timer pauses while the pointer is over it or focus is inside it, and restarts on leave.
 * Optional `action` ({ label, onClick }) renders one text button, e.g. 「撤销」.
 */
export function Toast({ message, onDismiss, duration = 8000, className, action = null }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!message || !duration || paused) return undefined;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [message, duration, onDismiss, paused]);
  useEffect(() => {
    if (!message) setPaused(false);
  }, [message]);
  return (
    <div aria-live="polite" role="status" className={cn('pointer-events-none fixed inset-x-0 z-[1500] flex justify-center px-4', className)}>
      {message && (
        <div
          className="pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-card bg-ink px-4 py-3 text-sm text-white shadow-pop"
          onMouseEnter={() => setPaused(true)}
          onMouseLeave={() => setPaused(false)}
          onFocus={() => setPaused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(/** @type {Node|null} */ (event.relatedTarget))) setPaused(false);
          }}
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
          {action && (
            <button
              type="button"
              onClick={action.onClick}
              className={cn(TAP_TARGET, 'shrink-0 rounded-chip px-2 py-1 font-bold text-lemon underline underline-offset-2 hover:bg-white/10')}
            >
              {action.label}
            </button>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className={cn(TAP_TARGET, '-m-1 grid size-7 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/10')}
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
