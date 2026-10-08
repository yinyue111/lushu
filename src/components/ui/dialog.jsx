import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { cn } from './cn';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

/** @param {Record<string, any>} props */
export function DialogContent({ className, children, title, description, hideClose = false, ...props }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-[2000] bg-ink/40 backdrop-blur-[2px]" />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-[2001] max-h-[calc(100dvh-32px)] w-[min(560px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-panel bg-white p-6 shadow-pop focus:outline-none',
          className
        )}
        {...props}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-xl font-extrabold text-ink">{title}</DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="mt-1 text-sm text-muted">{description}</DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
          </div>
          {!hideClose && (
            <DialogPrimitive.Close className="grid size-9 shrink-0 place-items-center rounded-full bg-canvas text-ink hover:bg-line" aria-label="关闭">
              <X size={18} />
            </DialogPrimitive.Close>
          )}
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
