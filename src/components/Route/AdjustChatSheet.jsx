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
      confirmLabel: intent.level === 'L4' ? '去重新生成' : intent.level === 'L2' ? '让 AI 重排（耗 1 次）' : '就这么改',
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
      <Sheet title="用一句话改路线" description="说你想怎么改，我先给你看结果，你点确认才会改。" onClose={onClose}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <label htmlFor="adjust-chat-input" className="text-meta font-semibold text-ink-2">
            想怎么改？
          </label>
          <textarea
            id="adjust-chat-input"
            className={`${inputClass} min-h-24`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="比如：少走路 / 删掉第二天 / 换掉宽窄巷子 / 去掉 AI 加的站"
          />
          <div className="flex flex-wrap gap-2 text-meta text-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1">
              <MessageSquareText className="size-3.5" /> 重排、删站：不耗次数
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-1">
              <Sparkles className="size-3.5" /> 让 AI 重排一天：耗 1 次
            </span>
          </div>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            看看会怎么改
          </Button>
        </form>
      </Sheet>
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.intent?.level === 'L4' ? '重新生成整条路书？' : pending?.intent?.level === 'L2' ? '让 AI 重排这一天？' : '这样改可以吗？'}
        description={
          pending?.intent?.kind === 'unknown'
            ? pending.intent.label
            : `${pending?.intent?.label || ''}。${
                pending?.intent?.level === 'L4'
                  ? '会回到创建页从头生成，消耗 1 次生成次数。'
                  : pending?.intent?.level === 'L2'
                    ? '只改这一天，其他天不动。出结果后你再决定要不要用。'
                    : '马上生效，不满意可以点「撤销」。'
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
