import { costDisplay } from '../../lib/cost';
import { publicCreatorName } from '../../lib/creatorName.js';
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, BookmarkPlus, Copy, MapPin, Play, RefreshCw, Sparkles, UserRound } from 'lucide-react';
import { getShareRoutebook, recordExposure } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { getRouteTrustBadgeState, getStopTrustState, maskTrustMetrics } from '../../lib/trust';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { TrustChip } from '../cards/TrustChip';
import { CityBackdrop } from '../visual/CityBackdrop';
import { StopThumb } from '../visual/StopThumb';
import { dayTheme } from '../visual/theme';
import AigcChip from './AigcChip';
import { ConditionNotes } from './EnrichedFacts';
import { trackEvent } from '../../lib/betaTelemetry.js';
import { UNVERIFIED_CITY_NOTE, isUnverifiedCity } from './RouteStats';

/** @param {Record<string, any>} props */
export default function PublicSharePage({ publicId, onBack, onSave, onUse, onCustomize, onOpenCreator }) {
  const [state, setState] = useState(
    /** @type {{ loading: boolean, error: string, routebook: any, enrichedFacts?: any[] }} */ ({ loading: true, error: '', routebook: null })
  );
  const [actionState, setActionState] = useState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
  const [summaryOpen, setSummaryOpen] = useState(false);
  const exposureRef = useRef('');

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', routebook: null });
    setActionState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
    // Unlisted friend links carry their key as ?k=; it is only sent back to the share API.
    const friendKey = new URLSearchParams(window.location.search).get('k') || '';
    getShareRoutebook(publicId, ctrl.signal, friendKey)
      .then((data) => {
        const routebook = data.routebook?.visibility === 'unlisted' ? { ...data.routebook, shareKey: friendKey } : data.routebook;
        if (!ctrl.signal.aborted)
          setState({ loading: false, error: '', routebook, enrichedFacts: Array.isArray(data.enrichedFacts) ? data.enrichedFacts : [] });
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: error.message, routebook: null });
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
          <h1 className="mt-3 text-xl font-extrabold">这条分享暂时打不开</h1>
          <p className="mt-1 text-sm text-muted">{state.error || '链接不存在或已失效'}</p>
          <Button variant="outline" className="mt-4" onClick={onBack}>
            <ArrowLeft /> 返回首页
          </Button>
        </div>
      </div>
    );
  }

  const routebook = state.routebook;
  const stops = routebook.stops ?? [];
  const days = routebook.days ?? ['Day 1'];
  const trustState = getRouteTrustBadgeState(routebook);
  const visibleMetrics = maskTrustMetrics(routebook.metrics, trustState.tone, 6);
  // Metrics without data yet collapse into one quiet line instead of a grid of "待验证" tiles.
  const isPendingMetric = (metric) => /^(待验证|待复核|暂无|—|-|)$/.test(String(metric.value ?? '').trim());
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
        : `已存在这台设备上，云端暂未同步：${result.syncError || '网络不可用'}`;
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
    <div className="page-enter pb-44 lg:pb-16">
      <section className="relative isolate overflow-hidden bg-[#1c2230] text-white">
        <CityBackdrop city={routebook.city} />
        <div
          className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.35)_0%,rgba(10,12,16,.1)_40%,rgba(10,12,16,.82)_100%)]"
          aria-hidden="true"
        />
        <div className="mx-auto flex min-h-[340px] max-w-[1200px] flex-col justify-between gap-6 px-4 pt-5 pb-8 lg:min-h-[400px] lg:px-8 lg:pb-10">
          <Button variant="glass" size="sm" className="self-start" onClick={onBack}>
            <ArrowLeft /> 返回平台
          </Button>
          <div className="max-w-3xl">
            <div className="flex flex-wrap items-center gap-2">
              <TrustChip routebook={routebook} className="bg-white/95" />
              <AigcChip routebook={routebook} />
              {routebook.visibility === 'unlisted' && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-bold backdrop-blur"
                  title="作者通过朋友链接分享，未公开发布，也不会被搜索引擎收录"
                >
                  朋友链接 · 未公开
                </span>
              )}
              <span className="inline-flex items-center gap-1 rounded-full bg-black/30 px-2.5 py-1 text-xs font-bold backdrop-blur">
                <MapPin className="size-3.5" aria-hidden="true" /> {routebook.city} · {days.length} 天 · {stops.length} 站
              </span>
              {isUnverifiedCity(routebook.city) && (
                <span
                  className="inline-flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-xs font-bold backdrop-blur"
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
                <p id="share-summary" className={cn('mt-2 max-w-2xl text-copy text-white/90', !summaryOpen && 'max-sm:line-clamp-3')}>
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
                className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/15 py-1 pr-3 pl-1 text-sm font-semibold backdrop-blur hover:bg-white/25"
                onClick={() => onOpenCreator?.(routebook.creator.id)}
              >
                <span className="grid size-7 place-items-center rounded-full bg-lemon text-ink">
                  <UserRound className="size-4" aria-hidden="true" />
                </span>
                {publicCreatorName(routebook.creator.name)}
                <span className="text-white/80">· {routebook.copyCount ?? 0} 次复制</span>
              </button>
            )}
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-[1200px] grid-cols-[minmax(0,1fr)] gap-6 px-4 pt-6 lg:grid-cols-[minmax(0,1fr)_360px] lg:px-8 lg:pt-8">
        <section aria-labelledby="share-structure">
          <h2 id="share-structure" className="text-xl font-extrabold">
            路线安排
          </h2>
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
                      <li key={stop.id ?? `${day}-${index}`} className="flex gap-3 rounded-card border border-line bg-white p-3 shadow-card">
                        <StopThumb stop={stop} number={index + 1} color={theme.ink} compact className="size-16 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-start justify-between gap-2">
                            <strong className="text-copy font-extrabold">{stop.name}</strong>
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
                            {[stop.time, stop.stay, costDisplay(stop).text].filter(Boolean).join(' · ')}
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
                  待验证：{pendingMetrics.map((metric) => metric.label).join('、')}（有人走过并打卡后显示）
                </p>
              )}
            </section>
          )}
          {(routebook.validations ?? []).length > 0 && (
            <section className="rounded-panel border border-line bg-white p-4">
              <h2 className="text-copy font-extrabold">出发前检查</h2>
              <ul className="mt-2 grid gap-2.5">
                {(routebook.validations ?? []).slice(0, 6).map((item) => (
                  <li key={item.id} className="text-sm">
                    <span className="mr-1.5 rounded-full bg-warn-soft px-2 py-0.5 text-xs font-bold text-warn-ink">{item.state}</span>
                    <strong className="font-bold">{item.label}</strong>
                    {item.detail && <p className="mt-0.5 text-meta text-muted">{item.detail}</p>}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="px-1 text-xs leading-relaxed text-muted">这里只展示路线和核对结果，不转载原攻略。有人走过并打卡后，可信度会更新。</p>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/95 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <ShareActions
          compact
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
    </div>
  );
}

/** @param {Record<string, any>} props */
function ShareActions({ actionState, busy, onUse, onSave, onCustomize, onCopy, compact = false }) {
  const useLabel = actionState.pending === 'use' ? '正在保存副本...' : actionState.savedDraft ? '用已保存的副本出发' : '保存副本并出发';
  return (
    <div className="grid gap-2">
      <Button variant="primary" size={compact ? 'md' : 'lg'} className="w-full" disabled={busy} onClick={onUse}>
        <Play /> {useLabel}
      </Button>
      <div className={cn('grid gap-2', compact ? 'grid-cols-3' : 'grid-cols-1')}>
        <Button variant="outline" size="sm" disabled={Boolean(busy || actionState.savedDraft)} onClick={onSave}>
          <BookmarkPlus /> {actionState.savedDraft ? '已保存' : actionState.pending === 'save' ? '保存中...' : compact ? '只保存' : '只保存一份副本'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCustomize}>
          <RefreshCw /> {compact ? '定制' : '按我的喜好定制'}
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={onCopy}>
          <Copy /> {compact ? '复制' : '复制文字摘要'}
        </Button>
      </div>
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
