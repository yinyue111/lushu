import { useEffect, useId, useRef, useState } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../ui/cn';

/**
 * Native day overflow menu (U5): no menu framework. Esc closes and returns focus to ⋯.
 * @param {{ dayNumber: number, onMerge: () => void, onDelete: () => void, className?: string }} props
 */
export function DayActionsMenu({ dayNumber, onMerge, onDelete, className }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (event) => {
      if (menuRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  function closeAnd(action) {
    setOpen(false);
    action?.();
    // Focus returns to trigger after the confirm dialog path; here for non-confirm actions.
    queuePromise(() => triggerRef.current?.focus());
  }

  return (
    <span className={cn('relative inline-flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        className="grid size-11 place-items-center rounded-full text-ink-2 hover:bg-canvas"
        aria-label={`第 ${dayNumber} 天的更多操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal className="size-5" aria-hidden="true" />
        <span className="sr-only">⋯</span>
      </button>
      {open && (
        <ul
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`第 ${dayNumber} 天`}
          className="absolute top-full right-0 z-20 mt-1 min-w-[10rem] rounded-tile border border-line bg-white py-1 shadow-pop"
        >
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="flex w-full px-3.5 py-2.5 text-left text-sm font-semibold text-ink hover:bg-canvas"
              onClick={() => closeAnd(onMerge)}
            >
              合并到另一天
            </button>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              className="flex w-full px-3.5 py-2.5 text-left text-sm font-semibold text-danger hover:bg-primary-soft"
              onClick={() => closeAnd(onDelete)}
            >
              删除这一天
            </button>
          </li>
        </ul>
      )}
    </span>
  );
}

function queuePromise(fn) {
  queuePromise.resolve().then(fn);
}
