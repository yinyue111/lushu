import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent } from '../ui/dialog';
import { Button } from '../ui/button';
import { buildProposalDiff } from '../../lib/adjustIntents';
import { formatStayText } from '../../lib/routeMeta.js';
import { LoaderCircle, Sparkles } from 'lucide-react';

export default function PatchProposalDialog({ patchState, onApply, onDismiss }) {
  const proposal = patchState?.proposal;
  const diff = useMemo(() => buildProposalDiff(patchState?.beforeStops || [], proposal), [patchState?.beforeStops, proposal]);
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!patchState?.busy) {
      setElapsedSec(0);
      return undefined;
    }
    const base = Number(patchState.startedAt) || Date.now();
    const tick = () => setElapsedSec(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [patchState?.busy, patchState?.startedAt]);

  if (!patchState?.busy && !proposal) return null;
  const isAll = (patchState?.scopeType || proposal?.scope?.type) === 'all';

  return (
    <Dialog open onOpenChange={(open) => !open && onDismiss?.()}>
      <DialogContent
        title={patchState.busy ? (isAll ? 'AI 正在微调整本路线' : 'AI 正在重排这一天') : '看看调整前后的对比，要用这个安排吗？'}
        description={
          patchState.busy
            ? isAll
              ? '正在按你的要求统筹各天顺序与站点，大约 30–60 秒。'
              : '大约 20–45 秒，其他天不会变。'
            : proposal?.summary || '确认后才会写进路书，用了之后也能撤销。'
        }
      >
        {patchState.busy ? (
          <div className="flex items-center justify-between gap-3 py-3">
            <p className="flex items-center gap-2 text-copy text-muted">
              <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden="true" />
              <span>
                {patchState.message}
                {elapsedSec > 0 && <span className="num ml-2 text-meta text-ink-2">已用时 {elapsedSec} 秒</span>}
              </span>
            </p>
            <Button size="sm" variant="outline" onClick={onDismiss}>
              取消
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-2.5 flex flex-wrap gap-1.5 text-xs font-bold" data-testid="patch-diff-stats">
              <span className="rounded-full bg-sky-soft px-2.5 py-0.5 text-sky-ink">
                {diff.isAllScope ? `覆盖 ${diff.dayGroups.length} 天` : `仅改 ${diff.targetDay}`}
              </span>
              {diff.addedCount > 0 && <span className="rounded-full bg-success-soft px-2.5 py-0.5 text-success-ink">新增 {diff.addedCount} 站</span>}
              {diff.removedCount > 0 && <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-primary-strong">移除 {diff.removedCount} 站</span>}
              {diff.movedCount > 0 && <span className="rounded-full bg-lemon-soft px-2.5 py-0.5 text-lemon-ink">调整时间或天次 {diff.movedCount} 站</span>}
            </div>

            <div className="max-h-72 space-y-3 overflow-auto rounded-card bg-canvas p-3 text-sm">
              {diff.dayGroups.map((group) => (
                <div key={group.day}>
                  {diff.dayGroups.length > 1 && <p className="mb-1 text-xs font-extrabold text-ink-2">{group.day}</p>}
                  <ol className="space-y-1.5">
                    {group.stops.map((stop) => (
                      <li key={stop.id} className="flex flex-wrap items-center gap-2 rounded-tile bg-white px-2.5 py-1.5">
                        <span className="num w-11 shrink-0 text-xs font-semibold text-muted">{stop.time}</span>
                        <span className="min-w-0 flex-1 truncate font-bold text-ink">{stop.name}</span>
                        {stop.stay && <span className="text-xs text-muted">{formatStayText(stop.stay)}</span>}
                        {stop.diffTag && (
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                              stop.diffTone === 'added'
                                ? 'bg-success-soft text-success-ink'
                                : stop.diffTone === 'moved'
                                  ? 'bg-sky-soft text-sky-ink'
                                  : 'bg-lemon-soft text-lemon-ink'
                            }`}
                          >
                            {stop.diffTag}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </div>
              ))}

              {diff.removedStops.length > 0 && (
                <div className="border-t border-line pt-2">
                  <p className="mb-1 text-xs font-bold text-muted">本次移出的站点</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {diff.removedStops.map((stop) => (
                      <li key={stop.id} className="rounded-full bg-white px-2.5 py-0.5 text-xs text-muted line-through">
                        {stop.day ? `${stop.day} · ` : ''}
                        {stop.name}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {patchState.failed && patchState.message && (
              <p role="alert" className="mt-2 rounded-tile bg-lemon-soft px-3 py-2 text-meta font-bold text-ink">
                {patchState.message}
              </p>
            )}
            <p className="mt-2 text-meta text-muted">
              <Sparkles className="mr-1 inline size-3.5" aria-hidden="true" />
              用了之后也能点「撤销」退回。本次预览已消耗 1 次微调额度。
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
