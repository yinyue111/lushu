import { useEffect, useRef } from 'react';
import { trackEvent } from '../../lib/betaTelemetry.js';
import {
  ArrowDown,
  ArrowUp,
  Bus,
  CarTaxiFront,
  CircleCheckBig,
  Clock,
  Footprints,
  GripVertical,
  Info,
  MoreHorizontal,
  Navigation,
  Pencil,
  Replace,
  Trash2,
  TriangleAlert
} from 'lucide-react';
import { isNavigableCoordinate, routeLegLabel } from '../../lib/coordinates';
import { legScheduleConflict } from '../../lib/stopTiming';
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
import { costDisplay } from '../../lib/cost';
import { confirmItemsForStop } from '../../lib/confirmChecklist';
import { StopConfirmFold } from './ConfirmChecklist';
import { formatStayText } from '../../lib/routeMeta.js';

/** @param {Record<string, any>} props */
export default function StopList({
  stops,
  theme,
  selectedId,
  routeTrustTone,
  canEdit,
  draggedStopId,
  activeDay,
  handlers,
  routeLegs = [],
  transport = '',
  enrichment = null,
  confirm = null
}) {
  const listRef = useRef(/** @type {HTMLOListElement | null} */ (null));
  const activeTouchDragRef = useRef(/** @type {any} */ (null));
  const finishDragRef = useRef(/** @type {((cancelled?: boolean) => void) | null} */ (null));

  useEffect(() => () => finishDragRef.current?.(true), []);

  function commitTouchDrop(fromIndex, stopId, clientY, startY) {
    if (!canEdit || stops.length < 2) return;
    if (!Number.isFinite(clientY) || Math.abs(clientY - startY) < 8) return;
    const cards = listRef.current ? Array.from(listRef.current.querySelectorAll('[data-stop-card]')) : [];
    if (cards.length !== stops.length) return;
    const rects = cards.map((el) => el.getBoundingClientRect());
    if (clientY < rects[0].top) {
      if (fromIndex > 0) handlers.moveStopBefore(stopId, stops[0].id);
      return;
    }
    if (clientY > rects[rects.length - 1].bottom) {
      if (fromIndex < stops.length - 1) handlers.moveStopToDayEnd(stopId, activeDay);
      return;
    }
    for (let i = 0; i < rects.length; i += 1) {
      if (clientY >= rects[i].top && clientY <= rects[i].bottom) {
        if (i < fromIndex) {
          handlers.moveStopBefore(stopId, stops[i].id);
        } else if (i > fromIndex) {
          if (i + 1 < stops.length) handlers.moveStopBefore(stopId, stops[i + 1].id);
          else handlers.moveStopToDayEnd(stopId, activeDay);
        }
        return;
      }
      if (i + 1 < rects.length && clientY > rects[i].bottom && clientY < rects[i + 1].top) {
        if (fromIndex > i + 1 || fromIndex < i) {
          handlers.moveStopBefore(stopId, stops[i + 1].id);
        }
        return;
      }
    }
  }

  function startTouchDrag(event, stop, index, mode) {
    if (!canEdit || stops.length < 2) return;
    if (mode === 'touch' && activeTouchDragRef.current) return;
    event.stopPropagation();
    if (mode === 'pointer' && event.cancelable) event.preventDefault();
    const startY = mode === 'pointer' ? event.clientY : (event.touches?.[0]?.clientY ?? 0);
    const session = { stopId: stop.id, fromIndex: index, startY, lastY: startY, mode };
    activeTouchDragRef.current = session;
    handlers.setDraggedStopId?.(stop.id);

    const onMove = (moveEvent) => {
      if (mode === 'touch') {
        if (moveEvent.cancelable) moveEvent.preventDefault();
        session.lastY = moveEvent.touches?.[0]?.clientY ?? session.lastY;
      } else {
        session.lastY = moveEvent.clientY;
      }
    };

    const cleanup = (cancelled = false, endEvent = null) => {
      if (mode === 'pointer') {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onCancel);
      } else {
        window.removeEventListener('touchmove', onMove);
        window.removeEventListener('touchend', onEnd);
        window.removeEventListener('touchcancel', onCancel);
      }
      activeTouchDragRef.current = null;
      finishDragRef.current = null;
      handlers.setDraggedStopId?.(null);
      if (!cancelled) {
        const endY = mode === 'pointer' ? (endEvent?.clientY ?? session.lastY) : (endEvent?.changedTouches?.[0]?.clientY ?? session.lastY);
        commitTouchDrop(session.fromIndex, session.stopId, endY, session.startY);
      }
    };

    const onEnd = (endEvent) => cleanup(false, endEvent);
    const onCancel = () => cleanup(true, null);
    finishDragRef.current = (cancelled = true) => cleanup(cancelled, null);

    if (mode === 'pointer') {
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onCancel);
    } else {
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('touchend', onEnd);
      window.addEventListener('touchcancel', onCancel);
    }
  }

  return (
    <ol ref={listRef} className="m-0 list-none p-0" aria-label={`${activeDay} 站点`}>
      {stops.map((stop, index) => (
        <StopRow
          key={stop.id ?? index}
          stop={stop}
          index={index}
          next={stops[index + 1]}
          roadLeg={roadLegForStops(routeLegs, stop, stops[index + 1])}
          transport={transport}
          theme={theme}
          selected={stopKey(selectedId) === stopKey(stop.id)}
          routeTrustTone={routeTrustTone}
          canEdit={canEdit}
          canDrag={canEdit && stops.length > 1}
          onStartTouchDrag={startTouchDrag}
          canMoveUp={index > 0}
          canMoveDown={index < stops.length - 1}
          handlers={handlers}
          draggedStopId={draggedStopId}
          enrichment={enrichment}
          confirm={confirm}
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
function StopRow({
  stop,
  index,
  next,
  roadLeg,
  transport = '',
  theme,
  selected,
  routeTrustTone,
  canEdit,
  canDrag = false,
  onStartTouchDrag = undefined,
  canMoveUp,
  canMoveDown,
  handlers,
  draggedStopId,
  enrichment,
  confirm = null,
  guideBacked = false
}) {
  const trustBadge = getStopTrustBadge(stop, routeTrustTone);
  const enrichedClaims = enrichment ? enrichment.claimsFor(stop) : [];
  const checked = { price: enrichedClaims.some((c) => c.field === 'price'), hours: enrichedClaims.some((c) => c.field === 'hours') };
  // A checked price replaces the cost line; checked hours remove 「开放时间待确认」 from the notes.
  const price = costDisplay(stop);
  // U8: never show 「价格待确认」 on the station row — it lives in 「出发前确认」.
  const costText = checked.price || price.pending ? '' : price.text;
  const verifyText = withoutCheckedPending(stop.verify, checked);
  const riskText = withoutCheckedPending(stop.risk, checked);
  const confirmItems = confirm ? confirmItemsForStop(stop, { city: confirm.city, checked }) : [];
  const pendingFold = !confirm && Boolean(verifyText || riskText);
  const isGuideSupplement = guideBacked && stop?.provenance?.origin === 'model';
  const approximate = !isNavigableCoordinate(stop);
  const verifiedCount = Number(stop.poiTrust?.validArrivals ?? stop.poiTrust?.sampleCount ?? 0) || 0;
  const evidence = Array.isArray(stop.sourceEvidence) ? stop.sourceEvidence.slice(0, 3) : [];
  let deletingStop = false;
  const dragHandle = canDrag ? (
    <button
      type="button"
      draggable={false}
      aria-label={`拖动调整${stop.name}顺序`}
      data-testid={`drag-handle-${stop.id}`}
      className="hidden size-11 touch-none place-items-center text-white select-none [@media(pointer:coarse)]:grid"
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => onStartTouchDrag?.(event, stop, index, 'pointer')}
      onTouchStart={(event) => onStartTouchDrag?.(event, stop, index, 'touch')}
    >
      <span className="grid size-7 place-items-center rounded-full border border-white/35 bg-black/65 backdrop-blur-sm">
        <GripVertical className="size-3.5" aria-hidden="true" />
      </span>
    </button>
  ) : null;

  return (
    <>
      <li
        data-stop-card={stop.id}
        className={cn(
          'group grid scroll-mt-16 cursor-pointer grid-cols-[88px_minmax(0,1fr)] gap-3 rounded-card border border-line bg-white p-2.5 shadow-card transition-shadow duration-200 hover:shadow-pop motion-reduce:transition-none sm:grid-cols-[148px_minmax(0,1fr)] sm:gap-4 sm:p-3',
          selected && 'border-transparent shadow-[0_0_0_2px_var(--color-primary),var(--shadow-pop)]',
          draggedStopId && stopKey(draggedStopId) === stopKey(stop.id) && 'opacity-60'
        )}
        draggable={canEdit}
        onDragStart={(event) => {
          if (event.target instanceof Element && event.target.closest('[data-testid^="drag-handle-"]')) {
            event.preventDefault();
            return;
          }
          handlers.setDraggedStopId(stop.id);
        }}
        onDragEnd={() => handlers.setDraggedStopId(null)}
        onDragOver={(event) => canEdit && event.preventDefault()}
        onDrop={() => canEdit && handlers.moveStopBefore(draggedStopId, stop.id)}
        onClick={() => (handlers.openCard ? handlers.openCard(stop) : handlers.select(stop.id))}
      >
        <StopThumb stop={stop} number={index + 1} color={theme.ink} dragHandle={dragHandle} className="aspect-square self-start sm:aspect-[4/3.4]" />
        <div className="min-w-0 py-1 pr-1.5">
          {/* Name + area on the left, actions pinned top-right: long names wrap beside the buttons
              instead of pushing them onto a row of their own. */}
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2">
            <div className="min-w-0">
              {/* V-U26: very long names clamp to 2 lines (full name in title + 详情). */}
              <h3
                className={cn(
                  'text-lead leading-snug font-extrabold [overflow-wrap:anywhere] sm:text-xl',
                  String(stop.name ?? '').length > 18 ? 'block' : 'inline'
                )}
                title={String(stop.name ?? '').length > 18 ? stop.name : undefined}
              >
                <button
                  type="button"
                  className="inline-flex min-h-11 items-center text-left sm:min-h-0"
                  aria-pressed={selected}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (handlers.openCard) handlers.openCard(stop);
                    else handlers.select(stop.id);
                  }}
                >
                  <span className={String(stop.name ?? '').length > 18 ? 'line-clamp-2' : undefined}>{stop.name}</span>
                </button>
              </h3>
              {stop.area && <span className="ml-2 inline-block text-meta text-muted sm:text-sm">{stop.area}</span>}
              {isGuideSupplement && (
                <Chip size="sm" tone="warn" className="ml-2 align-middle">
                  AI 加的
                </Chip>
              )}
            </div>
            <div className="-mt-0.5 flex items-center gap-0.5" onClick={(event) => event.stopPropagation()}>
              {!canEdit && handlers.navigateStop && (
                <Button variant="ghost" size="icon-sm" onClick={() => handlers.navigateStop(stop)} aria-label={`导航去${stop.name}`}>
                  <Navigation />
                </Button>
              )}
              <Button variant="ghost" size="icon-sm" onClick={() => handlers.detail(stop)} aria-label={`查看${stop.name}详情`}>
                <Info />
              </Button>
              {canEdit && (
                <Menu>
                  <MenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`编辑${stop.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </MenuTrigger>
                  <MenuContent
                    onCloseAutoFocus={(event) => {
                      if (deletingStop) event.preventDefault();
                    }}
                  >
                    {handlers.navigateStop && (
                      <MenuItem onSelect={() => handlers.navigateStop(stop)}>
                        <Navigation /> 打开地图导航
                      </MenuItem>
                    )}
                    <MenuItem onSelect={() => handlers.edit(stop)}>
                      <Pencil /> 编辑信息
                    </MenuItem>
                    <MenuItem onSelect={() => handlers.replace?.(stop)}>
                      <Replace /> 换个地方
                    </MenuItem>
                    <MenuItem disabled={!canMoveUp} onSelect={() => handlers.moveStop(stop.id, -1)}>
                      <ArrowUp /> 上移
                    </MenuItem>
                    <MenuItem disabled={!canMoveDown} onSelect={() => handlers.moveStop(stop.id, 1)}>
                      <ArrowDown /> 下移
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem
                      className="text-danger [&_svg]:text-danger"
                      onSelect={() => {
                        deletingStop = true;
                        handlers.removeStop(stop.id);
                      }}
                    >
                      <Trash2 /> 删除这一站
                    </MenuItem>
                  </MenuContent>
                </Menu>
              )}
            </div>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-ink-2 sm:text-sm">
            {[stop.time, stop.stay && `停留 ${formatStayText(String(stop.stay).replace(/^停留\s*/, ''))}`, costText].filter(Boolean).map((part, i) => (
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
            <details
              className="mt-2 rounded-card bg-canvas/80 px-2.5 py-1 text-sm text-ink-2 open:bg-canvas"
              onToggle={(event) => event.currentTarget.open && trackEvent('confirm_open')}
            >
              <summary className="flex min-h-11 cursor-pointer list-none items-center font-semibold text-muted [&::-webkit-details-marker]:hidden">
                出发前要确认的事
              </summary>
              {verifyText && <p className="mt-1 pb-1 leading-relaxed">{verifyText}</p>}
              {riskText && (
                <Notice className="mt-2 mb-1">
                  <span className="sr-only">出发前留意：</span>
                  {riskText}
                </Notice>
              )}
            </details>
          )}
          {confirm && <StopConfirmFold items={confirmItems} acks={confirm.acks} onToggle={confirm.toggle} />}
          {isGuideSupplement && canEdit && (
            <p className="mt-1.5 text-meta text-muted">
              你的攻略里没有这一站，是 AI 加的。
              <button
                type="button"
                className="ml-1 inline-flex min-h-11 min-w-11 items-center justify-center px-1 font-semibold text-danger underline underline-offset-2 sm:min-h-0 sm:min-w-0"
                onClick={(event) => {
                  event.stopPropagation();
                  handlers.removeStop(stop.id);
                }}
              >
                删除
              </button>
            </p>
          )}
          {(() => {
            const verifiedDate = trustBadge.verified && stop.poiTrust?.latestVerifiedAt ? formatVerifiedDate(stop.poiTrust.latestVerifiedAt) : '';
            const showVerifiedDate = Boolean(verifiedDate && verifiedDate !== '待核对');
            if (!selected || (!showVerifiedDate && evidence.length === 0)) return null;
            return (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {showVerifiedDate && (
                  <Chip size="sm" tone="ok">
                    最近核对 {verifiedDate}
                  </Chip>
                )}
                {evidence.map((item) => (
                  <Chip key={item.id || item.label} size="sm" tone={item.type === 'approved-correction' ? 'ok' : 'sky'}>
                    {item.type === 'approved-correction' ? '已核对的纠错' : '攻略来源'} {sourceEvidencePrediction(item)}
                  </Chip>
                ))}
              </div>
            );
          })()}
        </div>
      </li>
      {next && <LegRow from={stop} to={next} roadLeg={roadLeg} transport={transport} canEdit={canEdit} handlers={handlers} />}
    </>
  );
}

/** @param {Record<string, any>} props */
function LegRow({ from, to, roadLeg, transport = '', canEdit = false, handlers = undefined }) {
  const precise = isNavigableCoordinate(from) && isNavigableCoordinate(to);
  const label = /** @type {any} */ (routeLegLabel)(from, to, transport);
  const modeText = roadLeg ? roadLegLabel(roadLeg) : label;
  const estMinutes = !roadLeg && precise ? Number(/约\s*(\d+)\s*分钟/.exec(label)?.[1] || 0) : 0;
  const conflict = legScheduleConflict(from, to, roadLeg, estMinutes);
  const Icon = !precise
    ? Footprints
    : modeText.startsWith('步行')
      ? Footprints
      : modeText.startsWith('公交') || modeText.startsWith('地铁')
        ? Bus
        : CarTaxiFront;
  return (
    <li
      className={cn(
        "relative ml-[52px] flex flex-wrap items-center gap-x-2.5 gap-y-1.5 py-2 text-meta font-semibold text-muted before:absolute before:top-0 before:bottom-0 before:-left-4 before:border-l-[3px] before:border-dotted before:border-line-strong before:content-[''] sm:ml-24 sm:py-2.5 sm:text-sm"
      )}
    >
      <span className="inline-flex items-center gap-2.5">
        <Icon className="size-[18px] shrink-0" aria-hidden="true" />
        {roadLeg ? roadLegLabel(roadLeg) : precise ? label.replace('（路线还没查）', '') : '顺路衔接 · 点站点可直接导航'}
      </span>
      {conflict && (
        <span
          className="inline-flex flex-wrap items-center gap-2 rounded-full bg-warn-soft px-2.5 py-0.5 text-xs font-bold text-warn-ink"
          data-testid="leg-conflict"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{conflict.label}</span>
          {conflict.kind === 'conflict' && canEdit && handlers?.shiftDayTimesFrom && (
            <button
              type="button"
              onClick={() => handlers.shiftDayTimesFrom(to.id, conflict.earliestArrivalMinutes)}
              className="inline-flex min-h-11 items-center underline underline-offset-2 sm:min-h-0"
            >
              顺延后续时间
            </button>
          )}
        </span>
      )}
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
          {[stop.time, stop.stay && `停留 ${formatStayText(String(stop.stay).replace(/^停留\s*/, ''))}`].filter(Boolean).join(' · ')}
        </small>
        {approximate ? (
          <Chip size="sm" tone="warn" className="mt-1">
            位置待确认
          </Chip>
        ) : trustBadge.verified ? (
          <Chip size="sm" tone="ok" className="mt-1">
            <CircleCheckBig /> 已核对
          </Chip>
        ) : null}
      </span>
    </button>
  );
}
