import { useRef } from 'react';
import { Dialog, DialogContent } from './dialog';
import { Button } from './button';

/**
 * In-app confirm (replaces window.confirm for destructive / important actions).
 * Uses role="alertdialog"; initial focus lands on 「取消」 (U5).
 * @param {{ open: boolean, title: string, description?: string, confirmLabel?: string, cancelLabel?: string, danger?: boolean, onConfirm: () => void, onCancel: () => void }} props
 */
export function ConfirmDialog({ open, title, description = '', confirmLabel = '确定', cancelLabel = '取消', danger = false, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
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
