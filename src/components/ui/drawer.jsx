import { Drawer as VaulDrawer } from 'vaul';
import { cn } from './cn';

export const Drawer = VaulDrawer.Root;

/**
 * Bottom sheet (phones) built on vaul; capped to 560px wide on larger screens.
 * @param {Record<string, any>} props
 */
export function DrawerContent({ className, children, title, description, ...props }) {
  return (
    <VaulDrawer.Portal>
      <VaulDrawer.Overlay className="fixed inset-0 z-[2000] bg-ink/40" />
      <VaulDrawer.Content
        className={cn(
          'fixed inset-x-0 bottom-0 z-[2001] mx-auto flex max-h-[88dvh] w-full max-w-[560px] flex-col rounded-t-[26px] bg-white pb-[env(safe-area-inset-bottom)] shadow-pop outline-none',
          className
        )}
        {...props}
      >
        <div className="mx-auto mt-2 mb-2 h-1.5 w-11 shrink-0 rounded-full bg-line-strong" aria-hidden="true" />
        <VaulDrawer.Title className={title ? 'px-5 pb-1 text-lg font-extrabold' : 'sr-only'}>{title || '详情'}</VaulDrawer.Title>
        <VaulDrawer.Description className={description ? 'px-5 pb-2 text-sm text-muted' : 'sr-only'}>{description || title || '详情'}</VaulDrawer.Description>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">{children}</div>
      </VaulDrawer.Content>
    </VaulDrawer.Portal>
  );
}
