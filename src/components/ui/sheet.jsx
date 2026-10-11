import { Dialog, DialogContent } from './dialog';
import { Drawer, DrawerContent } from './drawer';
import { useMediaQuery } from './useMediaQuery';

/**
 * Responsive overlay: a centred dialog from md up, a vaul bottom sheet on phones.
 * Always mounted "open"; the caller unmounts it to close.
 * @param {Record<string, any>} props
 */
export function Sheet({ title, description, onClose, children, className, wide = false, hideClose = false, preventDismiss = false }) {
  const desktop = useMediaQuery('(min-width: 768px)');
  const onOpenChange = (open) => {
    if (!open) {
      if (preventDismiss) return;
      onClose?.();
    }
  };
  if (desktop) {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          title={title}
          description={description}
          hideClose={hideClose || preventDismiss}
          className={[wide ? 'w-[min(720px,calc(100vw-32px))]' : '', className].filter(Boolean).join(' ')}
          onPointerDownOutside={preventDismiss ? (e) => e.preventDefault() : undefined}
          onEscapeKeyDown={preventDismiss ? (e) => e.preventDefault() : undefined}
        >
          {children}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Drawer open onOpenChange={onOpenChange} dismissible={!preventDismiss}>
      <DrawerContent title={title} description={description} className={className}>
        {children}
      </DrawerContent>
    </Drawer>
  );
}
