import { ArrowDown, ArrowUp, CarTaxiFront, CircleCheckBig, Clock, Footprints, Info, MoreVertical, Pencil, Trash2, TriangleAlert } from 'lucide-react';
import { isNavigableCoordinate, routeLegLabel } from '../../lib/coordinates';
import { roadLegForStops, roadLegLabel } from '../../lib/routeRoads';
import { formatVerifiedDate, getStopTrustBadge } from '../../lib/trust';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu';
import { StopThumb } from '../visual/StopThumb';
import { sourceEvidencePrediction, stopKey } from './routebookModel';
import { StopTrustLine } from './StopProvenance';
import { Notice } from '../ui/notice';
import EnrichedFacts from './EnrichedFacts';
import { withoutCheckedPending } from '../../lib/enrichmentText';

export default function StopList({ stops, theme, selectedId, routeTrustTone, canEdit, draggedStopId, activeDay, handlers, routeLegs = [], enrichment = null }) {
  return (
    <ol className="m-0 list-none p-0" aria-label={`${activeDay} 站点`}>
      {stops.map((stop, index) => (
        <StopRow
          key={stop.id ?? index}
          stop={stop}
          index={index}
          next={stops[index + 1]}
          roadLeg={roadLegForStops(routeLegs, stop, stops[index + 1])}
          theme={theme}
          selected={stopKey(selectedId) === stopKey(stop.id)}
          routeTrustTone={routeTrustTone}
          canEdit={canEdit}
          canMoveUp={index > 0}
          canMoveDown={index < stops.length - 1}
          handlers={handlers}
          draggedStopId={draggedStopId}
          enrichment={enrichment}
        />
      ))}
      {canEdit && draggedStopId && (
        <li
          className="mt-3 rounded-card border-2 border-dashed border-sky/60 p-3 text-center text-sm font-semibold text-sky-ink"
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => handlers.moveStopToDayEnd(draggedStopId, activeDay)}
        >
          拖到这里，放到 {activeDay} 最后
        </li>
      )}
    </ol>
  );
}

/** @param {Record<string, any>} props */
function StopRow({ stop, index, next, roadLeg, theme, selected, routeTrustTone, canEdit, canMoveUp, canMoveDown, handlers, draggedStopId, enrichment, guideBacked = false }) {
  const trustBadge = getStopTrustBadge(stop, routeTrustTone);
  const enrichedClaims = enrichment ? enrichment.claimsFor(stop) : [];
  const checked = { price: enrichedClaims.some((c) => c.field === 'price'), hours: enrichedClaims.some((c) => c.field === 'hours') };
  // A checked price replaces the cost line; checked hours remove 「开放时间待确认」 from the notes.
  const costText = checked.price ? '' : stop.cost;
  const verifyText = withoutCheckedPending(stop.verify, checked);
  const riskText = withoutCheckedPending(stop.risk, checked);
  const pendingFold = Boolean(verifyText || riskText);
  const isGuideSupplement = guideBacked && stop?.provenance?.origin === 'model';
  const approximate = !isNavigableCoordinate(stop);
  const verifiedCount = Number(stop.poiTrust?.validArrivals ?? stop.poiTrust?.sampleCount ?? 0) || 0;
  const evidence = Array.isArray(stop.sourceEvidence) ? stop.sourceEvidence.slice(0, 3) : [];

  return (
    <>
      <li
        className={cn(
          'group grid cursor-pointer grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-card border border-line bg-white p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-(--ease-spring) hover:-translate-y-0.5 hover:shadow-pop motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-4 sm:p-3',
          selected && 'border-transparent shadow-[0_0_0_2px_var(--color-primary),var(--shadow-pop)]',
          draggedStopId && stopKey(draggedStopId) === stopKey(stop.id) && 'opacity-60'
        )}
        draggable={canEdit}
        onDragStart={() => handlers.setDraggedStopId(stop.id)}
        onDragEnd={() => handlers.setDraggedStopId(null)}
        onDragOver={(event) => canEdit && event.preventDefault()}
        onDrop={() => canEdit && handlers.moveStopBefore(draggedStopId, stop.id)}
        onClick={() => handlers.select(stop.id)}
      >
        <StopThumb stop={stop} number={index + 1} color={theme.ink} className="aspect-square self-start sm:aspect-[4/3.4]" />
        <div className="min-w-0 py-1 pr-1.5">
          {/* Name + area on the left, actions pinned top-right: long names wrap beside the buttons
              instead of pushing them onto a row of their own. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
            <div className="min-w-0">
              <h3 className="inline text-lead leading-snug font-extrabold [overflow-wrap:anywhere] sm:text-xl">
                <button
                  type="button"
                  className="text-left"
                  aria-pressed={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    handlers.select(stop.id);
                  }}
                >
                  {stop.name}
                </button>
              </h3>
              {stop.area && <span className="ml-2 inline-block text-meta text-muted sm:text-sm">{stop.area}</span>}
              {isGuideSupplement && (
                <Chip size="sm" tone="warn" className="ml-2 align-middle">
                  路书补充
                </Chip>
              )}
            </div>
            <div className="-mt-0.5 flex items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
              <Button variant="ghost" size="icon-sm" onClick={() => handlers.detail(stop)} aria-label={`查看${stop.name}详情`}>
                <Info />
              </Button>
              {canEdit && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`编辑${stop.name}`}>
                      <MoreVertical />
                    </Button>
                  </MenuTrigger>
                  <MenuContent>
                    <MenuItem onSelect={() => handlers.edit(stop)}>
                      <Pencil /> 编辑 / 替换
                    </MenuItem>
                    <MenuItem disabled={!canMoveUp} onSelect={() => handlers.moveStop(stop.id, -1)}>
                      <ArrowUp /> 上移
                    </MenuItem>
                    <MenuItem disabled={!canMoveDown} onSelect={() => handlers.moveStop(stop.id, 1)}>
                      <ArrowDown /> 下移
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem className="text-danger [&_svg]:text-danger" onSelect={() => handlers.removeStop(stop.id)}>
                      <Trash2 /> 删除这一站
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ink-2 sm:text-sm">
            {[stop.time, stop.stay && `停留 ${String(stop.stay).replace(/^停留\s*/, '')}`, costText].filter(Boolean).map((part, i) => (
              <span key={part} className="inline-flex items-center gap-2">
                {i > 0 && (
                  <span className="text-line-strong" aria-hidden="true">
                    ·
                  </span>
                )}
                {i === 0 && <Clock className="size-3.5 text-muted" aria-hidden="true" />}
                {part}
              </span>
            ))}
          </p>
          {enrichment && <EnrichedFacts claims={enrichedClaims} onReport={enrichment.report} />}
          <StopTrustLine stop={stop} trust={trustBadge} verifiedCount={verifiedCount} approximate={approximate} className="mt-1.5" />
          {pendingFold && (
            <details className="mt-2 rounded-card bg-canvas/80 px-2.5 py-1.5 text-sm text-ink-2 open:bg-canvas">
              <summary className="cursor-pointer list-none font-semibold text-muted [&::-webkit-details-marker]:hidden">
                待确认 / 核对信息
              </summary>
              {verifyText && <p className="mt-1.5 leading-relaxed">{verifyText}</p>}
              {riskText && (
                <Notice className="mt-2">
                  <span className="sr-only">出发前留意：</span>
                  {riskText}
                </Notice>
              )}
            </details>
          )}
          {isGuideSupplement && canEdit && (
            <p className="mt-1.5 text-meta text-muted">
              攻略里没写这一站，是路书补上的。
              <button
                type="button"
                className="ml-1 font-semibold text-danger underline underline-offset-2"
                onClick={(event) => {
                  event.stopPropagation();
                  handlers.removeStop(stop.id);
                }}
              >
                删除
              </button>
            </p>
          )}
          {selected && (trustBadge.verified || evidence.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {trustBadge.verified && (
                <Chip size="sm" tone="ok">
                  最近验证 {formatVerifiedDate(stop.poiTrust?.latestVerifiedAt)}
                </Chip>
              )}
              {evidence.map((item) => (
                <Chip key={item.id || item.label} size="sm" tone={item.type === 'approved-correction' ? 'ok' : 'sky'}>
                  {item.type === 'approved-correction' ? '已审核纠错' : '攻略来源'} {sourceEvidencePrediction(item)}
                </Chip>
              ))}
            </div>
          )}
        </div>
      </li>
      {next && <LegRow from={stop} to={next} roadLeg={roadLeg} />}
    </>
  );
}

/** @param {Record<string, any>} props */
function LegRow({ from, to, roadLeg }) {
  const precise = isNavigableCoordinate(from) && isNavigableCoordinate(to);
  const label = routeLegLabel(from, to).replace(/^直线估算：/, '');
  const walking = label.startsWith('步行');
  const Icon = !precise ? TriangleAlert : walking ? Footprints : CarTaxiFront;
  return (
    <li
      className={cn(
        "relative ml-[52px] flex items-center gap-2.5 py-2 text-meta font-semibold text-muted before:absolute before:top-0 before:bottom-0 before:-left-4 before:border-l-[3px] before:border-dotted before:border-line-strong before:content-[''] sm:ml-24 sm:py-2.5 sm:text-sm",
        !precise && 'text-warn-ink'
      )}
    >
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      {roadLeg ? roadLegLabel(roadLeg) : precise ? `${label}（直线估算）` : '距离待确认'}
    </li>
  );
}

/** Compact card used in the mobile map drawer carousel. */
export function MiniStopCard({ stop, index, theme, selected, routeTrustTone, onSelect }) {
  const trustBadge = getStopTrustBadge(stop, routeTrustTone);
  const approximate = !isNavigableCoordinate(stop);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      data-stop-id={stop.id}
      className={cn(
        'grid w-[270px] shrink-0 snap-start grid-cols-[76px_1fr] gap-2.5 rounded-[18px] border border-line bg-white p-2 text-left',
        selected && 'border-transparent shadow-[0_0_0_2px_var(--color-primary)]'
      )}
    >
      <StopThumb stop={stop} number={index + 1} color={theme.ink} compact className="min-h-[76px] rounded-xl" />
      <span className="min-w-0">
        <b className="block truncate text-base leading-snug font-extrabold">{stop.name}</b>
        <small className="block truncate text-meta text-muted">
          {[stop.time, stop.stay && `停留 ${String(stop.stay).replace(/^停留\s*/, '')}`].filter(Boolean).join(' · ')}
        </small>
        {approximate ? (
          <Chip size="sm" tone="warn" className="mt-1">
            位置待确认
          </Chip>
        ) : trustBadge.verified ? (
          <Chip size="sm" tone="ok" className="mt-1">
            <CircleCheckBig /> 已验证
          </Chip>
        ) : null}
      </span>
    </button>
  );
}
