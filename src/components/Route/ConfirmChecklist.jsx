import { useCallback, useState } from 'react';
import { Check, ExternalLink } from 'lucide-react';
import { groupConfirmItems, readAcks, writeAcks } from '../../lib/confirmChecklist';
import { trackEvent } from '../../lib/betaTelemetry.js';
import { cn } from '../ui/cn';

/** 「我知道了」的勾选，按路书存在本机。只是提醒自己，不是核实。 */
export function useConfirmAcks(routeId) {
  const [acks, setAcks] = useState(() => readAcks(routeId || 'draft'));
  const toggle = useCallback(
    (key) => {
      setAcks((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        writeAcks(routeId || 'draft', next);
        return next;
      });
    },
    [routeId]
  );
  return { acks, toggle };
}

export function ConfirmItemRow({ item, acked, onToggle, stopName = '' }) {
  return (
    <li className={cn('flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2', acked && 'text-muted')}>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block text-sm font-semibold text-ink-2">
          {stopName && <span className="text-ink">{stopName} · </span>}
          {item.label}
        </span>
        {item.detail && <span className="block text-meta leading-snug text-muted">{item.detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <a
          href={item.action.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-9 items-center gap-1 rounded-full border border-line-strong bg-white px-3 text-meta font-semibold text-sky-ink hover:bg-sky-soft"
          onClick={(event) => {
            event.stopPropagation();
            trackEvent('confirm_search');
          }}
        >
          {item.action.label}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        <button
          type="button"
          aria-pressed={acked}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(item.key);
          }}
          // 刻意不用绿色、不用「已核实」：这是用户自己的勾，不代表信息被核实过。
          className={cn(
            'inline-flex min-h-9 items-center gap-1 rounded-full border border-dashed px-3 text-meta font-semibold',
            acked ? 'border-ink-2/40 bg-canvas text-ink-2' : 'border-line-strong bg-white text-muted'
          )}
        >
          <Check className={cn('size-3.5', !acked && 'opacity-30')} aria-hidden="true" />
          我知道了
        </button>
      </span>
    </li>
  );
}

/** 单站卡片里折叠的清单。 */
export function StopConfirmFold({ items, acks, onToggle }) {
  if (!items.length) return null;
  const open = items.filter((item) => !acks.has(item.key)).length;
  return (
    <details
      className="mt-2 rounded-card bg-canvas/80 px-2.5 py-1.5 text-sm text-ink-2 open:bg-canvas"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => event.currentTarget.open && trackEvent('confirm_open')}
    >
      <summary className="cursor-pointer list-none font-semibold text-muted [&::-webkit-details-marker]:hidden">
        出发前要确认的事 · {open ? `${open} 件` : '都知道了'}
      </summary>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {items.map((item) => (
          <ConfirmItemRow key={item.key} item={item} acked={acks.has(item.key)} onToggle={onToggle} />
        ))}
      </ul>
    </details>
  );
}

/** 当天汇总：按「要预约 / 门票 / 开放时间 / 位置」分组。 */
export function DayConfirmSummary({ entries, acks, onToggle }) {
  // 只有一站有待确认时，卡片里的清单就够了，不再重复一份当天汇总。
  if (!entries.length || new Set(entries.map((entry) => entry.stopName)).size < 2) return null;
  const open = entries.filter(({ item }) => !acks.has(item.key)).length;
  return (
    <details
      className="mb-3 rounded-card border border-line bg-white px-3 py-2 shadow-card"
      onToggle={(event) => event.currentTarget.open && trackEvent('confirm_open')}
    >
      <summary className="cursor-pointer list-none text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
        今天出发前要确认 {entries.length} 件事
        <span className="ml-2 font-normal text-muted">{open ? `还有 ${open} 件没看` : '都标了「我知道了」'}</span>
      </summary>
      <p className="mt-1 text-meta text-muted">点「去查」打开高德或官方页面；「我知道了」只是提醒自己，不代表信息已核实。</p>
      {groupConfirmItems(entries).map((group) => (
        <section key={group.kind} className="mt-2">
          <h4 className="text-meta font-bold text-ink-2">{group.label}</h4>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {group.items.map(({ item, stopName }) => (
              <ConfirmItemRow key={item.key} item={item} stopName={stopName} acked={acks.has(item.key)} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}
