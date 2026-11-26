import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftRight, CalendarPlus, Check, CloudRain, ExternalLink, Loader2, Mail, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import { collectRouteConfirmEntries, groupConfirmItems, readAcks, writeAcks } from '../../lib/confirmChecklist';
import { analyzePreTripReadiness, quickTripDatePresets } from '../../lib/preTripAdvisor';
import { getCityWeather, saveRoutebookConfirmAcks } from '../../lib/api';
import { trackEvent } from '../../lib/betaTelemetry.js';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';

const ESSENTIAL_CONFIRM_KINDS = new Set(['reservation', 'hours', 'position']);

/**
 * 「我知道了」勾选：即时写本机 localStorage，登录主人路书同时防抖同步到云端（供多端与私密朋友链接只读共享）。
 * @param {string} routeId
 * @param {{ serverAcks?: string[], canSync?: boolean, syncPayload?: Record<string, any>, onLocalChange?: (acks: string[]) => void, onSynced?: (data: any) => void }} [opts]
 */
export function useConfirmAcks(
  routeId,
  { serverAcks = undefined, canSync = false, syncPayload = undefined, onLocalChange = undefined, onSynced = undefined } = {}
) {
  const storageId = routeId || 'draft';
  const [acks, setAcks] = useState(() => {
    const base = readAcks(storageId);
    if (Array.isArray(serverAcks)) serverAcks.forEach((k) => base.add(k));
    return base;
  });
  const timerRef = useRef(/** @type {any} */ (null));
  const latestSyncRef = useRef({ canSync, routeId, syncPayload, onLocalChange, onSynced });
  latestSyncRef.current = { canSync, routeId, syncPayload, onLocalChange, onSynced };

  const serverKeySig = Array.isArray(serverAcks) ? serverAcks.join('|') : '';
  useEffect(() => {
    const local = readAcks(storageId);
    if (serverKeySig) {
      serverKeySig.split('|').forEach((k) => {
        if (k) local.add(k);
      });
      writeAcks(storageId, local);
    }
    setAcks(local);
  }, [storageId, serverKeySig]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const toggle = useCallback(
    (key) => {
      setAcks((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        writeAcks(storageId, next);

        const serialized = [...next].slice(0, 120);
        const { canSync: shouldSync, routeId: targetId, syncPayload: payload, onLocalChange: handleLocal, onSynced: notify } = latestSyncRef.current;
        handleLocal?.(serialized);
        if (shouldSync && targetId) {
          clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            saveRoutebookConfirmAcks(targetId, { ...(payload || {}), confirmAcks: serialized })
              .then((res) => notify?.(res))
              .catch(() => {});
          }, 350);
        }
        return next;
      });
    },
    [storageId]
  );

  return { acks, toggle };
}

export function ConfirmItemRow({
  item,
  acked,
  onToggle = undefined,
  stopName = '',
  dayLabel = '',
  readOnly = false,
  claimed = false,
  onToggleClaim = undefined
}) {
  const prefix = [dayLabel, stopName].filter(Boolean).join(' · ');
  return (
    <li className={cn('flex flex-wrap items-start gap-x-3 gap-y-1.5 py-2', acked && 'text-muted')}>
      <span className="min-w-0 flex-1 basis-48">
        <span className="block text-sm font-semibold text-ink-2">
          {prefix && <span className="text-ink">{prefix} · </span>}
          {item.label}
        </span>
        {item.detail && <span className="block text-meta leading-snug text-muted">{item.detail}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <a
          href={item.action.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-white px-3 text-meta font-semibold text-sky-ink hover:bg-sky-soft sm:min-h-9"
          onClick={(event) => {
            event.stopPropagation();
            trackEvent('confirm_search');
          }}
        >
          {item.action.label}
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
        {readOnly ? (
          <>
            <span
              className={cn(
                'inline-flex min-h-9 items-center gap-1 rounded-full px-2.5 text-xs font-bold',
                acked ? 'bg-canvas text-ink-2' : 'bg-lemon-soft text-lemon-ink'
              )}
            >
              {acked && <Check className="size-3.5" aria-hidden="true" />}
              {acked ? '发起人已知晓' : '待查'}
            </span>
            {!acked && onToggleClaim && (
              <button
                type="button"
                aria-pressed={claimed}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleClaim(item.key);
                }}
                className={cn(
                  'inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 text-xs font-bold sm:min-h-9',
                  claimed ? 'border-ink bg-ink text-white' : 'border-line-strong bg-white text-ink-2 hover:bg-canvas'
                )}
              >
                {claimed ? '我来办 ✓' : '我来办'}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            aria-pressed={acked}
            onClick={(event) => {
              event.stopPropagation();
              onToggle?.(item.key);
            }}
            // 刻意不用绿色、不用「已核实」：这是用户自己的勾，不代表信息被官方核对过。
            className={cn(
              'inline-flex min-h-11 items-center gap-1 rounded-full border border-dashed px-3 text-meta font-semibold sm:min-h-9',
              acked ? 'border-ink-2/40 bg-canvas text-ink-2' : 'border-line-strong bg-white text-muted'
            )}
          >
            <Check className={cn('size-3.5', !acked && 'opacity-30')} aria-hidden="true" />
            我知道了
          </button>
        )}
      </span>
    </li>
  );
}

/** 单站卡片里的待确认项：已标「我知道了」的项与卡片已展示的「位置待确认」自动消隐；仅 1 项时直接摘要展示内容而非笼统的「（其他）」。 */
export function StopConfirmFold({ items, acks, onToggle }) {
  const unacked = items.filter((item) => item.kind !== 'position' && !acks.has(item.key));
  if (!unacked.length) return null;
  const singleSnippet =
    unacked.length === 1
      ? String(unacked[0]?.detail || unacked[0]?.label || '')
          .trim()
          .slice(0, 22)
      : '';
  return (
    <details
      className="mt-2 rounded-card bg-canvas/80 px-2.5 py-1.5 text-sm text-ink-2 open:bg-canvas"
      onClick={(event) => event.stopPropagation()}
      onToggle={(event) => event.currentTarget.open && trackEvent('confirm_open')}
    >
      <summary className="flex min-h-11 cursor-pointer list-none items-center truncate font-semibold text-muted [&::-webkit-details-marker]:hidden">
        {singleSnippet ? `到场前留意：${singleSnippet}` : `到场前留意 ${unacked.length} 项`}
      </summary>
      <ul className="m-0 list-none divide-y divide-line p-0">
        {unacked.map((item) => (
          <ConfirmItemRow key={item.key} item={item} acked={false} onToggle={onToggle} />
        ))}
      </ul>
    </details>
  );
}

/**
 * 统一「出发准备」卡片：合并原先分散的「测算车程条 + 替你查好 + 出发前必办总表」，分三层呈现（已核对 / 必须本人办 / 参考折叠）。
 */
export function PreTripConciergeCard({
  routebook,
  claimsForStop = () => [],
  verifiedStopCount = 0,
  canEdit = false,
  recheckState = undefined,
  onRecheck = undefined,
  onSelectDate = undefined,
  onSwapDays = undefined,
  onSaveReminder = undefined,
  onSendEmailReminder = undefined,
  onApplyMode = undefined,
  entries = [],
  acks = new Set(),
  onToggleAck = undefined,
  multiDay = false,
  canSync = false
}) {
  const advisor = useMemo(() => analyzePreTripReadiness(routebook, { claimsForStop, verifiedStopCount }), [routebook, claimsForStop, verifiedStopCount]);
  const presets = useMemo(() => quickTripDatePresets(), []);
  const [weatherForecasts, setWeatherForecasts] = useState(/** @type {any[]} */ ([]));

  useEffect(() => {
    const city = routebook?.city || '';
    const daysAway = advisor.daysUntilDeparture;
    if (!city || daysAway == null || daysAway < -1 || daysAway > 4) {
      setWeatherForecasts([]);
      return undefined;
    }
    const ctrl = new AbortController();
    getCityWeather(city, ctrl.signal)
      .then((res) => {
        if (!ctrl.signal.aborted && res?.available && Array.isArray(res.forecasts)) {
          setWeatherForecasts(res.forecasts);
        }
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [routebook?.city, advisor.daysUntilDeparture]);

  const rainyTripDays = useMemo(() => {
    if (!weatherForecasts.length || !advisor.daySchedules.length) return [];
    const byDate = new Map(weatherForecasts.map((f) => [f.date, f]));
    return advisor.daySchedules.map((s) => ({ sched: s, forecast: byDate.get(s.dateYmd) })).filter((x) => x.forecast?.rainy);
  }, [weatherForecasts, advisor.daySchedules]);

  const [editingDate, setEditingDate] = useState(false);

  if (!advisor.totalStops) return null;

  const firstSched = advisor.daySchedules[0];
  const hasDate = Boolean(advisor.travelDate && firstSched?.dateShort);
  const showRecheckBtn =
    Boolean(canEdit && (routebook?.publishStatus || 'draft') === 'draft' && onRecheck) &&
    (!advisor.roadComplete || Boolean(recheckState?.busy || recheckState?.message));

  return (
    <section data-testid="pretrip-concierge" aria-label="出发准备" className="mt-3 rounded-card border border-line bg-white px-3.5 py-3 text-sm shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-extrabold text-ink">
          <ShieldCheck className="size-4 text-success-ink" aria-hidden="true" />
          出发准备 · 替你查好
        </span>
        <span className="flex flex-wrap items-center gap-1.5">
          {showRecheckBtn && (
            <button
              type="button"
              data-testid="recheck-bar"
              onClick={onRecheck}
              disabled={Boolean(recheckState?.busy)}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-canvas px-2.5 text-xs font-bold text-ink-2 hover:bg-line disabled:opacity-60 sm:min-h-8"
            >
              {recheckState?.busy ? (
                <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              {recheckState?.busy ? '查路线中…' : '测算车程'}
            </button>
          )}
          {hasDate && onSaveReminder && (
            <button
              type="button"
              onClick={onSaveReminder}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-canvas px-2.5 text-xs font-bold text-ink-2 hover:bg-line sm:min-h-8"
            >
              <CalendarPlus className="size-3.5" aria-hidden="true" />
              日历提醒
            </button>
          )}
          {hasDate && canSync && onSendEmailReminder && (
            <button
              type="button"
              data-testid="pretrip-email-reminder-btn"
              onClick={onSendEmailReminder}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-canvas px-2.5 text-xs font-bold text-ink-2 hover:bg-line sm:min-h-8"
            >
              <Mail className="size-3.5" aria-hidden="true" />
              邮件备忘
            </button>
          )}
        </span>
      </div>

      {recheckState?.message && (
        <p role="status" aria-live="polite" className="mt-1.5 text-xs font-semibold text-ink-2">
          {recheckState.message}
        </p>
      )}

      <div className="mt-2 flex flex-wrap gap-1.5 text-xs font-bold">
        <span className="rounded-full bg-canvas px-2.5 py-1 text-ink-2">
          已核对 {advisor.verifiedStopCount}/{advisor.totalStops} 站资料
        </span>
        {advisor.roadComplete && <span className="rounded-full bg-success-soft px-2.5 py-1 text-success-ink">站间车程已测算</span>}
        {hasDate && advisor.closureConflicts.length === 0 && (
          <span className="rounded-full bg-success-soft px-2.5 py-1 text-success-ink" data-testid="pretrip-no-closure">
            按 {firstSched.dateShort}（{firstSched.weekdayLabel}）排查无闭馆冲突
          </span>
        )}
        {advisor.costBreakdown?.text && (
          <span className="rounded-full bg-canvas px-2.5 py-1 text-ink-2" data-testid="pretrip-cost-breakdown">
            花费构成：{advisor.costBreakdown.text}
          </span>
        )}
        {hasDate && canEdit && onSelectDate && (
          <button
            type="button"
            aria-expanded={editingDate}
            onClick={() => setEditingDate((v) => !v)}
            className="min-h-9 rounded-full bg-canvas px-2.5 py-1 font-semibold text-muted underline underline-offset-2 sm:min-h-0"
          >
            {editingDate ? '收起日期' : '改日期'}
          </button>
        )}
      </div>

      {(!hasDate || editingDate) && canEdit && onSelectDate && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5" data-testid="pretrip-date-quickpick">
          <span className="text-xs text-muted">{hasDate ? '改到其他出行日期：' : '选日期自动查周一闭馆：'}</span>
          {presets.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => {
                onSelectDate(preset.ymd);
                setEditingDate(false);
              }}
              className="min-h-11 rounded-full border border-line-strong bg-canvas px-2.5 text-xs font-bold text-ink hover:bg-line sm:min-h-7"
            >
              {preset.shortLabel}
            </button>
          ))}
          <input
            type="date"
            aria-label="选择具体出行日期"
            value={String(routebook?.travelDate || routebook?.constraints?.date || '').slice(0, 10)}
            onChange={(e) => {
              onSelectDate(e.target.value);
              if (e.target.value) setEditingDate(false);
            }}
            className="min-h-11 rounded-full border border-line-strong bg-white px-2.5 text-xs font-bold text-ink sm:min-h-7"
          />
          {hasDate && (
            <button
              type="button"
              onClick={() => {
                onSelectDate('');
                setEditingDate(false);
              }}
              className="min-h-11 rounded-full border border-dashed border-line-strong px-2.5 text-xs font-semibold text-muted hover:bg-canvas sm:min-h-7"
            >
              暂未定
            </button>
          )}
        </div>
      )}

      {rainyTripDays.length > 0 && (
        <div
          data-testid="pretrip-weather-alert"
          role="status"
          className="mt-2.5 flex flex-wrap items-center justify-between gap-2 rounded-tile bg-sky-soft px-3 py-2 text-xs font-semibold text-sky-ink"
        >
          <span className="flex items-center gap-1.5">
            <CloudRain className="size-4 shrink-0" aria-hidden="true" />
            <span>
              出行期天气提醒：
              {rainyTripDays.map(({ sched, forecast }) => `${sched.day}（${sched.dateShort}）预报${forecast.dayweather}`).join('、')}
            </span>
          </span>
          {canEdit && onApplyMode && (
            <Button size="sm" variant="dark" onClick={() => onApplyMode('雨天')}>
              一键换雨天室内顺序
            </Button>
          )}
        </div>
      )}

      {advisor.closureConflicts.length > 0 && (
        <div className="mt-2.5 grid gap-2" data-testid="pretrip-closure-conflict">
          {advisor.closureConflicts.map((conflict) => (
            <div
              key={`${conflict.day}-${conflict.stopId}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-warn-soft px-3 py-2 text-xs font-semibold text-warn-ink"
              role="status"
            >
              <span className="flex items-start gap-1.5">
                <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
                <span>
                  替你查出闭馆冲突：{conflict.day}（{conflict.dateShort} {conflict.weekdayLabel}）「{conflict.stopName}」{conflict.reason}
                </span>
              </span>
              {canEdit && conflict.suggestedDay && onSwapDays && (
                <Button size="sm" variant="dark" onClick={() => onSwapDays(conflict.day, conflict.suggestedDay)}>
                  <ArrowLeftRight /> 与 {conflict.suggestedDay} 对调
                </Button>
              )}
            </div>
          ))}
        </div>
      )}

      {advisor.transitWindow?.hasWindow && (
        <div
          data-testid="pretrip-transit-window"
          className={cn(
            'mt-2 rounded-tile px-3 py-2 text-xs font-semibold',
            advisor.transitWindow.arrivalConflict || advisor.transitWindow.departureConflict ? 'bg-warn-soft text-warn-ink' : 'bg-sky-soft/70 text-sky-ink'
          )}
        >
          <p>{advisor.transitWindow.summaryText}</p>
          {(advisor.transitWindow.arrivalConflict || advisor.transitWindow.departureConflict) && (
            <p className="mt-0.5">留意：{[advisor.transitWindow.arrivalConflict, advisor.transitWindow.departureConflict].filter(Boolean).join('；')}</p>
          )}
        </div>
      )}

      {advisor.reservationPlans.length > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          <b className="font-bold">预约提醒：</b>
          {advisor.reservationPlans
            .slice(0, 3)
            .map((plan) => `「${plan.stopName}」${plan.hint}`)
            .join('；')}
        </p>
      )}

      {entries.length > 0 && <RouteConfirmBoard entries={entries} acks={acks} onToggle={onToggleAck} multiDay={multiDay} canSync={canSync} embedded />}
    </section>
  );
}

/**
 * 置顶全行程必办清单：优先统计必须本人处理的「预约 / 开放时间 / 定位」项，票价估算与一般参考折叠在次级，不再出现夸张的 0/14。
 */
export function RouteConfirmBoard({ entries, acks, onToggle, multiDay = false, canSync = false, embedded = false }) {
  if (!entries.length) return null;
  const essentialEntries = entries.filter(({ item }) => ESSENTIAL_CONFIRM_KINDS.has(item.kind));
  const optionalEntries = entries.filter(({ item }) => !ESSENTIAL_CONFIRM_KINDS.has(item.kind));
  const headlinePool = essentialEntries.length > 0 ? essentialEntries : entries;
  const doneCount = headlinePool.filter(({ item }) => acks.has(item.key)).length;
  const openCount = headlinePool.length - doneCount;
  const allDone = openCount === 0;
  const essentialGroups = groupConfirmItems(essentialEntries.length > 0 ? essentialEntries : entries);
  const optionalGroups = essentialEntries.length > 0 ? groupConfirmItems(optionalEntries) : [];

  return (
    <details
      data-testid="route-confirm-board"
      className={cn(embedded ? 'mt-2.5 border-t border-line pt-2' : 'mt-4 rounded-card border border-line bg-white px-3.5 py-1.5 shadow-card')}
      onToggle={(event) => event.currentTarget.open && trackEvent('confirm_open')}
    >
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-xs font-extrabold text-ink sm:min-h-9 sm:text-sm [&::-webkit-details-marker]:hidden">
        <span>
          {essentialEntries.length > 0 ? '需你本人确认' : '行前参考清单'}
          <span className="ml-2 font-normal text-muted">{allDone ? '已全部知晓' : `还有 ${openCount} 项`}</span>
        </span>
        <span
          data-testid="route-confirm-progress"
          className={cn('num rounded-full px-2.5 py-0.5 text-xs font-bold', allDone ? 'bg-canvas text-ink-2' : 'bg-lemon-soft text-lemon-ink')}
        >
          已备妥 {doneCount}/{headlinePool.length}
        </span>
      </summary>
      <p className="mt-1 text-meta text-muted">
        仅统计需提前预约、留意闭馆或核准定位的事项；标过「我知道了」会在单站卡片里收起
        {canSync ? '，发朋友链接时同行人也能看到进度。' : '。'}
      </p>
      {essentialGroups.map((group) => (
        <section key={group.kind} className="mt-2.5">
          <h4 className="text-meta font-bold text-ink-2">{group.label}</h4>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {group.items.map(({ item, stopName, day }) => (
              <ConfirmItemRow key={item.key} item={item} stopName={stopName} dayLabel={multiDay ? day : ''} acked={acks.has(item.key)} onToggle={onToggle} />
            ))}
          </ul>
        </section>
      ))}
      {optionalGroups.length > 0 && (
        <details className="mt-2.5 rounded-tile bg-canvas/70 px-3 py-1.5">
          <summary className="cursor-pointer list-none text-xs font-semibold text-muted [&::-webkit-details-marker]:hidden">
            其余 {optionalEntries.length} 项票价估算与现场参考（选看）
          </summary>
          {optionalGroups.map((group) => (
            <section key={group.kind} className="mt-2">
              <h4 className="text-meta font-bold text-ink-2">{group.label}</h4>
              <ul className="m-0 list-none divide-y divide-line p-0">
                {group.items.map(({ item, stopName, day }) => (
                  <ConfirmItemRow
                    key={item.key}
                    item={item}
                    stopName={stopName}
                    dayLabel={multiDay ? day : ''}
                    acked={acks.has(item.key)}
                    onToggle={onToggle}
                  />
                ))}
              </ul>
            </section>
          ))}
        </details>
      )}
    </details>
  );
}

/** 同行朋友链接（visibility === 'unlisted'）只读共享与分工认领的行前准备进度卡片。 */
export function CompanionConfirmCard({ routebook, enrichedFacts = [], claimedKeys = [], onToggleClaim = undefined }) {
  const allEntries = useMemo(
    () =>
      collectRouteConfirmEntries(routebook, {
        claimsForStop: (stop) => (enrichedFacts || []).filter((f) => f.stopName === stop?.name)
      }),
    [routebook, enrichedFacts]
  );
  const essentialEntries = useMemo(() => allEntries.filter(({ item }) => ESSENTIAL_CONFIRM_KINDS.has(item.kind)), [allEntries]);
  const entries = essentialEntries.length > 0 ? essentialEntries : allEntries;
  if (!entries.length) return null;
  const ackSet = new Set(Array.isArray(routebook?.confirmAcks) ? routebook.confirmAcks : []);
  const claimSet = new Set(Array.isArray(claimedKeys) ? claimedKeys : []);
  const doneCount = entries.filter(({ item }) => ackSet.has(item.key)).length;
  const multiDay = (routebook?.days?.length || 1) > 1;
  const groups = groupConfirmItems(entries);

  return (
    <details data-testid="companion-confirm-card" className="mb-4 rounded-card border border-line bg-white px-4 py-2 shadow-card">
      <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 text-sm font-extrabold text-ink [&::-webkit-details-marker]:hidden">
        <span>同行出发前确认清单</span>
        <span className="num rounded-full bg-sky-soft px-2.5 py-0.5 text-xs font-bold text-sky-ink" data-testid="companion-confirm-progress">
          发起人已备妥 {doneCount}/{entries.length}
        </span>
      </summary>
      <p className="mt-1 text-meta text-muted">以下是本趟路线出发前需要留意的预约、门票与营业时间；同行人可点「我来办」认领分工。</p>
      {groups.map((group) => (
        <section key={group.kind} className="mt-2.5">
          <h4 className="text-meta font-bold text-ink-2">{group.label}</h4>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {group.items.map(({ item, stopName, day }) => (
              <ConfirmItemRow
                key={item.key}
                item={item}
                stopName={stopName}
                dayLabel={multiDay ? day : ''}
                acked={ackSet.has(item.key)}
                readOnly
                claimed={claimSet.has(item.key)}
                onToggleClaim={onToggleClaim}
              />
            ))}
          </ul>
        </section>
      ))}
    </details>
  );
}

/** 兼容旧调用的当天汇总导出。 */
export function DayConfirmSummary({ entries, acks, onToggle }) {
  if (!entries.length || new Set(entries.map((entry) => entry.stopName)).size < 2) return null;
  return <RouteConfirmBoard entries={entries} acks={acks} onToggle={onToggle} />;
}
