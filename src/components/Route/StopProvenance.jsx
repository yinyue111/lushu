import { BadgeCheck, NotebookPen, Link2, PenLine, Sparkles, CircleHelp } from 'lucide-react';
import { STOP_ORIGINS, coordinateVerificationLevel, normalizeStopOrigin } from '../../lib/trustSignals';
import { Chip } from '../ui/chip';

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
        <Chip size={size} tone="ok" className={className} title="名称命中运营已审核的 POI 目录">
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
    ['POI 目录', stop?.provenance?.reviewedPoi ? '命中运营已审核 POI。' : '没有命中已审核 POI。'],
    [
      '坐标',
      coordinate === 'verified'
        ? '来自已审核 POI 或地图服务精确定位。'
        : coordinate === 'approximate'
          ? '近似坐标，未经过已审核 POI 或地图服务精确定位。'
          : '没有可用坐标。'
    ],
    ['已核验事实', facts ? `${facts} 条有证据且在有效期内。` : '暂无有证据且在有效期内的事实。']
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
