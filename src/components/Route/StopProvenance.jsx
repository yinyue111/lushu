import { BadgeCheck, NotebookPen, Link2, PenLine, Sparkles, CircleHelp } from 'lucide-react';
import { STOP_ORIGINS, coordinateVerificationLevel, normalizeStopOrigin } from '../../lib/trustSignals';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';

const ORIGIN_UI = {
  'user-guide': { icon: NotebookPen, tone: 'ok' },
  'imported-source': { icon: Link2, tone: 'sky' },
  'user-added': { icon: PenLine, tone: 'neutral' },
  model: { icon: Sparkles, tone: 'warn' },
  unknown: { icon: CircleHelp, tone: 'neutral' }
};

/**
 * Where this stop came from (code-derived, see src/lib/trustSignals.js). The
 * chip text carries the meaning; colour is only a secondary cue.
 * @param {{ stop: any, size?: 'sm' | 'md', className?: string }} props
 */
export function StopProvenanceChips({ stop, size = 'sm', className }) {
  const origin = normalizeStopOrigin(stop?.provenance?.origin);
  const { icon: Icon, tone } = ORIGIN_UI[origin];
  const reviewed = stop?.provenance?.reviewedPoi === true;
  return (
    <>
      <Chip size={size} tone={/** @type {any} */ (tone)} className={className} title={STOP_ORIGINS[origin].detail}>
        <Icon aria-hidden="true" /> {STOP_ORIGINS[origin].label}
      </Chip>
      {reviewed && (
        <Chip size={size} tone="ok" className={className} title="名称和平台已审核的地点对得上">
          <BadgeCheck aria-hidden="true" /> 已审核 POI
        </Chip>
      )}
    </>
  );
}

/**
 * Full provenance explanation for the POI detail sheet.
 * @param {{ stop: any }} props
 */
export function StopProvenanceDetail({ stop }) {
  const origin = normalizeStopOrigin(stop?.provenance?.origin);
  const coordinate = coordinateVerificationLevel(stop);
  const facts = Math.max(0, Number(stop?.provenance?.verifiedFactCount) || 0);
  const matched = String(stop?.provenance?.matchedText ?? '');
  const rows = [
    ['来源', `${STOP_ORIGINS[origin].label}${matched && origin !== 'model' ? `（匹配到“${matched}”）` : ''}。${STOP_ORIGINS[origin].detail}`],
    ['POI 目录', stop?.provenance?.reviewedPoi ? '和平台已审核的地点对得上。' : '平台已审核的地点里没有它。'],
    [
      '坐标',
      coordinate === 'verified' ? '位置来自平台审核或地图精确定位。' : coordinate === 'approximate' ? '位置是估的，还没用地图精确定位。' : '没有可用坐标。'
    ],
    ['已核验事实', facts ? `${facts} 条有证据且在有效期内。` : '还没有带证据、仍在有效期内的信息。']
  ];
  return (
    <section aria-labelledby="stop-provenance-title" className="mt-4 rounded-tile bg-canvas p-4">
      <h3 id="stop-provenance-title" className="text-copy font-extrabold">
        这一站的依据
      </h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <StopProvenanceChips stop={stop} />
      </div>
      <dl className="mt-3 grid gap-1.5 text-sm">
        {rows.map(([term, detail]) => (
          <div key={term} className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
            <dt className="font-semibold text-muted">{term}</dt>
            <dd className="m-0 text-ink-2">{detail}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const DOT = { ok: 'bg-success', warn: 'bg-warn', info: 'bg-info', neutral: 'bg-line-strong' };

/**
 * One calm line that carries a stop's trust + provenance (polish pass): text holds the
 * meaning, a small dot is a secondary cue. Details stay in the 「这一站的依据」 sheet.
 * @param {{ stop: any, trust: { tone: string, verified?: boolean, label?: string }, verifiedCount?: number, approximate?: boolean, className?: string }} props
 */
export function StopTrustLine({ stop, trust, verifiedCount = 0, approximate = false, className }) {
  const origin = normalizeStopOrigin(stop?.provenance?.origin);
  const items = [
    trust.tone === 'verified'
      ? { tone: 'ok', text: verifiedCount ? `${verifiedCount} 人到达验证` : trust.label }
      : trust.tone === 'trial'
        ? { tone: 'warn', text: '未实地确认' }
        : { tone: 'info', text: '还没人打卡' },
    approximate && { tone: 'warn', text: '位置待确认' },
    {
      tone: origin === 'model' ? 'warn' : origin === 'user-guide' || origin === 'imported-source' ? 'ok' : 'neutral',
      text: STOP_ORIGINS[origin].label,
      title: STOP_ORIGINS[origin].detail
    },
    stop?.provenance?.reviewedPoi === true && { tone: 'ok', text: '已审核 POI', title: '名称和平台已审核的地点对得上' }
  ].filter(Boolean);
  return (
    <p className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-meta font-semibold text-muted', className)}>
      {items.map((item) => (
        <span key={item.text} className="inline-flex items-center gap-1.5" title={item.title}>
          <i className={cn('size-1.5 shrink-0 rounded-full', DOT[item.tone])} aria-hidden="true" />
          {item.text}
        </span>
      ))}
    </p>
  );
}
