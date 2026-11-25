import { Drawer as VaulDrawer } from 'vaul';
import { X } from 'lucide-react';
import { useRestoreFocus } from '../../lib/useRestoreFocus';
import { cn } from './cn';

export const Drawer = VaulDrawer.Root;

/** @param {{ fallback?: any }} props */
function DrawerFocusGuard({ fallback }) {
  useRestoreFocus(fallback);
  return null;
}

/**
 * Bottom sheet (phones) built on vaul; capped to 560px wide on larger screens.
 * @param {Record<string, any>} props
 */
export function DrawerContent({ className, children, title, description, hideClose = false, fallbackFocus, onCloseAutoFocus, ...props }) {
  return (
    <VaulDrawer.Portal>
      <VaulDrawer.Overlay className="fixed inset-0 z-[2000] bg-ink/40" />
      <VaulDrawer.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-[2001] mx-auto flex max-h-[88dvh] w-full max-w-[560px] flex-col rounded-t-[26px] bg-white pb-[env(safe-area-inset-bottom)] shadow-pop outline-none',
          className
        )}
        onCloseAutoFocus={onCloseAutoFocus ?? ((event) => event.preventDefault())}
        {...props}
      >
        <DrawerFocusGuard fallback={fallbackFocus} />
        <div className="mx-auto mt-2 mb-1 h-1.5 w-11 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
        <div className="flex items-start justify-between gap-3 px-5 pb-2">
          <div className="min-w-0 flex-1">
            <VaulDrawer.Title className={title ? 'pt-1 text-lg font-extrabold text-ink' : 'sr-only'}>{title || '详情'}</VaulDrawer.Title>
            <VaulDrawer.Description className={description ? 'mt-0.5 text-sm text-muted' : 'sr-only'}>{description || title || '详情'}</VaulDrawer.Description>
          </div>
          {!hideClose && (
            <VaulDrawer.Close
              data-vaul-no-drag=""
              className="grid size-11 shrink-0 place-items-center rounded-full bg-canvas text-ink hover:bg-line"
              aria-label="关闭"
            >
              <X size={18} />
            </VaulDrawer.Close>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
      </VaulDrawer.Content>
    </VaulDrawer.Portal>
  );
}
