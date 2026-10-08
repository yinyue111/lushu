import { useEffect } from 'react';
import { X } from 'lucide-react';
import { cn } from './cn';

/** Lightweight status toast (aria-live). Auto-dismisses after `duration` ms. */
export function Toast({ message, onDismiss, duration = 8000, className }) {
  useEffect(() => {
    if (!message || !duration) return undefined;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  }, [message, duration, onDismiss]);
  return (
    <div aria-live="polite" role="status" className={cn('pointer-events-none fixed inset-x-0 z-[1500] flex justify-center px-4', className)}>
      {message && (
        <div className="pointer-events-auto flex max-w-[560px] items-start gap-3 rounded-card bg-ink px-4 py-3 text-sm text-white shadow-pop">
          <span className="min-w-0 [overflow-wrap:anywhere]">{message}</span>
          <button
            type="button"
            onClick={onDismiss}
            className="-m-1 grid size-7 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/10"
            aria-label="关闭提示"
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
