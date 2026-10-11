import { useState } from 'react';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui/button';
import { inputClass } from '../ui/field';
import { parseAdjustIntent } from '../../lib/adjustIntents';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { MessageSquareText, Sparkles } from 'lucide-react';

/**
 * L3 shell: parse utterance → confirm → dispatch to L1/L2 handlers.
 * Never silently rewrites the whole book.
 */
export default function AdjustChatSheet({ routebook, onClose, handlers }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null);
  const days = routebook.days ?? [];
  const stopNames = (routebook.stops ?? []).map((s) => s.name).filter(Boolean);

  function submit(event) {
    event.preventDefault();
    const intent = parseAdjustIntent(text, { days, stopNames });
    if (!intent || intent.kind === 'unknown') {
      setPending({
        intent: intent || { label: '没听懂', kind: 'unknown' },
        confirmLabel: '知道了',
        run: null
      });
      return;
    }
    setPending({
      intent,
      confirmLabel: intent.level === 'L4' ? '去整本重生成' : intent.level === 'L2' ? '生成方案（耗局部次数）' : '应用',
      run: intent
    });
  }

  async function confirm() {
    const intent = pending?.run;
    setPending(null);
    if (!intent) return;
    const { kind, params } = intent;
    if (kind === 'strip_model') handlers.stripModelStops?.();
    else if (kind === 'delete_day' && params.day) handlers.deleteDay?.(params.day);
    else if (kind === 'merge_days') handlers.mergeDayInto?.(params.fromDay, params.toDay);
    else if (kind === 'mode_reorder') handlers.applyModeReorder?.(params.mode);
    else if (kind === 'set_transport_pref') handlers.applyTransportPreference?.(params.mode);
    else if (kind === 'replace_stop') handlers.openReplaceByName?.(params.stopName, params.query);
    else if (kind === 'patch_day') handlers.proposePatch?.({ day: params.day || days[0], instruction: text });
    else if (kind === 'full_regen') handlers.onCustomize?.();
    else if (kind === 'undo') handlers.undoEdit?.();
    onClose?.();
  }

  return (
    <>
      <Sheet title="跟我说怎么改" description="先确认再改。一键规则不耗次数；AI 局部重排耗局部次数；整本重生成耗完整次数。" onClose={onClose}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label className="text-meta font-semibold text-ink-2">你想怎么改这条路书？</label>
          <textarea
            className={`${inputClass} min-h-24`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="例如：去掉路书补充站 / 少走路 / 删第二天 / 换掉宽窄巷子 / 用 AI 重排 Day 1"
          />
          <div className="flex flex-wrap gap-2 text-meta text-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1">
              <MessageSquareText className="size-3.5" /> 手动与规则 · 不耗次数
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1">
              <Sparkles className="size-3.5" /> AI 局部 · 耗局部次数
            </span>
          </div>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            理解并预览
          </Button>
        </form>
      </Sheet>
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.intent?.level === 'L4' ? '整本重生成' : pending?.intent?.level === 'L2' ? '局部 AI 调整' : '确认调整'}
        description={
          pending?.intent?.kind === 'unknown'
            ? pending.intent.label
            : `${pending?.intent?.label || ''}。${
                pending?.intent?.level === 'L4'
                  ? '会打开创建页并消耗一次完整生成次数。'
                  : pending?.intent?.level === 'L2'
                    ? '只重排所选范围，其余天保留；需再确认方案。'
                    : '立即应用到本机路书，可撤销。'
              }`
        }
        confirmLabel={pending?.confirmLabel || '确定'}
        cancelLabel="取消"
        danger={pending?.intent?.level === 'L4'}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </>
  );
}
