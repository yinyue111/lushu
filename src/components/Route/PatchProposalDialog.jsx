import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';
import { LoaderCircle, Sparkles } from 'lucide-react';

export default function PatchProposalDialog({ patchState, onApply, onDismiss }) {
  if (!patchState?.busy && !patchState?.proposal) return null;
  const proposal = patchState.proposal;
  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss?.()}>
      <DialogContent
        title={patchState.busy ? 'AI 正在重排这一天' : '用这个新安排吗？'}
        description={patchState.busy ? '大约十几秒，其他天不会变。' : proposal?.summary || '看一下新顺序，再决定用不用。'}
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
            {patchState.failed && patchState.message && (
              <p role="alert" className="mt-2 rounded-tile bg-lemon-soft px-3 py-2 text-meta font-bold text-ink">
                {patchState.message}
              </p>
            )}
            <p className="mt-2 text-meta text-muted">
              <Sparkles className="mr-1 inline size-3.5" />
              用了之后也能撤销。已消耗 1 次 AI 重排次数。
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onDismiss}>
                不用，保持原样
              </Button>
              <Button variant="primary" onClick={() => onApply(proposal)}>
                用这个安排
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
