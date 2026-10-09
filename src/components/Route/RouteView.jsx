import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Check, Heart, List, Map as MapIcon, Navigation } from 'lucide-react';
import { recordProductExposure } from '../../lib/productTelemetry';
import { isNavigableCoordinate } from '../../lib/coordinates';
import { getProfile } from '../../lib/profile';
import { getStoredFavorites } from '../../lib/storage';
import { productsForRoutebook, useProductCards } from '../../lib/products';
import { getRouteTrustPresentation } from '../../lib/trust';
import { trustedCities } from '../../lib/content';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { Toast } from '../ui/toast';
import { useMediaQuery } from '../ui/useMediaQuery';
import { dayNumber, dayTheme } from '../visual/theme';
import RouteMap from './RouteMap';
import { roadSummary } from '../../lib/routeRoads';
import RouteHero, { MoreMenu } from './RouteHero';
import RouteStats from './RouteStats';
import DayStrip from './DayStrip';
import StopList, { MiniStopCard } from './StopList';
import { EditToolbar, RoutePreflight, RouteProducts } from './RoutePreflight';
import TrustExplanation from './TrustExplanation';
import RecheckBar from './RecheckBar';
import { buildRouteTrustState, canEditRoutebook, createDraftStop, stopKey } from './routebookModel';
import { useRoutebookActions } from './useRoutebookActions';

// Overlays only load on demand so they stay off the route page's critical path.
const SharePreview = lazy(() => import('./SharePreview'));
const PoiDetail = lazy(() => import('./PoiDetail'));
const StopEditor = lazy(() => import('./StopEditor'));

export default function RouteView({ routebook, setRoutebook, onSaved, onCustomize, onStartTrip, onBack }) {
  const profile = useMemo(() => getProfile(), []);
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [activeDay, setActiveDay] = useState(routebook.days?.[0] ?? 'Day 1');
  const [selectedId, setSelectedId] = useState(null);
  const [showShare, setShowShare] = useState(false);
  const [poiDetailStop, setPoiDetailStop] = useState(null);
  const [editingStop, setEditingStop] = useState(null);
  const [draggedStopId, setDraggedStopId] = useState(null);
  const [tileWarning, setTileWarning] = useState('');
  const [mobileView, setMobileView] = useState('list');
  const routeId = routebook.publicId || routebook.id;
  const [liked, setLiked] = useState(() => Boolean(routeId) && getStoredFavorites(profile.id).some((item) => item?.routeId === routeId));
  const exposureRef = useRef(new Set());
  const productCards = useProductCards();

  const stops = useMemo(() => routebook.stops ?? [], [routebook.stops]);
  const days = useMemo(() => (routebook.days?.length ? routebook.days : ['Day 1']), [routebook.days]);
  const routeProducts = useMemo(() => productsForRoutebook(productCards, routebook, 4), [routebook, productCards]);
  const trust = getRouteTrustPresentation(routebook);
  const canEdit = canEditRoutebook(routebook, profile.id);
  const isOwner = routebook.profileId === profile.id || routebook.creator?.id === profile.id;
  const trustState = buildRouteTrustState(trust, trustedCities.includes(routebook.city));

  const dayEntries = useMemo(
    () =>
      days.map((day, index) => {
        const dayStops = stops.filter((stop) => stop.day === day);
        const road = roadSummary(dayStops, routebook.routeLegs);
        const km = road.complete ? road.distanceKm : null;
        return {
          day,
          index,
          number: dayNumber(day, index),
          theme: dayTheme(index),
          stops: dayStops,
          label: dayLabel(dayStops, routebook.city, index),
          distanceKm: km,
          summary: `${dayStops.length} 站${road.complete ? ` · 道路 ${km.toFixed(1)} km · ${road.durationMinutes} 分钟` : dayStops.length > 1 ? ` · 道路待核验 ${road.verifiedLegs}/${road.expectedLegs}` : ''}`
        };
      }),
    [days, stops, routebook.city, routebook.routeLegs]
  );
  const activeEntry = dayEntries.find((entry) => entry.day === activeDay) ?? dayEntries[0];
  const dayStops = useMemo(() => activeEntry?.stops ?? [], [activeEntry]);

  const actions = useRoutebookActions({
    routebook,
    setRoutebook,
    onSaved,
    profile,
    canEdit,
    activeDay,
    setActiveDay,
    setSelectedId,
    setEditingStop,
    setDraggedStopId
  });
  const { shareState, setShareState } = actions;
  const dismissToast = useCallback(() => setShareState(''), [setShareState]);

  useEffect(() => {
    if (dayStops.length && !dayStops.find((s) => stopKey(s.id) === stopKey(selectedId))) {
      setSelectedId(dayStops[0]?.id ?? null);
    }
  }, [dayStops, selectedId]);

  useEffect(() => {
    if (!days.includes(activeDay)) {
      setActiveDay(days[0]);
      const firstStop = stops.find((stop) => stop.day === days[0]);
      setSelectedId(firstStop?.id ?? null);
    }
  }, [activeDay, days, stops]);

  // F19: exposure is recorded when a product card is actually on screen, once per session/route/product.
  const recordProductVisible = useCallback(
    (item, index) => {
      if (!item.analyticsReady) return;
      const exposureRouteId = routebook.publicId || routebook.id || routebook.title;
      const productId = item.id || `${item.provider}-${item.title}`;
      const key = `${exposureRouteId}:${productId}`;
      if (exposureRef.current.has(key)) return;
      exposureRef.current.add(key);
      recordProductExposure({
        profileId: profile.id,
        surface: 'route-products',
        itemType: 'product',
        itemId: productId,
        productId,
        productTitle: item.title,
        routeId: exposureRouteId,
        routeTitle: routebook.title,
        city: routebook.city,
        creatorId: routebook.creator?.id,
        sourcePosition: `product-${index + 1}`
      }).catch(() => {});
    },
    [profile.id, routebook]
  );

  // Full-screen map on phones locks page scroll; leaving desktop width resets it.
  const mapMode = !isDesktop && mobileView === 'map';
  useEffect(() => {
    if (!mapMode) return undefined;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mapMode]);

  // Keep the selected stop visible in the phone map drawer carousel.
  const carouselRef = useRef(null);
  useEffect(() => {
    if (!mapMode || selectedId == null) return;
    const card = carouselRef.current?.querySelector(`[data-stop-id="${CSS.escape(String(selectedId))}"]`);
    card?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [mapMode, selectedId]);

  const selectDay = useCallback(
    (day) => {
      setActiveDay(day);
      const first = stops.find((stop) => stop.day === day);
      setSelectedId(first?.id ?? null);
    },
    [stops]
  );

  const favorite = useCallback(() => {
    setLiked(true);
    actions.favoriteRoute();
  }, [actions]);
  const heroActions = useMemo(() => ({ ...actions, favoriteRoute: favorite }), [actions, favorite]);

  const handlers = {
    select: setSelectedId,
    detail: setPoiDetailStop,
    edit: (stop) => setEditingStop({ stop, isNew: false }),
    moveStop: actions.moveStop,
    removeStop: actions.removeStop,
    moveStopBefore: actions.moveStopBefore,
    moveStopToDayEnd: actions.moveStopToDayEnd,
    setDraggedStopId
  };

  const customize = () => onCustomize(routebook);
  const openShare = () => setShowShare(true);

  return (
    <div className="min-h-dvh bg-white pb-[calc(84px+env(safe-area-inset-bottom))] text-ink lg:pb-0">
      <RouteHero
        routebook={routebook}
        dayCount={days.length}
        stopCount={stops.length}
        trustState={trustState}
        isOwner={isOwner}
        liked={liked}
        canEdit={canEdit}
        saving={actions.saving}
        actions={heroActions}
        onBack={onBack}
        onStartTrip={onStartTrip}
        onCustomize={customize}
        onShare={openShare}
      />

      <div className="mx-auto max-w-[1376px] items-start lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,560px)] lg:gap-8 lg:px-8 lg:pt-7 lg:pb-20">
        <div className="relative z-[3] -mt-[26px] min-w-0 rounded-t-[26px] bg-white px-4 pt-[18px] pb-10 lg:mt-0 lg:rounded-none lg:p-0">
          <RouteStats routebook={routebook} trust={trust} trustState={trustState} />

          {canEdit && (
            <EditToolbar
              routebook={routebook}
              saving={actions.saving}
              variantState={actions.variantState}
              onMode={actions.applyModeReorder}
              onAddStop={() => setEditingStop({ stop: createDraftStop(routebook, activeDay), isNew: true })}
              onApplyVariant={actions.applyVariant}
            />
          )}
          {canEdit && (routebook.publishStatus || 'draft') === 'draft' && (
            <RecheckBar routebook={routebook} recheckState={actions.recheckState} onRecheck={() => actions.recheckRoute()} />
          )}

          <DayStrip city={routebook.city} dayEntries={dayEntries} activeDay={activeEntry?.day} onSelectDay={selectDay} />

          <div className="mt-6 mb-3 flex flex-wrap items-baseline justify-between gap-x-4 lg:mt-7">
            <h2 className="text-xl font-extrabold tracking-tight lg:text-2xl">
              Day {activeEntry?.number} · {activeEntry?.label}
            </h2>
            <span className="text-meta text-muted lg:text-copy">{activeEntry?.summary}</span>
          </div>
          {dayStops.length ? (
            <StopList
              stops={dayStops}
              routeLegs={routebook.routeLegs}
              theme={activeEntry.theme}
              selectedId={selectedId}
              routeTrustTone={trustState.tone}
              canEdit={canEdit}
              draggedStopId={draggedStopId}
              activeDay={activeEntry.day}
              handlers={handlers}
            />
          ) : (
            <p className="rounded-card bg-canvas p-6 text-center text-muted">这一天还没有安排站点。</p>
          )}

          <RoutePreflight routebook={routebook} />
          <RouteProducts products={routeProducts} onClick={actions.recordProductClick} onVisible={recordProductVisible} />

          <TrustExplanation routebook={routebook} />
        </div>

        {(isDesktop || mapMode) && (
          <aside className={cn(mapMode ? 'fixed inset-0 z-[1100]' : 'sticky top-[84px] h-[calc(100dvh-104px)] min-h-[520px]')} aria-label="地图">
            <div className={cn('relative isolate h-full overflow-hidden bg-[#dfeaf2]', !mapMode && 'rounded-panel shadow-pop')}>
              <RouteMap
                city={routebook.city}
                routeLegs={routebook.routeLegs}
                days={dayEntries}
                activeDay={activeEntry?.day}
                selectedId={selectedId}
                onSelect={setSelectedId}
                onTileStatus={setTileWarning}
                fitPadding={mapMode ? { topLeft: [30, 80], bottomRight: [30, 300] } : { topLeft: [40, 70], bottomRight: [40, 70] }}
              />
              <div
                className={cn(
                  'no-scrollbar absolute top-3.5 right-3.5 z-[600] flex gap-2 overflow-x-auto',
                  mapMode ? 'left-16 top-[calc(12px+env(safe-area-inset-top))]' : 'left-3.5'
                )}
              >
                {dayEntries.map((entry) => {
                  const pressed = entry.day === activeEntry?.day;
                  return (
                    <button
                      key={entry.day}
                      type="button"
                      aria-pressed={pressed}
                      onClick={() => selectDay(entry.day)}
                      className={cn(
                        'inline-flex h-[38px] shrink-0 items-center gap-2 rounded-full pr-3.5 pl-1.5 text-sm font-bold whitespace-nowrap shadow-pop',
                        pressed ? 'bg-ink text-white' : 'bg-white text-ink'
                      )}
                    >
                      <i
                        className="num grid size-[26px] place-items-center rounded-full text-meta text-white not-italic"
                        style={{ background: entry.theme.ink }}
                      >
                        {entry.number}
                      </i>
                      {entry.label}
                    </button>
                  );
                })}
              </div>
              {mapMode && (
                <Button
                  variant="light"
                  size="icon"
                  className="absolute top-[calc(12px+env(safe-area-inset-top))] left-3 z-[700] shadow-pop"
                  onClick={() => setMobileView('list')}
                  aria-label="返回列表"
                >
                  <ArrowLeft />
                </Button>
              )}
              {!mapMode && activeEntry && (
                <div className="absolute bottom-3.5 left-3.5 z-[600] flex items-center gap-3.5 rounded-2xl bg-white/95 px-3.5 py-2.5 text-sm shadow-pop">
                  <span>
                    <b className="num">{activeEntry.stops.length}</b> 站
                    {activeEntry.distanceKm >= 0.1 && (
                      <>
                        {' · '}
                        <b className="num">{activeEntry.distanceKm.toFixed(1)}</b> km
                      </>
                    )}
                  </span>
                  <span className="text-xs text-muted">
                    实线：道路核验
                    <br />
                    虚线：直线示意
                  </span>
                  {activeEntry.stops.some((stop) => !isNavigableCoordinate(stop)) && (
                    <span className="inline-flex items-center gap-1.5 text-lemon-ink">
                      <i className="inline-block w-5 border-t-[3px] border-dashed border-lemon-ink" aria-hidden="true" />
                      位置待确认
                    </span>
                  )}
                </div>
              )}
              {tileWarning && (
                <div
                  className={cn(
                    'absolute right-3.5 z-[600] max-w-[320px] rounded-xl bg-white/95 px-3 py-2 text-meta text-ink-2 shadow-card',
                    mapMode ? 'top-[calc(64px+env(safe-area-inset-top))]' : 'top-16'
                  )}
                >
                  {tileWarning}
                </div>
              )}
            </div>
          </aside>
        )}
      </div>

      {mapMode && activeEntry && (
        <div className="fixed inset-x-0 bottom-0 z-[1250] rounded-t-[26px] bg-white pt-2 pb-[calc(84px+env(safe-area-inset-bottom))] shadow-[0_-10px_30px_rgba(22,24,29,.16)]">
          <span className="mx-auto mb-2.5 block h-[5px] w-[42px] rounded-full bg-line-strong" aria-hidden="true" />
          <div className="flex items-baseline justify-between px-4 pb-2.5">
            <b className="text-lg font-extrabold">
              Day {activeEntry.number} · {activeEntry.label}
            </b>
            <span className="text-meta text-muted">{activeEntry.summary}</span>
          </div>
          <p className="px-4 pb-2 text-xs text-muted">实线为已核验道路；虚线仅直线示意，不代表道路距离和耗时。</p>
          <div ref={carouselRef} className="no-scrollbar flex snap-x snap-mandatory scroll-px-4 gap-2.5 overflow-x-auto px-4 pt-0.5 pb-1.5">
            {dayStops.map((stop, index) => (
              <MiniStopCard
                key={stop.id ?? index}
                stop={stop}
                index={index}
                theme={activeEntry.theme}
                selected={stopKey(selectedId) === stopKey(stop.id)}
                routeTrustTone={trustState.tone}
                onSelect={() => setSelectedId(stop.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Phone: list ↔ map pill + single bottom action bar */}
      {!isDesktop && (
        <>
          <button
            type="button"
            onClick={() => setMobileView(mapMode ? 'list' : 'map')}
            className={cn(
              'fixed left-1/2 z-[1300] inline-flex h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-ink px-[18px] text-copy font-bold text-white shadow-pop',
              mapMode ? 'bottom-[calc(300px+env(safe-area-inset-bottom))]' : 'bottom-[calc(90px+env(safe-area-inset-bottom))]'
            )}
          >
            {mapMode ? <List size={18} /> : <MapIcon size={18} />}
            {mapMode ? '列表' : '地图'}
          </button>
          <div className="fixed inset-x-0 bottom-0 z-[1300] flex items-center gap-2.5 border-t border-line bg-white/96 px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] backdrop-blur-md">
            <Button size="icon" className="size-[50px]" onClick={favorite} aria-label={liked ? '已收藏' : '收藏'}>
              <Heart className={cn(liked && 'animate-pop fill-current text-primary-strong')} />
            </Button>
            {canEdit ? (
              <Button size="icon" className="size-[50px]" onClick={actions.saveCurrentRoutebook} disabled={actions.saving} aria-label="保存路书">
                <Check />
              </Button>
            ) : (
              <Button size="icon" className="size-[50px]" onClick={customize} aria-label="复制并定制">
                <Copy />
              </Button>
            )}
            <MoreMenu actions={actions} onShare={openShare} onCustomize={customize} canEdit={canEdit} triggerClassName="size-[50px] bg-canvas shadow-none" />
            <Button variant="primary" size="lg" className="h-[54px] flex-1" onClick={onStartTrip}>
              <Navigation /> 开始出行
            </Button>
          </div>
        </>
      )}

      <Toast message={shareState} onDismiss={dismissToast} className="bottom-[calc(150px+env(safe-area-inset-bottom))] lg:bottom-8" />

      <Suspense fallback={null}>
        {showShare && (
          <SharePreview routebook={routebook} onClose={() => setShowShare(false)} onShared={actions.handleShared} onConflictDraftSaved={() => onSaved?.()} />
        )}
        {poiDetailStop && <PoiDetail stop={poiDetailStop} routebook={routebook} onClose={() => setPoiDetailStop(null)} />}
        {editingStop && (
          <StopEditor
            stop={editingStop.stop}
            isNew={Boolean(editingStop.isNew)}
            routebook={routebook}
            onClose={() => setEditingStop(null)}
            onSave={actions.upsertStop}
          />
        )}
      </Suspense>
    </div>
  );
}

function dayLabel(stops, city, index) {
  const areas = [];
  stops.forEach((stop) => {
    const area = String(stop.area ?? '').trim();
    if (area && area !== city && !areas.includes(area)) areas.push(area);
  });
  if (areas.length) return areas.slice(0, 2).join(' · ');
  if (stops[0]?.name) return stops.length > 1 ? `${stops[0].name} 出发` : stops[0].name;
  return `第 ${index + 1} 天`;
}
