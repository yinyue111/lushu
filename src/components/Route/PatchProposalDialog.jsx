import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';
import { LoaderCircle, Sparkles } from 'lucide-react';

export default function PatchProposalDialog({ patchState, onApply, onDismiss }) {
  if (!patchState?.busy && !patchState?.proposal) return null;
  const proposal = patchState.proposal;
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss?.()}>
      <DialogContent
        title={patchState.busy ? '正在局部重排' : '确认局部调整'}
        description={patchState.busy ? '模型只改选定范围，其余天不动。' : proposal?.summary || '请核对方案后再写入路书。'}
        hideClose={patchState.busy}
      >
        {patchState.busy ? (
          <p className="flex items-center gap-2 text-copy text-muted">
            <LoaderCircle className="size-5 animate-spin" /> {patchState.message}
          </p>
        ) : (
          <>
            <ol className="max-h-64 space-y-1.5 overflow-auto rounded-card bg-canvas p-3 text-sm">
              {(proposal?.stops || [])
                .filter((s) => (s.day || 'Day 1') === (proposal.scope?.day || s.day))
                .map((stop) => (
                  <li key={stop.id} className="flex gap-2">
                    <span className="num w-10 shrink-0 text-muted">{stop.time}</span>
                    <span className="font-semibold">{stop.name}</span>
                  </li>
                ))}
            </ol>
            <p className="mt-2 text-meta text-muted">
              <Sparkles className="mr-1 inline size-3.5" />
              写入后可撤销；云端会记一次局部调整配额。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onDismiss}>
                不用了
              </Button>
              <Button variant="primary" onClick={() => onApply(proposal)}>
                应用这个方案
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
