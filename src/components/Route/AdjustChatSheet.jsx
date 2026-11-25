import { useMemo, useState } from 'react';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui/button';
import { inputClass } from '../ui/field';
import { parseAdjustIntent } from '../../lib/adjustIntents';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { TAP_TARGET } from '../ui/tap-target.js';
import { MessageSquareText, Sparkles } from 'lucide-react';

const QUICK_CHIPS = [
  { label: '少走路重排', text: '少走路', free: true },
  { label: '雨天备选', text: '下雨怎么排', free: true },
  { label: '中午加地道餐厅', text: '每天中午在顺路位置加一家口碑地道餐厅', free: false },
  { label: '按住宿顺路排', text: '我住在市中心地铁口附近，帮我按顺路优化每天出发与回程顺序', free: false },
  { label: '最后一天赶晚高铁', text: '最后一天下午四点半前结束行程，方便赶高铁', free: false }
];

/**
 * L3 shell: parse utterance -> local instant edit (confirm) OR AI single/multi-day patch (direct Diff preview).
 * Never silently rewrites the book without user confirmation.
 */
export default function AdjustChatSheet({ routebook, activeDay = undefined, onClose, handlers }) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(null);
  const days = useMemo(() => routebook.days ?? [], [routebook.days]);
  const stopNames = useMemo(() => (routebook.stops ?? []).map((s) => s.name).filter(Boolean), [routebook.stops]);
  const hasModelStop = useMemo(() => (routebook.stops ?? []).some((s) => s?.provenance?.origin === 'model'), [routebook.stops]);

  const liveIntent = useMemo(() => (text.trim() ? parseAdjustIntent(text, { days, stopNames, activeDay }) : null), [text, days, stopNames, activeDay]);

  function executeIntent(intent) {
    if (!intent) return;
    const { kind, params } = intent;
    if (kind === 'strip_model') handlers.stripModelStops?.();
    else if (kind === 'delete_day' && params.day) handlers.deleteDay?.(params.day);
    else if (kind === 'merge_days') handlers.mergeDayInto?.(params.fromDay, params.toDay);
    else if (kind === 'mode_reorder') handlers.applyModeReorder?.(params.mode);
    else if (kind === 'set_transport_pref') handlers.applyTransportPreference?.(params.mode);
    else if (kind === 'update_transit_window') handlers.updateTransitWindow?.(params);
    else if (kind === 'replace_stop') handlers.openReplaceByName?.(params.stopName, params.query);
    else if (kind === 'remove_stop') handlers.removeStopByName?.(params.stopName);
    else if (kind === 'move_stop_day') handlers.moveStopToDayByName?.(params.stopName, params.day);
    else if (kind === 'ai_patch' || kind === 'patch_day') {
      handlers.proposePatch?.({
        scopeType: params.scopeType || 'day',
        day: params.day || activeDay || days[0],
        instruction: params.instruction || text
      });
    } else if (kind === 'full_regen') handlers.onCustomize?.();
    else if (kind === 'undo') handlers.undoEdit?.();
  }

  function submit(event) {
    event.preventDefault();
    const intent = parseAdjustIntent(text, { days, stopNames, activeDay });
    if (!intent || intent.kind === 'unknown') {
      setPending({
        intent: intent || { label: '再多说一点想怎么改', kind: 'unknown' },
        confirmLabel: '知道了',
        run: null
      });
      return;
    }
    // AI adjustments already open PatchProposalDialog with full Before/After Diff before mutating anything:
    // skip a redundant pre-confirm modal so the user goes straight to the Diff preview.
    if (intent.level === 'L2') {
      executeIntent(intent);
      onClose?.();
      return;
    }
    setPending({
      intent,
      confirmLabel: intent.level === 'L4' ? '去重新生成' : '就这么改',
      run: intent
    });
  }

  async function confirm() {
    const intent = pending?.run;
    setPending(null);
    if (!intent) return;
    executeIntent(intent);
    onClose?.();
  }

  return (
    <>
      <Sheet title="用一句话改路线" description="直接说你想怎么改：删挪站点秒生效，复杂需求 AI 整本微调并先看前后对比。" onClose={onClose}>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <span className="text-meta font-semibold text-ink-2">点一下试试常见改法</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {QUICK_CHIPS.map((chip) => (
                <button
                  key={chip.label}
                  type="button"
                  onClick={() => setText(chip.text)}
                  className={`${TAP_TARGET} inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-3 py-1 text-xs font-bold text-ink hover:bg-line/50`}
                >
                  {!chip.free && <Sparkles className="size-3 text-primary-strong" aria-hidden="true" />}
                  {chip.label}
                </button>
              ))}
              {hasModelStop && (
                <button
                  type="button"
                  onClick={() => setText('去掉 AI 加的站')}
                  className={`${TAP_TARGET} inline-flex items-center gap-1 rounded-full border border-line bg-canvas px-3 py-1 text-xs font-bold text-ink hover:bg-line/50`}
                >
                  去掉 AI 加的站
                </button>
              )}
            </div>
          </div>

          <label htmlFor="adjust-chat-input" className="text-meta font-semibold text-ink-2">
            或者写下你的具体要求
          </label>
          <textarea
            id="adjust-chat-input"
            className={`${inputClass} min-h-24`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="比如：我住龙翔桥附近帮我排顺路 / 删掉某站 / 把法喜寺移到第二天 / 下午加家安静茶馆"
          />

          {liveIntent && liveIntent.kind !== 'unknown' && (
            <p role="status" data-testid="adjust-live-intent" className="rounded-tile bg-sky-soft/70 px-3 py-2 text-xs font-semibold text-sky-ink">
              {liveIntent.level === 'L2'
                ? `${liveIntent.label} · 先出前后对比预览，点确认才生效（耗 1 次微调额度）`
                : liveIntent.level === 'L4'
                  ? `${liveIntent.label} · 回到创建页从头生成`
                  : `${liveIntent.label} · 免费秒改，不满意可随时撤销`}
            </p>
          )}

          <div className="flex flex-wrap gap-2 text-meta text-muted">
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1">
              <MessageSquareText className="size-3.5" aria-hidden="true" /> 删站、跨天挪站、规则重排：不耗次数
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-canvas px-2.5 py-1">
              <Sparkles className="size-3.5" aria-hidden="true" /> 自然语言单天或整本微调：耗 1 次微调额度
            </span>
          </div>
          <Button type="submit" variant="primary" disabled={!text.trim()}>
            {liveIntent?.level === 'L2' ? '生成修改对比预览' : '看看会怎么改'}
          </Button>
        </form>
      </Sheet>
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.intent?.level === 'L4' ? '重新生成整条路书？' : '这样改可以吗？'}
        description={
          pending?.intent?.kind === 'unknown'
            ? pending.intent.label
            : `${pending?.intent?.label || ''}。${
                pending?.intent?.level === 'L4' ? '会回到创建页从头生成，消耗 1 次生成次数。' : '马上生效，不满意可以点「撤销」。'
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
