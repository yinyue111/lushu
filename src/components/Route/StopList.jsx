import {
  ArrowDown,
  ArrowUp,
  CarTaxiFront,
  CircleCheckBig,
  Clock,
  Footprints,
  Info,
  MapPinned,
  MoreVertical,
  Pencil,
  Ticket,
  Trash2,
  TriangleAlert
} from 'lucide-react';
import { isNavigableCoordinate, routeLegLabel } from '../../lib/coordinates';
import { formatVerifiedDate, getStopTrustBadge } from '../../lib/trust';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui/menu';
import { StopThumb } from '../visual/StopThumb';
import { sourceEvidencePrediction, stopKey } from './routebookModel';

export default function StopList({ stops, theme, selectedId, routeTrustTone, canEdit, draggedStopId, activeDay, handlers }) {
  return (
    <ol className="m-0 list-none p-0" aria-label={`${activeDay} 站点`}>
      {stops.map((stop, index) => (
        <StopRow
          key={stop.id ?? index}
          stop={stop}
          index={index}
          next={stops[index + 1]}
          theme={theme}
          selected={stopKey(selectedId) === stopKey(stop.id)}
          routeTrustTone={routeTrustTone}
          canEdit={canEdit}
          canMoveUp={index > 0}
          canMoveDown={index < stops.length - 1}
          handlers={handlers}
          draggedStopId={draggedStopId}
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
function StopRow({ stop, index, next, theme, selected, routeTrustTone, canEdit, canMoveUp, canMoveDown, handlers, draggedStopId }) {
  const trustBadge = getStopTrustBadge(stop, routeTrustTone);
  const approximate = !isNavigableCoordinate(stop);
  const verifiedCount = Number(stop.poiTrust?.validArrivals ?? stop.poiTrust?.sampleCount ?? 0) || 0;
  const evidence = Array.isArray(stop.sourceEvidence) ? stop.sourceEvidence.slice(0, 3) : [];

  return (
    <>
      <li
        className={cn(
          'group grid cursor-pointer grid-cols-[104px_minmax(0,1fr)] gap-3 rounded-card border border-line bg-white p-2.5 shadow-card transition-[transform,box-shadow] duration-300 ease-(--ease-spring) hover:-translate-y-0.5 hover:shadow-pop sm:grid-cols-[168px_minmax(0,1fr)] sm:gap-[18px] sm:p-3',
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
        <StopThumb stop={stop} number={index + 1} time={stop.time} color={theme.ink} className="min-h-28 sm:min-h-[132px]" />
        <div className="min-w-0 py-1 pr-1.5">
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
            <h3 className="text-[17px] leading-snug font-extrabold sm:text-xl">
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
            {stop.area && <span className="text-[13px] text-muted sm:text-sm">{stop.area}</span>}
            <div className="ml-auto flex items-center gap-1" onClick={(event) => event.stopPropagation()}>
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
          <div className="my-1.5 flex flex-wrap gap-1.5 sm:my-2">
            {stop.stay && (
              <Chip size="sm" className="sm:h-7 sm:text-sm">
                <Clock /> 停留 {String(stop.stay).replace(/^停留\s*/, '')}
              </Chip>
            )}
            {stop.cost && (
              <Chip size="sm" className="sm:h-7 sm:text-sm">
                <Ticket /> {stop.cost}
              </Chip>
            )}
            {trustBadge.tone === 'verified' ? (
              <Chip size="sm" tone="ok" className="sm:h-7 sm:text-sm">
                <CircleCheckBig /> {verifiedCount ? `${verifiedCount} 人到达验证` : trustBadge.label}
              </Chip>
            ) : trustBadge.tone === 'trial' ? (
              <Chip size="sm" tone="warn" className="sm:h-7 sm:text-sm">
                待人工复核
              </Chip>
            ) : (
              <Chip size="sm" tone="sky" className="sm:h-7 sm:text-sm">
                还没人打卡
              </Chip>
            )}
            {approximate && (
              <Chip size="sm" tone="warn" className="sm:h-7 sm:text-sm">
                <MapPinned /> 位置待确认
              </Chip>
            )}
          </div>
          {stop.verify && <p className="text-sm text-ink-2 sm:text-[15px]">{stop.verify}</p>}
          {stop.risk && (
            <p className="mt-2 inline-flex items-start gap-1.5 rounded-[10px] bg-primary-soft px-2 py-1.5 text-[13px] font-semibold text-primary-strong sm:px-2.5 sm:text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              {stop.risk}
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
      {next && <LegRow from={stop} to={next} />}
    </>
  );
}

/** @param {Record<string, any>} props */
function LegRow({ from, to }) {
  const precise = isNavigableCoordinate(from) && isNavigableCoordinate(to);
  const label = routeLegLabel(from, to).replace(/^直线估算：/, '');
  const walking = label.startsWith('步行');
  const Icon = !precise ? TriangleAlert : walking ? Footprints : CarTaxiFront;
  return (
    <li
      className={cn(
        "relative ml-[52px] flex items-center gap-2.5 py-2 text-[13px] font-semibold text-muted before:absolute before:top-0 before:bottom-0 before:-left-4 before:border-l-[3px] before:border-dotted before:border-line-strong before:content-[''] sm:ml-24 sm:py-2.5 sm:text-sm",
        !precise && 'text-lemon-ink'
      )}
    >
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      {precise ? `${label}（直线估算）` : '转场距离待确认：有站点位置还不精确'}
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
        <small className="block truncate text-[13px] text-muted">
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
