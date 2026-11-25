import { useRef } from 'react';
import { useOverlayBackClose } from '../../lib/overlayHistory';
import { Dialog, DialogContent } from './dialog';
import { Button } from './button';

/**
 * In-app confirm dialog for destructive / important actions.
 * Uses role="alertdialog"; initial focus lands on 「取消」 (U5).
 * @param {{ open: boolean, title: string, description?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean, onConfirm: () => void, onCancel: () => void, fallbackFocus?: any }} props
 */
export function ConfirmDialog({
  open,
  title,
  description = '',
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
  fallbackFocus
}) {
  const cancelRef = useRef(null);
  useOverlayBackClose(Boolean(open), onCancel);
  if (!open) return null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onCancel?.();
      }}
    >
      <DialogContent
        title={title}
        description={description || undefined}
        hideClose
        fallbackFocus={fallbackFocus}
        role="alertdialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancelRef.current?.focus();
        }}
      >
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <Button ref={cancelRef} type="button" variant="outline" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button type="button" variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
