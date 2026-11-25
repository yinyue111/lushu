import { costDisplay } from '../../lib/cost';
import { publicCreatorName } from '../../lib/creatorName.js';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, BookmarkPlus, Check, Copy, Map as MapIcon, MapPin, Play, Plus, RefreshCw, Sparkles, UserRound, Wallet } from 'lucide-react';
import { getShareRoutebook, recordExposure, saveCompanionFeedback } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { formatStayText, routeMetaText } from '../../lib/routeMeta.js';
import { getRouteTrustBadgeState, getStopTrustState, maskTrustMetrics, isOperatorMetric } from '../../lib/trust';
import { Button } from '../ui/button';
import { roadbookDocumentTitle, useDocumentTitle } from '../../lib/useDocumentTitle.js';
import { cn } from '../ui/cn';
import { TrustChip } from '../cards/TrustChip';
import { CityBackdrop } from '../visual/CityBackdrop';
import { StopThumb } from '../visual/StopThumb';
import { dayNumber, dayTheme } from '../visual/theme';
import AigcChip from './AigcChip';
import { CompanionConfirmCard } from './ConfirmChecklist';
import { collectRouteConfirmEntries } from '../../lib/confirmChecklist';
import { buildCompanionSummaryText, readCompanionState, summarizeCompanionResponses, writeCompanionState } from '../../lib/companionFeedback';
import { calculateExpenseSplit, formatExpenseSplitSummary, parseExpenseAmount } from '../../lib/expenseSplit';
import { ConditionNotes } from './EnrichedFacts';
import { trackEvent } from '../../lib/betaTelemetry.js';
import { UNVERIFIED_CITY_NOTE, isUnverifiedCity } from './RouteStats';
import { sortValidationsByPriority, summarizeValidationCounts, validationFallbackDetail, validationStateTone } from '../../lib/validationCopy';

const PoiDetail = lazy(() => import('./PoiDetail'));
const RouteMap = lazy(() => import('./RouteMap'));

// V-U10: say what probably happened and offer a next step instead of a dead end.
const SHARE_GONE_TEXT = '可能是对方停用了链接。可以让 TA 重新发一次，或者自己排一条。';
function shareLoadErrorText(error) {
  const status = Number(error?.status) || 0;
  if (!status || status === 404 || status === 410) return error?.code === 'NETWORK_OFFLINE' ? error.message : SHARE_GONE_TEXT;
  return error?.message || SHARE_GONE_TEXT;
}

/** @param {Record<string, any>} props */
export default function PublicSharePage({ publicId, onBack, onSave, onUse, onCustomize, onOpenCreator }) {
  const [state, setState] = useState(
    /** @type {{ loading: boolean, error: string, routebook: any, enrichedFacts?: any[] }} */ ({ loading: true, error: '', routebook: null })
  );
  const [actionState, setActionState] = useState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [detailStop, setDetailStop] = useState(/** @type {any} */ (null));
  const [showMap, setShowMap] = useState(false);
  const [activeMapDay, setActiveMapDay] = useState('');
  const [companionState, setCompanionState] = useState(() => readCompanionState(publicId));
  const [companionSyncedList, setCompanionSyncedList] = useState(/** @type {any[]} */ ([]));
  const [companionSyncNote, setCompanionSyncNote] = useState('');
  const [companionCopyNotice, setCompanionCopyNotice] = useState('');
  const [compExpTitle, setCompExpTitle] = useState('');
  const [compExpAmount, setCompExpAmount] = useState('');
  const companionSyncTimerRef = useRef(/** @type {any} */ (null));
  const exposureRef = useRef('');
  useDocumentTitle(roadbookDocumentTitle(state.routebook?.title));

  const mapDayEntries = useMemo(() => {
    const rb = state.routebook;
    if (!rb) return [];
    const rbStops = rb.stops ?? [];
    const rbDays = rb.days ?? ['Day 1'];
    return rbDays
      .map((day, idx) => ({
        day,
        index: idx,
        number: dayNumber(day, idx),
        label: day,
        theme: dayTheme(idx),
        stops: rbStops.filter((s) => (s.day || 'Day 1') === day)
      }))
      .filter((entry) => entry.stops.length > 0);
  }, [state.routebook]);

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', routebook: null });
    setActionState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
    // Unlisted friend links carry their key as ?k=; it is only sent back to the share API.
    const friendKey = new URLSearchParams(window.location.search).get('k') || '';
    getShareRoutebook(publicId, ctrl.signal, friendKey)
      .then((data) => {
        const routebook = data.routebook?.visibility === 'unlisted' ? { ...data.routebook, shareKey: friendKey } : data.routebook;
        if (!ctrl.signal.aborted) {
          setCompanionSyncedList(Array.isArray(data.routebook?.companions) ? data.routebook.companions : []);
          setState({ loading: false, error: '', routebook, enrichedFacts: Array.isArray(data.enrichedFacts) ? data.enrichedFacts : [] });
        }
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: shareLoadErrorText(error), routebook: null });
      });
    return () => ctrl.abort();
  }, [publicId]);

  useEffect(() => {
    const routebook = state.routebook;
    const routeId = routebook?.publicId || routebook?.id;
    if (!routebook || !routeId || exposureRef.current === routeId) return;
    exposureRef.current = routeId;
    const profile = getProfile();
    recordExposure({
      profileId: profile.id,
      surface: 'public-share',
      itemType: 'routebook',
      itemId: routeId,
      routeId,
      routeTitle: routebook.title,
      city: routebook.city,
      creatorId: routebook.creator?.id
    }).catch(() => {});
  }, [state.routebook]);

  if (state.loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4" role="status">
        <div className="flex flex-col items-center gap-3 text-muted">
          <Sparkles className="size-7 animate-pulse text-primary" aria-hidden="true" />
          <p className="text-sm font-semibold">正在读取分享的路书...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.routebook) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4">
        <div className="max-w-sm rounded-panel border border-line bg-white p-6 text-center shadow-card">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-primary-soft text-primary-strong">
            <AlertCircle className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-3 text-xl font-extrabold">这条分享打不开了</h1>
          <p className="mt-1 text-sm text-muted">{state.error || SHARE_GONE_TEXT}</p>
          <Button variant="primary" className="mt-4" onClick={onBack}>
            自己排一条
          </Button>
        </div>
      </div>
    );
  }

  const routebook = state.routebook;
  const stops = routebook.stops ?? [];
  const days = routebook.days ?? ['Day 1'];
  const isUnlistedCompanion = routebook.visibility === 'unlisted';
  const companionConfirmEntries = isUnlistedCompanion
    ? collectRouteConfirmEntries(routebook, {
        claimsForStop: (stop) => (state.enrichedFacts || []).filter((f) => f.stopName === stop?.name)
      })
    : [];
  const companionSummaryText = isUnlistedCompanion ? buildCompanionSummaryText(routebook, companionState, companionConfirmEntries) : '';
  const companionGroup = isUnlistedCompanion ? summarizeCompanionResponses(routebook, companionSyncedList, companionConfirmEntries) : null;
  const sharedAaResult = isUnlistedCompanion
    ? (() => {
        const ownerExtras = (routebook?.expenseLedger?.extraExpenses ?? []).map((item) => ({
          ...item,
          paidBy: item?.paidBy === '我' ? '发起人' : item?.paidBy || '发起人',
          splitWith: Array.isArray(item?.splitWith) ? item.splitWith.map((n) => (n === '我' ? '发起人' : n)) : []
        }));
        const ownerTravelers = (routebook?.expenseLedger?.travelers ?? []).map((n) => (n === '我' ? '发起人' : n));
        const localOwnNotSyncedYet = (companionState?.expenses ?? [])
          .filter((loc) => !(companionGroup?.sharedExpenses ?? []).some((rem) => rem.rawId === loc.id && rem.companionId === companionState.companionId))
          .map((loc) => ({
            ...loc,
            id: `local:${loc.id}`,
            paidBy: companionState.nickname || loc.paidBy || '同行伙伴'
          }));
        const mergedTravelers = [
          '发起人',
          ...ownerTravelers,
          ...(companionGroup?.memberNames ?? []),
          ...(companionState.nickname ? [companionState.nickname] : [])
        ].filter(Boolean);
        return calculateExpenseSplit({
          stops: [],
          latestByStop: new Map(),
          travelers: mergedTravelers,
          extraExpenses: [...ownerExtras, ...(companionGroup?.sharedExpenses ?? []), ...localOwnNotSyncedYet]
        });
      })()
    : null;

  function scheduleCompanionSync(nextState) {
    const key = routebook?.shareKey || '';
    if (!isUnlistedCompanion || !/^[a-f0-9]{32}$/.test(key)) return;
    if (companionSyncTimerRef.current) clearTimeout(companionSyncTimerRef.current);
    companionSyncTimerRef.current = setTimeout(() => {
      saveCompanionFeedback(publicId, key, nextState)
        .then((res) => {
          if (Array.isArray(res?.companions)) setCompanionSyncedList(res.companions);
          setCompanionSyncNote('已同步给发起人');
          trackEvent('companion_submit', publicId);
        })
        .catch(() => {
          setCompanionSyncNote('暂存本机，可点下方复制发群里');
        });
    }, 280);
  }

  function updateCompanionNickname(value) {
    const nextNickname = String(value ?? '').slice(0, 20);
    setCompanionState((prev) => {
      const saved = writeCompanionState(publicId, { ...prev, nickname: nextNickname });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  function toggleCompanionVote(stop, nextVote) {
    const key = String(stop?.id ?? stop?.name ?? '');
    if (!key) return;
    setCompanionCopyNotice('');
    setCompanionState((prev) => {
      const current = prev.votes?.[key] || '';
      const updatedVotes = { ...(prev.votes ?? {}) };
      if (current === nextVote) delete updatedVotes[key];
      else updatedVotes[key] = nextVote;
      const saved = writeCompanionState(publicId, { ...prev, votes: updatedVotes });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  function toggleCompanionClaim(itemKey) {
    setCompanionCopyNotice('');
    setCompanionState((prev) => {
      const set = new Set(prev.claims ?? []);
      if (set.has(itemKey)) set.delete(itemKey);
      else set.add(itemKey);
      const saved = writeCompanionState(publicId, { ...prev, claims: [...set] });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  function toggleCompanionVisited(stop) {
    const key = String(stop?.id ?? stop?.name ?? '');
    if (!key) return;
    setCompanionState((prev) => {
      const set = new Set(prev.visitedStopIds ?? []);
      if (set.has(key)) set.delete(key);
      else set.add(key);
      const saved = writeCompanionState(publicId, { ...prev, visitedStopIds: [...set] });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  function submitCompanionExpense(event) {
    event.preventDefault();
    const amount = parseExpenseAmount(compExpAmount);
    const title = compExpTitle.trim().slice(0, 40);
    if (!title || !(amount > 0)) return;
    const payer = (companionState.nickname || '').trim() || '同行伙伴';
    const entry = {
      id: `cexp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      amount,
      paidBy: payer,
      splitWith: [],
      createdAt: new Date().toISOString()
    };
    setCompExpTitle('');
    setCompExpAmount('');
    trackEvent('expense_add', 'companion');
    setCompanionState((prev) => {
      const saved = writeCompanionState(publicId, {
        ...prev,
        nickname: prev.nickname || payer,
        expenses: [entry, ...(prev.expenses ?? [])].slice(0, 40)
      });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  function removeCompanionOwnExpense(rawId) {
    setCompanionState((prev) => {
      const saved = writeCompanionState(publicId, {
        ...prev,
        expenses: (prev.expenses ?? []).filter((e) => e.id !== rawId)
      });
      scheduleCompanionSync(saved);
      return saved;
    });
  }

  async function copyCompanionFeedback() {
    if (!companionSummaryText) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(companionSummaryText);
      setCompanionCopyNotice('已复制你的同行意见，直接发回微信群给发起人即可。');
    } catch {
      setCompanionCopyNotice('浏览器未开启自动复制，请手动复制下方汇总。');
    }
  }
  const trustState = getRouteTrustBadgeState(routebook);
  // V-U16: operator metrics (复制转化, 平均修改…) mean nothing to a stranger; the share page shows traveller signals only.
  const visibleMetrics = maskTrustMetrics(routebook.metrics, trustState.tone, 6).filter((metric) => !isOperatorMetric(metric));
  // Metrics without data yet collapse into one quiet line instead of a grid of "待核对" tiles.
  const isPendingMetric = (metric) => /^(待确认|待核对|待复核|暂无|—|-|)$/.test(String(metric.value ?? '').trim());
  const filledMetrics = visibleMetrics.filter((metric) => !isPendingMetric(metric));
  const pendingMetrics = visibleMetrics.filter(isPendingMetric);

  async function copyShareText() {
    setActionState((current) => ({ ...current, message: '', isError: false }));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持自动复制');
      await navigator.clipboard.writeText(buildShareText(routebook));
      setActionState((current) => ({ ...current, message: '路线摘要已复制。', isError: false }));
    } catch (error) {
      setActionState((current) => ({
        ...current,
        message: `${error.message || '浏览器未允许复制'}，请检查浏览器剪贴板权限。`,
        isError: true
      }));
    }
  }

  async function saveToMyRoutebooks() {
    trackEvent('share_copy', 'save');
    if (!onSave || actionState.pending || actionState.savedDraft) return;
    setActionState((current) => ({ ...current, pending: 'save', message: '', isError: false }));
    try {
      const result = await onSave(routebook, { surface: 'public-share-save' });
      const syncNote = result.synced
        ? result.attributionSynced === false
          ? '已保存到我的路书（来源记录稍后同步）。'
          : '已保存到我的路书。'
        : '已存在这台设备上，云端这次没同步上。';
      setActionState({
        pending: '',
        message: syncNote,
        isError: false,
        savedDraft: result.routebook,
        synced: result.synced
      });
    } catch (error) {
      setActionState({ pending: '', message: error.message, isError: true, savedDraft: null, synced: false });
    }
  }

  async function useRoutebookNow() {
    trackEvent('share_copy', 'use');
    if (!onUse || actionState.pending) return;
    setActionState((current) => ({ ...current, pending: 'use', message: '', isError: false }));
    try {
      await onUse(routebook, {
        surface: 'public-share-use',
        savedRoutebook: actionState.savedDraft,
        synced: actionState.synced
      });
    } catch (error) {
      setActionState((current) => ({ ...current, pending: '', message: error.message, isError: true }));
    }
  }

  const busy = Boolean(actionState.pending);

  return (
    <div className="page-enter pb-36 lg:pb-16">
      <section className="relative isolate overflow-hidden bg-[#1c2230] text-white">
        <CityBackdrop city={routebook.city} />
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.58)_0%,rgba(10,12,16,.56)_36%,rgba(10,12,16,.8)_70%,rgba(10,12,16,.92)_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto flex min-h-[340px] max-w-[1200px] flex-col justify-between gap-6 px-4 pt-5 pb-8 lg:min-h-[400px] lg:px-8 lg:pb-10">
          <Button variant="glass" size="sm" className="self-start" onClick={onBack}>
            <ArrowLeft /> 看看更多路线
          </Button>
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <TrustChip routebook={routebook} className="bg-white/95" />
              <AigcChip routebook={routebook} />
              {routebook.visibility === 'unlisted' && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-white/30 bg-black/60 px-2.5 py-1 text-xs font-bold text-white backdrop-blur"
                  title="作者通过朋友链接分享，未公开发布，也不会被搜索引擎收录"
                >
                  朋友链接 · 未公开
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-full border border-white/30 bg-black/60 px-2.5 py-1 text-xs font-bold text-white backdrop-blur">
                <MapPin className="size-3.5" aria-hidden="true" /> {routeMetaText(routebook.city, days, stops)}
              </span>
              {isUnverifiedCity(routebook.city) && (
                <span
                  className="inline-flex items-center gap-1 rounded-full border border-white/30 bg-black/60 px-2.5 py-1 text-xs font-bold text-white backdrop-blur"
                  data-testid="unverified-city"
                  title={UNVERIFIED_CITY_NOTE}
                >
                  暂无核实资料 · 地点可能不准
                </span>
              )}
            </div>
            <h1
              className={cn(
                'mt-3 leading-tight font-black tracking-tight [overflow-wrap:anywhere]',
                String(routebook.title ?? '').length > 26 ? 'text-2xl lg:text-4xl' : 'text-3xl lg:text-5xl'
              )}
            >
              {routebook.title}
            </h1>
            {routebook.summary && (
              <>
                <p id="share-summary" className={cn('mt-2 max-w-2xl text-copy text-white', !summaryOpen && 'max-sm:line-clamp-3')}>
                  {routebook.summary}
                </p>
                {routebook.summary.length > 60 && (
                  <div className="sm:hidden">
                    <button
                      type="button"
                      aria-expanded={summaryOpen}
                      aria-controls="share-summary"
                      onClick={() => setSummaryOpen((open) => !open)}
                      className="-mt-1 inline-flex min-h-11 items-center text-meta font-bold text-white underline-offset-4 hover:underline"
                    >
                      {summaryOpen ? '收起' : '展开全文'}
                    </button>
                  </div>
                )}
              </>
            )}
            {routebook.creator?.id && publicCreatorName(routebook.creator?.name) && (
              <button
                type="button"
                className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/35 bg-black/55 py-1 pr-3.5 pl-1.5 text-sm font-semibold text-white backdrop-blur hover:bg-black/70"
                onClick={() => onOpenCreator?.(routebook.creator.id)}
              >
                <span className="grid size-7 place-items-center rounded-full bg-lemon text-ink">
                  <UserRound className="size-4" aria-hidden="true" />
                </span>
                {publicCreatorName(routebook.creator.name)}
                <span className="text-white">· {routebook.copyCount ?? 0} 次复制</span>
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 lg:pt-8">
        <section aria-labelledby="share-structure">
          {isUnlistedCompanion && (
            <div
              data-testid="companion-identity-bar"
              className="mb-3 rounded-card border border-line bg-white px-3.5 py-3 text-sm shadow-card"
              role="region"
              aria-label="同行身份认领"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex flex-wrap items-center gap-2 font-bold text-ink">
                  <span>同行认个名（免注册）：</span>
                  <input
                    data-testid="companion-nickname-input"
                    value={companionState.nickname || ''}
                    onChange={(e) => updateCompanionNickname(e.target.value)}
                    placeholder="填你的称呼，如 小林"
                    aria-label="你的同行称呼"
                    className="h-9 w-44 rounded-full border border-line-strong bg-canvas px-3 text-sm font-semibold text-ink focus:border-ink focus:bg-white focus:outline-none"
                  />
                </label>
                {companionSyncNote && <span className="text-xs font-semibold text-success-ink">{companionSyncNote}</span>}
              </div>
              <p className="mt-1.5 text-xs text-muted">
                填个称呼再点下方「想去 / 先不去」或「我来办」，发起人在路书里能直接看到并一键调整，出行记账也能直接选人。
                {companionGroup && companionGroup.memberCount > 0 && ` 当前已表态：${companionGroup.memberNames.join('、')}`}
              </p>
            </div>
          )}
          {isUnlistedCompanion && (
            <CompanionConfirmCard
              routebook={routebook}
              enrichedFacts={state.enrichedFacts}
              claimedKeys={companionState.claims}
              onToggleClaim={toggleCompanionClaim}
            />
          )}
          {isUnlistedCompanion && (
            <details
              data-testid="companion-aa-card"
              open={Boolean(sharedAaResult && sharedAaResult.totalCents > 0)}
              className="mb-4 rounded-card border border-line bg-white px-4 py-2.5 text-sm shadow-card"
            >
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center justify-between gap-2 font-extrabold text-ink [&::-webkit-details-marker]:hidden">
                <span className="inline-flex items-center gap-1.5">
                  <Wallet className="size-4 text-primary" aria-hidden="true" />
                  同行共同 AA 账本（免注册共记）
                </span>
                <span className="num rounded-full bg-canvas px-2.5 py-0.5 text-xs font-bold text-ink-2">
                  {sharedAaResult && sharedAaResult.totalCents > 0
                    ? `共 ${sharedAaResult.entries.length} 笔 · ${sharedAaResult.totalYuan} 元`
                    : '点此记一笔共同开销'}
                </span>
              </summary>
              <p className="mt-1 text-xs text-muted">
                先在上方填好你的称呼，垫付打车、门票或聚餐后随手记一笔，发起人与所有同行伙伴打开此链接都能看到实时结算单。
              </p>
              <form className="mt-2.5 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_auto]" onSubmit={submitCompanionExpense}>
                <label className="sr-only" htmlFor="comp-aa-title">
                  共同开销事项
                </label>
                <input
                  id="comp-aa-title"
                  data-testid="companion-aa-title-input"
                  value={compExpTitle}
                  onChange={(e) => setCompExpTitle(e.target.value)}
                  placeholder="我垫付了什么，如：景区打车、奶茶"
                  className="h-10 rounded-xl border border-line-strong bg-canvas px-3 text-sm text-ink focus:bg-white"
                />
                <label className="sr-only" htmlFor="comp-aa-amount">
                  金额（元）
                </label>
                <input
                  id="comp-aa-amount"
                  data-testid="companion-aa-amount-input"
                  value={compExpAmount}
                  onChange={(e) => setCompExpAmount(e.target.value)}
                  placeholder="金额（元）"
                  className="h-10 rounded-xl border border-line-strong bg-canvas px-3 text-sm text-ink focus:bg-white"
                />
                <Button type="submit" size="sm" variant="dark" data-testid="companion-aa-add-btn" disabled={!compExpTitle.trim() || !compExpAmount.trim()}>
                  <Plus /> 记入共同账本
                </Button>
              </form>
              {sharedAaResult && sharedAaResult.totalCents > 0 && (
                <div className="mt-3 grid gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-canvas px-3 py-2 text-xs font-semibold text-ink-2">
                    <span>
                      合计 <b className="num text-ink">{sharedAaResult.totalYuan}</b> 元 · {sharedAaResult.travelers.length} 人人均约{' '}
                      <b className="num text-ink">{sharedAaResult.perPersonYuan}</b> 元
                    </span>
                    <button
                      type="button"
                      onClick={async () => {
                        const txt = formatExpenseSplitSummary(routebook?.city, routebook?.title, sharedAaResult);
                        if (!txt) return;
                        try {
                          await navigator.clipboard.writeText(txt);
                          setCompanionCopyNotice('已复制共同 AA 结算单，可直接发群里。');
                        } catch {
                          setCompanionCopyNotice('浏览器未开启自动复制，请截图发群里。');
                        }
                      }}
                      className="font-bold text-sky-ink underline underline-offset-2"
                    >
                      复制结算单
                    </button>
                  </div>
                  {sharedAaResult.transfers.length > 0 && (
                    <ul className="rounded-tile bg-sky-soft/60 px-3 py-2 text-xs font-semibold text-ink-2" data-testid="companion-aa-transfers">
                      {sharedAaResult.transfers.map((t, idx) => (
                        <li key={`${t.from}-${t.to}-${idx}`}>
                          • <b className="text-ink">{t.from}</b> 转给 <b className="text-ink">{t.to}</b>：
                          <b className="num text-primary-strong">{t.amountYuan} 元</b>
                        </li>
                      ))}
                    </ul>
                  )}
                  <ul className="divide-y divide-line text-xs">
                    {sharedAaResult.entries.map((entry) => {
                      const ownMatch = (companionState.expenses ?? []).find((e) => entry.id.endsWith(`:${e.id}`));
                      return (
                        <li key={entry.id} className="flex items-center justify-between gap-2 py-1.5">
                          <span className="truncate text-ink-2">
                            <b>{entry.title}</b> · <span className="text-muted">{entry.paidBy}垫付</span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            <b className="num text-ink">{entry.amount} 元</b>
                            {ownMatch && (
                              <button
                                type="button"
                                aria-label={`撤回记账 ${entry.title}`}
                                onClick={() => removeCompanionOwnExpense(ownMatch.id)}
                                className="text-muted hover:text-ink"
                              >
                                ×
                              </button>
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </details>
          )}
          {isUnlistedCompanion && companionSummaryText && (
            <div
              data-testid="companion-feedback-bar"
              className="mb-4 rounded-card border border-line bg-sky-soft/60 px-4 py-3 text-sm"
              role="region"
              aria-label="我的同行表态汇总"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-extrabold text-ink">已记下你的同行表态与分工</strong>
                <Button size="sm" variant="dark" onClick={copyCompanionFeedback} data-testid="copy-companion-feedback-btn">
                  <Copy /> 复制意见发群里
                </Button>
              </div>
              <pre className="mt-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{companionSummaryText}</pre>
              {companionCopyNotice && (
                <p role="status" aria-live="polite" className="mt-1.5 text-xs font-bold text-success-ink">
                  {companionCopyNotice}
                </p>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="share-structure" className="text-xl font-extrabold">
              路线安排
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {!isUnlistedCompanion && (
                <Button size="sm" variant="ghost" className="lg:hidden" disabled={busy} onClick={copyShareText}>
                  <Copy /> 复制摘要
                </Button>
              )}
              {mapDayEntries.length > 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={showMap}
                  onClick={() => {
                    if (!activeMapDay && mapDayEntries[0]) setActiveMapDay(mapDayEntries[0].day);
                    setShowMap((open) => !open);
                  }}
                >
                  <MapIcon /> {showMap ? '收起地图' : '看路线地图'}
                </Button>
              )}
            </div>
          </div>
          {showMap && mapDayEntries.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-card border border-line bg-[#dfeaf2] shadow-card">
              {mapDayEntries.length > 1 && (
                <div className="flex flex-wrap gap-1.5 border-b border-line bg-white px-3 py-2" role="group" aria-label="地图按天查看">
                  {mapDayEntries.map((entry) => {
                    const currentDay = activeMapDay || mapDayEntries[0]?.day;
                    const pressed = entry.day === currentDay;
                    return (
                      <button
                        key={entry.day}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setActiveMapDay(entry.day)}
                        className={cn(
                          'num inline-flex min-h-11 items-center rounded-full px-3 text-xs font-extrabold sm:min-h-9',
                          pressed ? 'bg-ink text-white' : 'bg-canvas text-ink-2'
                        )}
                      >
                        第{entry.number}天
                      </button>
                    );
                  })}
                </div>
              )}
              <div className="h-72 sm:h-80">
                <Suspense fallback={<div className="grid h-full place-items-center text-sm text-muted">地图加载中…</div>}>
                  <RouteMap
                    city={routebook.city}
                    routeLegs={routebook.routeLegs}
                    days={mapDayEntries}
                    activeDay={activeMapDay || mapDayEntries[0]?.day}
                    selectedId={detailStop?.id ?? null}
                    onSelect={(stopId) => {
                      const found = stops.find((s) => String(s.id) === String(stopId));
                      if (found) setDetailStop(found);
                    }}
                  />
                </Suspense>
              </div>
            </div>
          )}
          {days.map((day, dayIndex) => {
            const theme = dayTheme(dayIndex);
            const dayStops = stops.filter((stop) => stop.day === day);
            if (!dayStops.length) return null;
            return (
              <div key={day} className="mt-4">
                <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-extrabold text-white" style={{ background: theme.ink }}>
                  {day}
                </span>
                <ol className="mt-2.5 grid gap-2.5">
                  {dayStops.map((stop, index) => {
                    const stopTrust = getStopTrustState(stop, trustState.tone);
                    return (
                      <li
                        key={stop.id ?? `${day}-${index}`}
                        onClick={() => setDetailStop(stop)}
                        className="flex cursor-pointer gap-3 rounded-card border border-line bg-white p-3 shadow-card transition-shadow hover:shadow-pop"
                      >
                        <StopThumb stop={stop} number={index + 1} color={theme.ink} compact className="size-16 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                setDetailStop(stop);
                              }}
                              className="inline-flex min-h-11 items-center text-left text-copy font-extrabold hover:text-primary-strong sm:min-h-0"
                            >
                              {stop.name}
                            </button>
                            <span
                              className={cn(
                                'shrink-0 rounded-full px-2 py-0.5 text-xs font-bold',
                                stopTrust.tone === 'verified'
                                  ? 'bg-success-soft text-success-ink'
                                  : stopTrust.tone === 'trial'
                                    ? 'bg-lemon-soft text-lemon-ink'
                                    : 'bg-sky-soft text-sky-ink'
                              )}
                            >
                              {stopTrust.value}
                            </span>
                          </div>
                          <p className="num mt-0.5 text-xs font-semibold text-muted">
                            {[stop.time, formatStayText(stop.stay), costDisplay(stop).pending ? '' : costDisplay(stop).text].filter(Boolean).join(' · ')}
                          </p>
                          {(state.enrichedFacts ?? [])
                            .filter((fact) => fact.stopName === stop.name)
                            .map((fact) => (
                              <div key={fact.field} className="mt-1" data-testid="share-enriched-fact">
                                <p className="text-meta font-semibold text-success-ink">已核对 · {fact.display}</p>
                                <ConditionNotes conditions={fact.conditions} className="ml-0" />
                              </div>
                            ))}
                          {stop.verify && <p className="mt-1 text-meta text-ink-2">{stop.verify}</p>}
                          {isUnlistedCompanion && (
                            <div
                              className="mt-2 flex flex-wrap items-center gap-1.5"
                              role="group"
                              aria-label={`${stop.name} 同行表态`}
                              onClick={(event) => event.stopPropagation()}
                            >
                              {[
                                { key: 'want', label: '想去' },
                                { key: 'ok', label: '都可以' },
                                { key: 'skip', label: '先不去' }
                              ].map((opt) => {
                                const stopKey = String(stop.id ?? stop.name ?? '');
                                const active = companionState.votes?.[stopKey] === opt.key;
                                return (
                                  <button
                                    key={opt.key}
                                    type="button"
                                    aria-pressed={active}
                                    onClick={() => toggleCompanionVote(stop, opt.key)}
                                    className={cn(
                                      'min-h-11 rounded-full border px-2.5 text-xs font-bold sm:min-h-8',
                                      active
                                        ? opt.key === 'want'
                                          ? 'border-primary-strong bg-primary-strong text-white'
                                          : 'border-ink bg-ink text-white'
                                        : 'border-line-strong bg-canvas text-ink-2 hover:bg-line'
                                    )}
                                  >
                                    {opt.label}
                                  </button>
                                );
                              })}
                              {(() => {
                                const stopKey = String(stop.id ?? stop.name ?? '');
                                const visitedByMe = (companionState.visitedStopIds ?? []).includes(stopKey);
                                const groupRow = companionGroup?.byStopKey?.get(stopKey);
                                return (
                                  <>
                                    <button
                                      type="button"
                                      aria-pressed={visitedByMe}
                                      onClick={() => toggleCompanionVisited(stop)}
                                      className={cn(
                                        'inline-flex min-h-11 items-center gap-1 rounded-full border px-2.5 text-xs font-bold sm:min-h-8',
                                        visitedByMe
                                          ? 'border-success-ink bg-success-soft text-success-ink'
                                          : 'border-line-strong bg-white text-muted hover:bg-canvas'
                                      )}
                                    >
                                      {visitedByMe && <Check className="size-3" aria-hidden="true" />}
                                      已到这站
                                    </button>
                                    {groupRow?.visitedNames?.length > 0 && (
                                      <span className="text-xs font-semibold text-success-ink">已到：{groupRow.visitedNames.join('、')}</span>
                                    )}
                                  </>
                                );
                              })()}
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            );
          })}
        </section>

        <aside className="grid content-start gap-4">
          <div className="hidden rounded-panel border border-line bg-white p-4 shadow-card lg:block">
            <ShareActions
              isUnlisted={isUnlistedCompanion}
              actionState={actionState}
              busy={busy}
              onUse={useRoutebookNow}
              onSave={saveToMyRoutebooks}
              onCustomize={() => {
                trackEvent('share_copy', 'customize');
                onCustomize(routebook, { surface: 'public-share' });
              }}
              onCopy={copyShareText}
            />
          </div>
          {visibleMetrics.length > 0 && (
            <section className="rounded-panel border border-line bg-white p-4">
              <h2 className="text-copy font-extrabold">可信依据</h2>
              {filledMetrics.length > 0 && (
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  {filledMetrics.map((metric) => (
                    <div key={metric.label} className="rounded-tile bg-canvas p-2.5">
                      <dt className="text-xs text-muted">{metric.label}</dt>
                      <dd className="num text-base font-extrabold">{metric.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {pendingMetrics.length > 0 && (
                <p className="mt-2.5 text-meta leading-relaxed text-muted">
                  <span className="mr-1.5 inline-block size-1.5 rounded-full bg-warn align-middle" aria-hidden="true" />
                  {filledMetrics.length ? '其余数据要等有人走过并打卡后显示。' : '还没人照着走过。走过的人打卡后，这里会显示真实评分。'}
                </p>
              )}
            </section>
          )}
          {(routebook.validations ?? []).length > 0 &&
            (() => {
              const sortedChecks = sortValidationsByPriority((routebook.validations ?? []).slice(0, 9));
              const { warnCount } = summarizeValidationCounts(sortedChecks);
              return (
                <section className="rounded-panel border border-line bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <h2 className="text-copy font-extrabold">出发前检查</h2>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-bold',
                        warnCount > 0 ? 'bg-warn-soft text-warn-ink' : 'bg-success-soft text-success-ink'
                      )}
                    >
                      {warnCount > 0 ? `${warnCount} 项待留意` : '常规检查正常'}
                    </span>
                  </div>
                  <ul className="mt-2.5 grid gap-2.5">
                    {sortedChecks.map((item) => {
                      const tone = validationStateTone(item.state);
                      const detail = validationFallbackDetail(item);
                      return (
                        <li key={item.id || item.label} className="text-sm">
                          <span
                            className={cn(
                              'mr-1.5 rounded-full px-2 py-0.5 text-xs font-bold',
                              tone === 'ok' ? 'bg-success-soft text-success-ink' : tone === 'sky' ? 'bg-info-soft text-info-ink' : 'bg-warn-soft text-warn-ink'
                            )}
                          >
                            {item.state}
                          </span>
                          <strong className="font-bold">{item.label}</strong>
                          {detail && <p className="mt-0.5 text-meta text-muted">{detail}</p>}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })()}
          <p className="px-1 text-xs leading-relaxed text-muted">这里只展示路线和核对结果，不转载原攻略。有人走过并打卡后，可信度会更新。</p>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <ShareActions
          compact
          isUnlisted={isUnlistedCompanion}
          actionState={actionState}
          busy={busy}
          onUse={useRoutebookNow}
          onSave={saveToMyRoutebooks}
          onCustomize={() => {
            trackEvent('share_copy', 'customize');
            onCustomize(routebook, { surface: 'public-share' });
          }}
          onCopy={copyShareText}
        />
      </div>

      {detailStop && (
        <Suspense fallback={null}>
          <PoiDetail stop={detailStop} routebook={routebook} onClose={() => setDetailStop(null)} />
        </Suspense>
      )}
    </div>
  );
}

/** @param {Record<string, any>} props */
function ShareActions({ actionState, busy, isUnlisted = false, onUse, onSave, onCustomize, onCopy, compact = false }) {
  const useLabel =
    actionState.pending === 'use' ? '正在准备出发…' : actionState.savedDraft ? '开始按路线出发' : isUnlisted ? '跟着这条路书出发' : '照着这条路线出发';
  return (
    <div className="grid gap-2">
      <Button variant="primary" size={compact ? 'md' : 'lg'} className="w-full" disabled={busy} onClick={onUse}>
        <Play /> {useLabel}
      </Button>
      {compact ? (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline" size="sm" disabled={busy} onClick={onCustomize}>
            <RefreshCw /> 改成我的
          </Button>
          {isUnlisted ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={onCopy}>
              <Copy /> 复制摘要
            </Button>
          ) : (
            <Button variant="outline" size="sm" disabled={Boolean(busy || actionState.savedDraft)} onClick={onSave}>
              <BookmarkPlus /> {actionState.savedDraft ? '已存路书' : actionState.pending === 'save' ? '保存中…' : '先存路书'}
            </Button>
          )}
        </div>
      ) : (
        <div className="grid gap-2">
          <Button variant="outline" size="sm" className="w-full" disabled={busy} onClick={onCustomize}>
            <RefreshCw /> 改成我的
          </Button>
          <div className={cn('grid gap-2', isUnlisted ? 'grid-cols-1' : 'grid-cols-2')}>
            {!isUnlisted && (
              <Button variant="outline" size="sm" disabled={Boolean(busy || actionState.savedDraft)} onClick={onSave}>
                <BookmarkPlus /> {actionState.savedDraft ? '已保存' : actionState.pending === 'save' ? '保存中…' : '只保存一份副本'}
              </Button>
            )}
            <Button variant="outline" size="sm" disabled={busy} onClick={onCopy}>
              <Copy /> 复制文字摘要
            </Button>
          </div>
        </div>
      )}
      <p
        className={cn('text-sm font-semibold [&:not(:empty)]:mt-1', actionState.isError ? 'text-danger' : 'text-ink-2')}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {actionState.message}
      </p>
    </div>
  );
}

function buildShareText(routebook) {
  const stops = routebook.stops ?? [];
  return [
    `${routebook.title}`,
    `${getRouteTrustBadgeState(routebook).compactText}｜${routebook.city}`,
    routebook.summary,
    '',
    ...stops.slice(0, 10).map((stop, index) => `${index + 1}. ${stop.time} ${stop.name}｜${stop.stay}｜${stop.cost}`),
    '',
    '由可信路书 AI 生成；有人打卡后会更新可信度。'
  ].join('\n');
}
