import React, { useState, useMemo, useEffect, useRef } from 'react';
import L from 'leaflet';
import { ArrowLeft, Navigation, Share2, Shield, Clock, DollarSign, AlertTriangle, Check, Copy, RefreshCw, Trash2, ArrowUp, ArrowDown, Umbrella, Footprints, Baby, WalletCards, Ticket, Info, Plus, Pencil, GripVertical, X, Star } from 'lucide-react';
import { cityCenters, coordinateForName, coordinateReviewLabel, isNavigableCoordinate, isValidCoordinate, routeLegLabel } from '../../lib/coordinates';
import { clickStorageKey, getStoredRoutebookById, saveFavorite, saveRoutebook, safeWriteJsonStorage } from '../../lib/storage';
import { copyRoutebookRemote, createFavorite, getJson, getRoutebookRemote, recordClick, recordExposure, recordJourneyEvent, saveRoutebookRemote, saveRoutebookVariant } from '../../lib/api';
import { getProfile, profileRoutebookFields } from '../../lib/profile';
import { downloadTripIcs, requestTripNotification } from '../../lib/reminders';
import { isExternalSearchEntry, productsForRoutebook, useProductCards } from '../../lib/products';
import { PUBLIC_TRUST_SAMPLE_THRESHOLD, formatVerifiedDate, getRouteTrustPresentation, getStopTrustBadge } from '../../lib/trust';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { trustedCities } from '../../lib/content';
import { preserveRoutebookConflictDraft } from '../../lib/routebookConflict';
import { modeSlug, orderedDays, reorderStopsByMode, variantSummary } from '../../lib/routeModes';
import SharePreview from './SharePreview';
import PoiDetail from './PoiDetail';

export default function RouteView({ routebook, setRoutebook, onSaved, onCustomize, onStartTrip, onBack }) {
  const profile = useMemo(() => getProfile(), []);
  const [activeDay, setActiveDay] = useState(routebook.days?.[0] ?? 'Day 1');
  const [selectedId, setSelectedId] = useState(null);
  const [shareState, setShareState] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [poiDetailStop, setPoiDetailStop] = useState(null);
  const [editingStop, setEditingStop] = useState(null);
  const [draggedStopId, setDraggedStopId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [variantState, setVariantState] = useState('');
  const [tileWarning, setTileWarning] = useState('');
  const exposureRef = useRef(new Set());
  const routebookSyncSequenceRef = useRef(0);
  // 本地是否有尚未同步到服务端的编辑（删除/拖拽/替换等只写 localStorage 的操作）。
  const localEditsDirtyRef = useRef(hasUnsyncedLocalEdits(routebook));
  const latestRoutebookRef = useRef(routebook);
  latestRoutebookRef.current = routebook;
  const productCards = useProductCards();

  const stops = routebook.stops ?? [];
  const dayStops = useMemo(() => stops.filter(s => s.day === activeDay), [stops, activeDay]);
  const routeProducts = useMemo(() => productsForRoutebook(productCards, routebook, 4), [routebook, productCards]);
  const trustMetrics = useMemo(() => buildTrustMetrics(routebook), [routebook]);
  const trust = getRouteTrustPresentation(routebook);
  const canEdit = canEditRoutebook(routebook, profile.id);
  const isTrustedCity = trustedCities.includes(routebook.city);
  const trustState = buildRouteTrustState(trust, isTrustedCity);
  const TrustStateIcon = trustState.tone === 'trial' ? AlertTriangle : Shield;

  useEffect(() => {
    if (dayStops.length && !dayStops.find(s => stopKey(s.id) === stopKey(selectedId))) {
      setSelectedId(dayStops[0]?.id ?? null);
    }
  }, [dayStops, selectedId]);

  useEffect(() => {
    const nextDays = routebook.days?.length ? routebook.days : ['Day 1'];
    if (!nextDays.includes(activeDay)) {
      setActiveDay(nextDays[0]);
      const firstStop = (routebook.stops ?? []).find((stop) => stop.day === nextDays[0]);
      setSelectedId(firstStop?.id ?? null);
    }
  }, [activeDay, routebook.days, routebook.publicId, routebook.id, routebook.stops]);

  useEffect(() => {
    const routeId = routebook.publicId || routebook.id || routebook.title;
    routeProducts.forEach((item, index) => {
      if (!item.analyticsReady) return;
      const productId = item.id || `${item.provider}-${item.title}`;
      const key = `${routeId}:${productId}`;
      if (exposureRef.current.has(key)) return;
      exposureRef.current.add(key);
      recordExposure({
        profileId: profile.id,
        surface: 'route-products',
        itemType: 'product',
        itemId: productId,
        productId,
        productTitle: item.title,
        routeId,
        routeTitle: routebook.title,
        city: routebook.city,
        creatorId: routebook.creator?.id,
        sourcePosition: `product-${index + 1}`
      }).catch(() => {});
    });
  }, [profile.id, routeProducts, routebook]);

  return (
    <div className="route-layout page-enter">
      {/* Left: Map */}
      <div className="route-map-area">
        <RouteMap city={routebook.city} stops={dayStops} selectedId={selectedId} onSelect={setSelectedId} onTileStatus={setTileWarning} />
        <div className="route-map-overlay-top">
          <button className="btn btn-secondary btn-sm" onClick={onBack}><ArrowLeft size={14} /> 返回</button>
        </div>
        {tileWarning && <div className="route-map-warning">{tileWarning}</div>}
        <div className="route-map-overlay-bottom">
          <div className={`trust-badge-large trust-${trustState.tone}`}>
            <TrustStateIcon size={16} />
            <span>{trustState.shortLabel}</span>
            <strong>{trustState.value}</strong>
          </div>
        </div>
      </div>

      {/* Right: Panel */}
      <aside className="route-panel">
        <div className="route-panel-header route-cover-card">
          <span className={`badge ${trustState.badgeClass}`}><TrustStateIcon size={12} /> {trustState.label}</span>
          <h1 className="text-title">{routebook.title}</h1>
          <p className="text-caption" style={{ marginTop: 4 }}>{routebook.summary}</p>
          <div className="route-quick-facts">
            <span>{stops.length} 个站点</span>
            <span>{routebook.days?.length ?? 1} 天</span>
            <span>{routebook.city}</span>
          </div>
        </div>

        <section className={`trust-panel trust-${trustState.tone}`} aria-label="路线可信状态">
          <div>
            <span className="text-caption">{trustState.tone === 'verified' ? '路线可信分' : '路线状态'}</span>
            <strong>{trustState.value}</strong>
            <small>{trustState.note}</small>
          </div>
          <div className="trust-metric-grid">
            {trustMetrics.map((metric) => (
              <span key={metric.label}>
                <b>{metric.value}</b>
                {metric.label}
              </span>
            ))}
          </div>
        </section>

        {(routebook.sourceSummary?.sourceCount > 0 || routebook.feedbackSummary) && (
          <section className="evidence-panel">
            {routebook.sourceSummary?.sourceCount > 0 && (
              <div>
                <h3><Shield size={14} /> 导入来源分析</h3>
                <p>{routebook.sourceSummary.sourceCount} 条导入来源，来源预测均分 {predictionAverage(routebook.sourceSummary)}，仅作解析参考，不代表真实到访验证。{Array.isArray(routebook.sourceSummary.platforms) && routebook.sourceSummary.platforms.filter(Boolean).length ? `平台：${routebook.sourceSummary.platforms.filter(Boolean).join('、')}。` : ''}</p>
                {routebook.sourceSummary.warnings?.slice(0, 2).map((warning, index) => <span key={index} className="badge badge-orange">{warning}</span>)}
              </div>
            )}
            {routebook.feedbackSummary && (
              <div>
                <h3><Check size={14} /> 真实反馈</h3>
                <p>真实反馈 {routebook.feedbackSummary.attestedCheckinCount || 0} 次，有效 GPS 到达率 {routebook.feedbackSummary.completionRate || 0}%，踩坑率 {routebook.feedbackSummary.pitfallRate || 0}%，纠错 {routebook.feedbackSummary.correctionCount || 0} 条。</p>
                {routebook.trustMeta && <span className="badge badge-blue">AI {Math.round((routebook.trustMeta.aiWeight ?? 1) * 100)}% / 反馈 {Math.round((routebook.trustMeta.feedbackWeight ?? 0) * 100)}%</span>}
              </div>
            )}
          </section>
        )}

        {canEdit && (
          <div className="route-toolstrip" aria-label="路书编辑工具">
            <button className="btn btn-secondary btn-sm" onClick={() => applyModeReorder('少走路')} disabled={saving}><Footprints size={14} /> 少走路</button>
            <button className="btn btn-secondary btn-sm" onClick={() => applyModeReorder('雨天')} disabled={saving}><Umbrella size={14} /> 雨天</button>
            <button className="btn btn-secondary btn-sm" onClick={() => applyModeReorder('低预算')} disabled={saving}><WalletCards size={14} /> 低预算</button>
            <button className="btn btn-secondary btn-sm" onClick={() => applyModeReorder('亲子')} disabled={saving}><Baby size={14} /> 亲子</button>
            <button className="btn btn-primary btn-sm" onClick={() => setEditingStop({ stop: createDraftStop(routebook, activeDay), isNew: true })}><Plus size={14} /> 加站点</button>
          </div>
        )}
        {canEdit && (routebook.variants?.length > 0 || variantState) && (
          <section className="variant-panel">
            <div className="variant-panel-head">
              <h3>路线变体</h3>
              {variantState && <span className="text-micro">{variantState}</span>}
            </div>
            <div className="variant-list">
              {(routebook.variants ?? []).slice(0, 4).map((variant) => (
                <button
                  key={variant.id}
                  className={`variant-card ${routebook.activeVariantId === variant.id ? 'active' : ''}`}
                  onClick={() => applyVariant(variant)}
                >
                  <strong>{variant.label}</strong>
                  <span>{variant.summary}</span>
                  <small>{variant.stops?.length ?? 0} 站 · 预测参考 · 待验证</small>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Day tabs */}
        <div className="day-tabs">
          {(routebook.days ?? ['Day 1']).map(day => (
            <button key={day} className={`chip ${activeDay === day ? 'active' : ''}`} onClick={() => setActiveDay(day)}>
              {day}
            </button>
          ))}
        </div>

        {/* Stops timeline */}
        <div className="stops-timeline">
          {dayStops.map((stop, idx) => (
            <StopCard
              key={stop.id ?? idx}
              stop={stop}
              index={idx}
              isSelected={stopKey(selectedId) === stopKey(stop.id)}
              onSelect={() => setSelectedId(stop.id)}
              onDelete={() => removeStop(stop.id)}
              onMoveUp={() => moveStop(stop.id, -1)}
              onMoveDown={() => moveStop(stop.id, 1)}
              onDetail={() => setPoiDetailStop(stop)}
              onEdit={() => setEditingStop({ stop, isNew: false })}
              onDragStart={() => setDraggedStopId(stop.id)}
              onDragEnd={() => setDraggedStopId(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveStopBefore(draggedStopId, stop.id)}
              nextStop={dayStops[idx + 1]}
              routeTrustTone={trustState.tone}
              isLast={idx === dayStops.length - 1}
              canMoveUp={idx > 0}
              canMoveDown={idx < dayStops.length - 1}
              canEdit={canEdit}
            />
          ))}
          {canEdit && draggedStopId && (
            <div
              className="stop-drop-end"
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => moveStopToDayEnd(draggedStopId, activeDay)}
              style={{ border: '1px dashed var(--blue)', borderRadius: 8, padding: '10px 12px', textAlign: 'center', fontSize: 12, color: 'var(--blue)' }}
            >
              拖到这里，移动到 {activeDay} 最后
            </div>
          )}
        </div>

        {/* Validations */}
        {routebook.validations?.length > 0 && (
          <div style={{ marginTop: 20 }}>
            <h3 className="text-caption" style={{ fontWeight: 600, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em' }}>可执行校验</h3>
            <div className="validation-list">
              {routebook.validations.slice(0, 4).map(v => (
                <div key={v.id} className="card-flat validation-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong className="text-body" style={{ fontSize: 13, fontWeight: 600 }}>{v.label}</strong>
                    <span className="badge badge-orange" style={{ fontSize: 11 }}>{v.state}</span>
                  </div>
                  <p className="text-caption" style={{ marginTop: 4 }}>{v.detail}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {routeProducts.length > 0 && (
          <section className="route-products">
            <h3 className="text-caption" style={{ fontWeight: 700 }}>相关商品卡</h3>
            <div className="product-list">
              {routeProducts.map((item, index) => (
                <button key={item.id || item.url || `${item.provider}-${item.title}-${index}`} className="product-card" onClick={() => recordProductClick(item)}>
                  <span className="badge badge-blue"><Ticket size={11} /> {item.type}</span>
                  <strong>{item.title}</strong>
                  <small>{item.poi} · {item.price} · {productLinkLabel(item)}</small>
                </button>
              ))}
            </div>
          </section>
        )}

        <section className="feedback-panel">
          <h3>用户打卡反馈</h3>
          <p>近 30 天有效 GPS 到达率、修改率和踩坑反馈会影响可信分。AI 新生成路线会标记为预测可信度，直到真实打卡足够。</p>
        </section>

        {/* Actions */}
        <div className="route-actions">
          <button className="btn btn-green btn-lg" style={{ flex: 1 }} onClick={onStartTrip}>
            <Navigation size={18} /> 开始行中
          </button>
          {canEdit && (
            <button className="btn btn-secondary btn-lg" onClick={saveCurrentRoutebook} disabled={saving}>
              <Check size={18} /> {saving ? '保存中' : '保存'}
            </button>
          )}
        </div>
        <div className="route-secondary-actions">
          <button className="btn btn-secondary btn-sm" onClick={copyRoute}><Copy size={14} /> 复制</button>
          <button className="btn btn-secondary btn-sm" onClick={favoriteRoute}><Star size={14} /> 收藏</button>
          <button className="btn btn-secondary btn-sm" onClick={saveTripReminder}><Clock size={14} /> 出行提醒</button>
          <button className="btn btn-secondary btn-sm" onClick={() => onCustomize(routebook)}><RefreshCw size={14} /> 定制版</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowShare(true)}><Share2 size={14} /> 分享</button>
        </div>
        {shareState && <p className="text-caption" style={{ textAlign: 'center' }}>{shareState}</p>}

        {showShare && <SharePreview routebook={routebook} onClose={() => setShowShare(false)} onShared={handleShared} onConflictDraftSaved={() => onSaved?.()} />}
        {poiDetailStop && <PoiDetail stop={poiDetailStop} routebook={routebook} onClose={() => setPoiDetailStop(null)} />}
        {editingStop && (
          <StopEditor
            stop={editingStop.stop}
            isNew={Boolean(editingStop.isNew)}
            routebook={routebook}
            onClose={() => setEditingStop(null)}
            onSave={upsertStop}
          />
        )}
      </aside>
    </div>
  );

  // base 默认取渲染闭包里的 routebook；异步回调（如改名坐标重校验）应显式传
  // latestRoutebookRef.current，避免用过期闭包覆盖用户后续编辑。
  function updateRoutebook(nextStops, extra = {}, base = routebook) {
    if (!canEdit) {
      setShareState('公开路线为只读，请先生成定制版再编辑');
      return;
    }
    const normalizedStops = nextStops.map((stop) => ({ ...stop, id: stableStopId(stop.id) }));
    const next = {
      ...base,
      ...extra,
      stops: normalizedStops,
      days: orderedDays(normalizedStops, base.days),
      trustScore: calculateLocalTrustScore(normalizedStops),
      trustMeta: {
        predictionScore: calculateLocalTrustScore(normalizedStops),
        displayScore: null,
        source: 'prediction',
        label: '预测可信度 · 待真实验证',
        sampleCount: base.trustMeta?.sampleCount ?? 0,
        aiWeight: 1,
        feedbackWeight: 0
      },
      metrics: buildEditedMetrics(normalizedStops, base.metrics),
      validations: buildEditedValidations(normalizedStops, extra.validations ?? base.validations, extra.editReason),
      provider: {
        ...(base.provider ?? {}),
        editedAt: new Date().toISOString()
      }
    };
    routebookSyncSequenceRef.current += 1;
    latestRoutebookRef.current = next;
    localEditsDirtyRef.current = true;
    setRoutebook(next);
    const localSaved = saveRoutebook(next);
    if (!localSaved) setShareState('本地存储失败，请保持当前页面并尽快重试保存');
    onSaved?.(next);
  }

  function removeStop(stopId) {
    const nextStops = stops.filter((stop) => stopKey(stop.id) !== stopKey(stopId));
    if (nextStops.length < 2) {
      setShareState('路书至少需要保留 2 个站点，无法继续删除');
      return;
    }
    updateRoutebook(nextStops);
  }

  function moveStop(stopId, direction) {
    const dayIndexes = stops.reduce((indexes, stop, index) => stop.day === activeDay ? [...indexes, index] : indexes, []);
    const dayPosition = dayIndexes.findIndex((index) => stopKey(stops[index].id) === stopKey(stopId));
    const targetPosition = dayPosition + direction;
    if (dayPosition < 0 || targetPosition < 0 || targetPosition >= dayIndexes.length) return;
    const index = dayIndexes[dayPosition];
    const target = dayIndexes[targetPosition];
    const nextStops = [...stops];
    [nextStops[index], nextStops[target]] = [nextStops[target], nextStops[index]];
    updateRoutebook(nextStops);
  }

  function moveStopBefore(sourceId, targetId) {
    if (!sourceId || !targetId || stopKey(sourceId) === stopKey(targetId)) return;
    const sourceIndex = stops.findIndex((stop) => stopKey(stop.id) === stopKey(sourceId));
    const targetIndex = stops.findIndex((stop) => stopKey(stop.id) === stopKey(targetId));
    if (sourceIndex < 0 || targetIndex < 0) return;
    const nextStops = [...stops];
    const [moved] = nextStops.splice(sourceIndex, 1);
    const nextTargetIndex = nextStops.findIndex((stop) => stopKey(stop.id) === stopKey(targetId));
    nextStops.splice(nextTargetIndex, 0, moved);
    setDraggedStopId(null);
    updateRoutebook(nextStops, { editReason: '拖拽排序' });
  }

  function moveStopToDayEnd(sourceId, day) {
    if (!sourceId) return;
    const sourceIndex = stops.findIndex((stop) => stopKey(stop.id) === stopKey(sourceId));
    if (sourceIndex < 0) return;
    const lastDayIndex = stops.reduce((last, stop, index) => (stop.day || 'Day 1') === day ? index : last, -1);
    setDraggedStopId(null);
    if (sourceIndex === lastDayIndex) return;
    const nextStops = [...stops];
    const [moved] = nextStops.splice(sourceIndex, 1);
    const insertIndex = nextStops.reduce((last, stop, index) => (stop.day || 'Day 1') === day ? index : last, -1) + 1;
    nextStops.splice(insertIndex, 0, { ...moved, day });
    updateRoutebook(nextStops, { editReason: '拖拽排序' });
  }

  function upsertStop(nextStop) {
    const preparedId = stableStopId(nextStop.id);
    const existingStop = stops.find((stop) => stableStopId(stop.id) === preparedId);
    const isNew = !existingStop;
    const coordinatesEdited = isNew || coordinatesChanged(existingStop, nextStop);
    // 站点换名但坐标未被手动改动时，旧坐标不再可信：先乐观降级并暂停导航，
    // 随即异步调服务端 /pois/resolve 重校验；前端本地目录只作离线兜底提示，不再据此开导航。
    const renamed = !coordinatesEdited && String(existingStop?.name ?? '').trim() !== String(nextStop?.name ?? '').trim();
    const prepared = {
      ...nextStop,
      id: preparedId,
      score: Number(nextStop.score) || 78,
      lat: Number(nextStop.lat) || cityCenters[routebook.city]?.lat || 35.8617,
      lng: Number(nextStop.lng) || cityCenters[routebook.city]?.lng || 104.1954,
      geoConfidence: coordinatesEdited ? 45 : (Number(nextStop.geoConfidence) || 55),
      coordinateSystem: 'WGS84',
      ...(coordinatesEdited || renamed ? {
        coordinateSource: 'user-edit',
        coordinatePrecision: 'approximate',
        coordinateRadiusMeters: 1500,
        navigationDisabled: true
      } : {}),
      ...(renamed ? { geoConfidence: 30 } : {})
    };
    if (renamed) {
      setShareState(coordinateForName(prepared.name, routebook.city)
        ? `「${prepared.name}」坐标待确认，导航已暂停；本地目录有参考坐标，正在向服务端确认`
        : `「${prepared.name}」坐标待确认，导航已暂停，正在向服务端匹配可信坐标`);
    }
    const nextStops = isNew
      ? [...stops, prepared]
      : stops.map((stop) => stableStopId(stop.id) === prepared.id ? prepared : stop);
    updateRoutebook(nextStops, { editReason: isNew ? '添加站点' : '替换站点' });
    setActiveDay(prepared.day || activeDay);
    setSelectedId(prepared.id);
    setEditingStop(null);
    if (renamed) resolveRenamedStopCoordinate(prepared);
  }

  // 改名站点走服务端可信 POI 目录（seed + 运营 approved）重校验：
  // 命中则升级为服务端坐标并恢复导航；请求失败或未命中时静默保持降级。
  async function resolveRenamedStopCoordinate(stop) {
    const stopId = stopKey(stop?.id);
    const name = String(stop?.name ?? '').trim();
    const city = String(latestRoutebookRef.current?.city ?? routebook.city ?? '').trim();
    if (!stopId || !name) return;
    try {
      const data = await getJson(`/pois/resolve?city=${encodeURIComponent(city)}&name=${encodeURIComponent(name)}`);
      const poi = data?.poi;
      if (!poi?.matched || !isValidCoordinate(Number(poi.lat), Number(poi.lng))) return;
      const current = latestRoutebookRef.current;
      const currentStops = Array.isArray(current?.stops) ? current.stops : [];
      const target = currentStops.find((item) => stopKey(item.id) === stopId);
      // 等待期间站点被删除、再次改名或手动改过坐标时放弃升级，避免覆盖后续编辑。
      if (!target || String(target.name ?? '').trim() !== name ||
        target.coordinateSource !== 'user-edit' || target.navigationDisabled !== true) return;
      const upgradedStops = currentStops.map((item) => stopKey(item.id) === stopId
        ? {
            ...item,
            lat: Number(poi.lat),
            lng: Number(poi.lng),
            geoConfidence: Number(poi.geoConfidence) || 88,
            coordinateSource: String(poi.coordinateSource || 'known-poi'),
            coordinatePrecision: 'exact',
            coordinateRadiusMeters: 0,
            navigationDisabled: false
          }
        : item);
      updateRoutebook(upgradedStops, { editReason: '坐标重校验' }, current);
      setShareState(`「${name}」已匹配平台可信坐标，已更新定位并恢复导航`);
    } catch {
      // 解析失败静默保持降级：站点仍标记「坐标待确认」，用户可手动修正坐标。
    }
  }

  // 一键重排：先本地即时重排（离线可用、不会被服务端旧数据覆盖），再后台保存为服务端变体。
  function applyModeReorder(mode) {
    if (!canEdit) {
      setShareState('公开路线为只读，请先生成定制版再编辑');
      return;
    }
    const nextStops = reorderByMode(mode);
    if (!nextStops?.length) return;
    createVariantByMode(mode, nextStops);
  }

  function reorderByMode(mode) {
    const nextStops = reorderStopsByMode(stops, mode, { preferredDays: routebook.days });
    updateRoutebook(nextStops, {
      editReason: `${mode}重排`,
      validations: [
        { id: `mode-${Date.now()}`, label: `${mode}重排`, state: '已应用', detail: `已按${mode}偏好重排，仍需出发前复核营业时间和交通。` },
        ...(routebook.validations ?? []).slice(0, 5)
      ]
    });
    return nextStops;
  }

  async function createVariantByMode(mode, presetStops = null) {
    setVariantState('正在保存变体...');
    // 本地有未同步编辑时先提交当前 stops，避免服务端在旧内容上叠加变体。
    // 直接检查保存的结构化返回：非 'saved' 一律中止云端变体（本地重排已生效）。
    if (localEditsDirtyRef.current) {
      const saveResult = await saveCurrentRoutebook();
      if (saveResult?.status !== 'saved') {
        const reason = saveResult?.status === 'conflict'
          ? '云端版本冲突，待提交内容已按保存提示保留'
          : saveResult?.status === 'stale'
            ? '保存响应已过期（页面已有后续操作）'
            : '本地编辑尚未同步到服务端';
        setVariantState(`${mode}版已在本机重排生效；${reason}，同步成功后可再试云端变体`);
        return;
      }
    }
    const base = latestRoutebookRef.current;
    const operationSequence = ++routebookSyncSequenceRef.current;
    const nextStops = Array.isArray(presetStops) && presetStops.length
      ? presetStops
      : reorderStopsByMode(base.stops ?? [], mode, { preferredDays: base.days });
    const variant = {
      id: `${modeSlug(mode)}-${Date.now()}`,
      mode,
      label: `${mode}版`,
      summary: variantSummary(mode),
      stops: nextStops,
      metrics: buildEditedMetrics(nextStops, base.metrics),
      validations: buildEditedValidations(nextStops, base.validations, `${mode}变体`),
      createdAt: new Date().toISOString()
    };
    const localNext = {
      ...base,
      variants: [variant, ...(base.variants ?? []).filter((item) => item.mode !== mode)].slice(0, 8),
      activeVariantId: variant.id
    };
    try {
      const routeId = base.publicId || base.id;
      if (!routeId) throw new Error('当前路书还没有 publicId，请先保存路书');
      const expectedVersion = currentRoutebookVersion(base);
      const data = await saveRoutebookVariant(routeId, {
        variant,
        editToken: base.editToken,
        ...profileRoutebookFields(profile),
        ...(expectedVersion != null ? { expectedVersion } : {})
      });
      if (routebookSyncSequenceRef.current !== operationSequence) {
        // 丢弃整份响应，但把单调版本标量合入最新引用，避免后续保存必 409。
        adoptNewerServerVersionScalars(latestRoutebookRef.current, data.routebook);
        setVariantState(`${data.variant.label}已写入服务端；当前页面已有后续操作，未用较早响应覆盖。`);
        return;
      }
      // 只合并服务端派生字段（variants/version/trustMeta 等），保留本地 stops/days/validations/metrics，
      // 避免服务端返回的旧 stops 覆盖用户本地未保存的编辑。
      const merged = mergeServerDerivedRoutebookFields(latestRoutebookRef.current, data.routebook);
      latestRoutebookRef.current = merged;
      setRoutebook(merged);
      const localSaved = saveRoutebook(merged);
      onSaved?.(merged);
      setVariantState(localSaved ? `已保存 ${data.variant.label}` : '服务端已保存，但浏览器本地存储失败');
    } catch (error) {
      if (error?.status === 409) {
        setVariantState(await refreshAfterVersionConflict(error, `${variant.label}未保存`, localNext, operationSequence));
        return;
      }
      if (routebookSyncSequenceRef.current !== operationSequence) return;
      latestRoutebookRef.current = localNext;
      localEditsDirtyRef.current = true;
      setRoutebook(localNext);
      const localSaved = saveRoutebook(localNext);
      if (localSaved) onSaved?.(localNext);
      setVariantState(localSaved
        ? `${variant.label}仅保存在本机，服务端同步失败：${error.message}`
        : `${variant.label}在本机和服务端均未保存：${error.message}`);
    }
  }

  function applyVariant(variant) {
    if (!variant?.stops?.length) return;
    updateRoutebook(variant.stops, {
      activeVariantId: variant.id,
      editReason: `应用${variant.label}`,
      variants: routebook.variants,
      validations: [
        { id: `variant-apply-${variant.id}`, label: '路线变体', state: '已应用', detail: `${variant.label}已成为当前主路线，可继续编辑、保存和分享。` },
        ...(variant.validations ?? routebook.validations ?? []).slice(0, 6)
      ]
    });
    setVariantState(`已应用 ${variant.label}`);
  }

  // 返回结构化结果 { status: 'saved'|'conflict'|'stale'|'error', routebook }，
  // 供 createVariantByMode 等后续动作按真实保存结果决定是否继续。
  async function saveCurrentRoutebook() {
    const operationSequence = ++routebookSyncSequenceRef.current;
    // 用最新引用而非渲染闭包，保证同一事件里“先本地重排、再保存”能提交刚更新的 stops。
    const current = latestRoutebookRef.current;
    setSaving(true);
    setShareState('');
    try {
      const data = await saveRoutebookRemote({ ...current, ...profileRoutebookFields(profile) });
      // 保留本地所有权与凭证：未注册用户被服务端匿名化时，本机存档不被洗掉所有权。
      const next = {
        ...data.routebook,
        ...profileRoutebookFields(profile),
        editToken: data.routebook.editToken || current.editToken,
        shareUrl: data.shareUrl
      };
      if (routebookSyncSequenceRef.current !== operationSequence) {
        // seq 不匹配丢弃整份响应，但把单调版本标量合入最新引用，避免后续保存必 409。
        adoptNewerServerVersionScalars(latestRoutebookRef.current, data.routebook);
        setShareState('服务端已保存，但当前页面已有后续操作，未用较早响应覆盖。');
        return { status: 'stale', routebook: next };
      }
      latestRoutebookRef.current = next;
      localEditsDirtyRef.current = false;
      setRoutebook(next);
      const localSaved = saveRoutebook(next);
      onSaved?.(next);
      recordJourneyEvent('routebook-save', next, profile.id).catch(() => {});
      const anonymousNote = data.routebook?.profileId === 'anonymous'
        ? '；云端暂存为匿名草稿，同步身份后可关联到你的账号'
        : '';
      setShareState(localSaved
        ? (data.shareUrl
          ? `已保存并发布，H5 分享页：${new URL(data.shareUrl, window.location.origin).toString()}${anonymousNote}`
          : `已保存为草稿，点击分享可发布 H5 链接${anonymousNote}`)
        : `服务端已保存，但浏览器本地存储失败${anonymousNote}`);
      return { status: 'saved', routebook: next };
    } catch (error) {
      if (error?.status === 409) {
        setShareState(await refreshAfterVersionConflict(error, '本次保存未提交', current, operationSequence));
        return { status: 'conflict', routebook: current };
      }
      if (routebookSyncSequenceRef.current !== operationSequence) return { status: 'stale', routebook: current };
      const localSaved = saveRoutebook(current);
      if (localSaved) onSaved?.(current);
      setShareState(localSaved
        ? `已保存到本地，服务端保存失败：${error.message}`
        : `本地和服务端均保存失败：${error.message}`);
      return { status: 'error', routebook: current };
    } finally {
      setSaving(false);
    }
  }

  async function copyRoute() {
    const text = `${routebook.title}\n${routebook.summary}\n\n${stops.map((stop, index) => `${index + 1}. ${stop.time} ${stop.name}｜${stop.stay}｜${stop.cost}`).join('\n')}`;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
    } catch {
      setShareState('浏览器未允许自动复制，请在分享预览中选择路线摘要手动复制');
      return;
    }
    const routeId = routebook.publicId || routebook.id;
    if (!routeId) {
      setShareState('已复制路线文本，本地路书保存后会统计复制次数');
      return;
    }
    try {
      const data = await copyRoutebookRemote(routeId, {
        profileId: profile.id,
        surface: 'route-copy-button',
        routeTitle: routebook.title,
        city: routebook.city,
        creatorId: routebook.creator?.id
      });
      const copied = data.routebook || {};
      const next = {
        ...routebook,
        copyCount: copied.copyCount ?? data.copyCount ?? routebook.copyCount ?? 0,
        provider: {
          ...(routebook.provider ?? {}),
          copiedAt: copied.provider?.copiedAt ?? new Date().toISOString()
        }
      };
      setRoutebook(next);
      // 与 App handleOpenBook 同口径：浏览他人公开路线且本地无存档时只展示不落库，
      // 避免复制计数把别人的路书写进「我的路书」。
      const ownedByProfile = next.profileId === profile.id || next.creator?.id === profile.id;
      const storedLocally = Boolean(getStoredRoutebookById(routeId));
      if (ownedByProfile || storedLocally) {
        saveRoutebook(next);
        onSaved?.(next);
      }
      setShareState(`已复制路线文本，并记录第 ${next.copyCount ?? 1} 次复制`);
    } catch (error) {
      setShareState(`已复制路线文本，复制归因同步失败：${error.message}`);
    }
  }

  function recordProductClick(item) {
    const isSeedCard = !item.analyticsReady;
    const payload = {
      ...item,
      productId: item.id || `${item.provider}-${item.title}`,
      profileId: profile.id,
      routeId: routebook.publicId || routebook.id,
      routeTitle: routebook.title,
      city: routebook.city,
      creatorId: routebook.creator?.id,
      source: 'route',
      sourcePosition: 'route-products',
      ...(isSeedCard ? { linkType: 'seed-search' } : {}),
      clickedAt: new Date().toISOString()
    };
    if (isSeedCard) {
      // 种子/兜底卡也上报点击归因（linkType 标记 seed-search），失败静默；打开链接行为不变。
      setShareState('已打开外部搜索入口，已尝试记录兜底点击归因');
      recordClick(payload)
        .then((data) => {
          if (data?.click) mergeServerClickIntoLocal(payload, data.click, profile.id);
        })
        .catch(() => {});
      if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
      return;
    }
    const existing = safeReadClicks();
    const localStored = safeWriteJsonStorage(clickStorageKey(profile.id), [payload, ...existing].slice(0, 100));
    setShareState(localStored ? `已记录 ${item.type} 点击归因` : '本地点击归因存储失败，正在同步服务端');
    recordClick(payload)
      .then((data) => {
        // 把服务端 click 行（含 id/createdAt）回写本地，保证“我的页”本地/服务端去重键一致。
        if (data?.click) mergeServerClickIntoLocal(payload, data.click, profile.id);
        if (!localStored) setShareState(`已同步 ${item.type} 点击归因到服务端`);
      })
      .catch(() => {
        if (!localStored) setShareState('点击已打开，但本地与服务端归因均未保存');
      });
    if (item.url) window.open(item.url, '_blank', 'noopener,noreferrer');
  }

  async function favoriteRoute() {
    const payload = {
      profileId: profile.id,
      routeId: routebook.publicId || routebook.id,
      routeTitle: routebook.title,
      city: routebook.city,
      creatorId: routebook.creator?.id,
      source: 'route-view'
    };
    const localFavorite = saveFavorite(payload, profile.id);
    try {
      const data = await createFavorite(payload);
      saveFavorite(data.favorite || localFavorite, profile.id);
      setShareState('已收藏到我的资产');
    } catch (error) {
      setShareState(`已本地收藏，服务端同步失败：${error.message}`);
    }
  }

  async function saveTripReminder() {
    const result = await requestTripNotification(routebook);
    if (!result.ok) {
      setShareState(result.reason);
      return;
    }
    const ics = downloadTripIcs(routebook);
    setShareState(ics.ok ? `${result.reason || '已保存提醒'}，并已下载日历文件` : (result.reason || ics.reason));
  }

  function handleShared(nextRoutebook) {
    // 保留本地所有权与凭证，防止服务端匿名化响应洗掉本机存档的归属。
    const next = {
      ...nextRoutebook,
      ...profileRoutebookFields(profile),
      editToken: nextRoutebook?.editToken || latestRoutebookRef.current?.editToken
    };
    routebookSyncSequenceRef.current += 1;
    latestRoutebookRef.current = next;
    localEditsDirtyRef.current = false;
    setRoutebook(next);
    if (!saveRoutebook(next)) {
      setShareState(['published', 'featured'].includes(next.publishStatus)
        ? '路书已发布，但浏览器本地存储失败'
        : '已读取服务端最新版本，但浏览器本地存储失败');
    }
    onSaved?.(next);
  }

  async function refreshAfterVersionConflict(error, actionLabel, pendingSnapshot, operationSequence) {
    const conflictCopy = preserveRoutebookConflictDraft(pendingSnapshot, actionLabel);
    if (conflictCopy.saved) onSaved?.(conflictCopy.draft);
    const recoveryText = conflictCopy.saved
      ? `待提交内容已保留为“${conflictCopy.draft.title}”，可在“我的”中继续编辑。`
      : '冲突副本未能写入本地存储，请暂时不要关闭当前页面。';
    if (routebookSyncSequenceRef.current !== operationSequence) {
      return `${actionLabel}：当前页面已有后续操作，未启动旧版本刷新。${recoveryText}`;
    }
    const routeId = pendingSnapshot?.publicId || pendingSnapshot?.id;
    const fallbackVersion = Number.isInteger(error?.currentVersion) ? error.currentVersion : null;
    if (!routeId) return `${actionLabel}：版本已变化，请重新打开路书后再试。${recoveryText}`;
    const refreshSequence = ++routebookSyncSequenceRef.current;
    const routebookBeforeRefresh = latestRoutebookRef.current;
    try {
      const data = await getRoutebookRemote(routeId);
      if (!data?.routebook) throw new Error('服务端未返回路书');
      if (routebookSyncSequenceRef.current !== refreshSequence || latestRoutebookRef.current !== routebookBeforeRefresh) {
        return `${actionLabel}：刷新期间当前页面已有新更新，未用较早的服务端响应覆盖。${recoveryText}`;
      }
      // 应用服务端版本时保留本地所有权与凭证，避免匿名化响应洗掉本机归属。
      const refreshed = {
        ...data.routebook,
        ...profileRoutebookFields(profile),
        editToken: data.routebook.editToken || routebookBeforeRefresh?.editToken
      };
      latestRoutebookRef.current = refreshed;
      localEditsDirtyRef.current = false;
      setRoutebook(refreshed);
      const localSaved = saveRoutebook(refreshed);
      onSaved?.(refreshed);
      const latestVersion = currentRoutebookVersion(refreshed) ?? fallbackVersion;
      return `${actionLabel}：服务端${latestVersion != null ? `已更新到 v${latestVersion}` : '版本已更新'}，${localSaved ? '已刷新为最新内容' : '最新内容已读取但本地存储失败'}。${recoveryText}`;
    } catch (refreshError) {
      return `${actionLabel}：服务端${fallbackVersion != null ? `已更新到 v${fallbackVersion}` : '版本已更新'}，自动刷新失败（${refreshError.message}）。${recoveryText}`;
    }
  }
}

function currentRoutebookVersion(routebook) {
  const version = Number(routebook?.version ?? routebook?.currentVersion ?? routebook?.revision);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

// seq 不匹配、整份服务端响应被丢弃时，仍把单调递增的版本标量与编辑凭证
// 合入最新引用（服务端版本更大才覆盖，就地写同一对象以免被下次渲染重置），
// 否则后续保存会带着旧 expectedVersion 而必然 409。
function adoptNewerServerVersionScalars(target, serverRoutebook) {
  if (!target || !serverRoutebook) return;
  const serverVersion = currentRoutebookVersion(serverRoutebook);
  const targetVersion = currentRoutebookVersion(target);
  if (serverVersion == null || (targetVersion != null && serverVersion <= targetVersion)) return;
  if (serverRoutebook.version !== undefined) target.version = serverRoutebook.version;
  if (serverRoutebook.currentVersion !== undefined) target.currentVersion = serverRoutebook.currentVersion;
  if (serverRoutebook.editToken) target.editToken = serverRoutebook.editToken;
}

// 本地编辑（provider.editedAt）晚于最近一次服务端同步（updatedAt）即视为有未同步内容。
function hasUnsyncedLocalEdits(routebook) {
  const editedAt = Date.parse(routebook?.provider?.editedAt ?? '');
  if (!Number.isFinite(editedAt)) return false;
  const syncedAt = Date.parse(routebook?.updatedAt ?? '');
  return !Number.isFinite(syncedAt) || editedAt > syncedAt;
}

// 变体保存成功后只合并服务端派生字段，保留本地 stops/days/validations/metrics，
// 防止服务端返回的旧 stops 覆盖用户本地未保存的删除/拖拽/替换编辑。
function mergeServerDerivedRoutebookFields(base, serverRoutebook) {
  if (!serverRoutebook) return base;
  const merged = { ...base };
  const derivedFields = [
    'variants', 'activeVariantId',
    'version', 'currentVersion', 'parentVersion', 'schemaVersion', 'revision',
    'trustScore', 'trustMeta', 'feedbackSummary', 'sourceSummary',
    'copyCount', 'editToken', 'updatedAt', 'changeReason', 'actorType'
  ];
  for (const field of derivedFields) {
    if (serverRoutebook[field] !== undefined) merged[field] = serverRoutebook[field];
  }
  return merged;
}

// 把服务端返回的 click 行（含 id/createdAt/productTitle）回写本地存储，
// 使“我的页”本地/服务端点击去重键能对上；profileId 保持本地口径以便按用户过滤。
function mergeServerClickIntoLocal(localPayload, serverClick, profileId) {
  const merged = { ...localPayload, ...serverClick, profileId: localPayload?.profileId ?? profileId };
  const rest = safeReadClicks().filter((row) =>
    row?.id !== serverClick?.id &&
    !(row?.clickedAt === localPayload?.clickedAt && row?.productId === localPayload?.productId)
  );
  safeWriteJsonStorage(clickStorageKey(profileId), [merged, ...rest].slice(0, 100));
}

// 优先消费服务端透传的 linkType/deepLinkStatus：种子搜索卡（seed-search/search）
// 或深链未就绪（deepLinkStatus 非 ready/verified）一律明示「外部搜索入口」。
function productLinkLabel(item) {
  if (item.deepLinkStatus === 'verified') return '可归因深链';
  if (isExternalSearchEntry(item) || item.matchLevel === 'generic' || item.linkKind === 'search') return '外部搜索入口';
  return item.provider || '外部服务';
}

function predictionAverage(summary) {
  const value = summary?.averagePredictionScore ?? summary?.averagePrediction ?? summary?.averageTrust;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.round(Number(value)) : '待计算';
}

function sourceEvidencePrediction(item) {
  const value = item?.predictionScore ?? item?.trustScore;
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Math.round(Number(value)) : '待计算';
}

function safeReadClicks() {
  try {
    const profile = getProfile();
    const rows = JSON.parse(localStorage.getItem(clickStorageKey(profile.id)) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function StopCard({ stop, index, isSelected, onSelect, onDelete, onMoveUp, onMoveDown, onDetail, onEdit, onDragStart, onDragEnd, onDragOver, onDrop, nextStop, routeTrustTone, isLast, canMoveUp, canMoveDown, canEdit }) {
  const poiTrustState = getStopTrustBadge(stop, routeTrustTone);
  const scoreColor = poiTrustState.tone === 'verified'
    ? 'var(--green)'
    : poiTrustState.tone === 'trial' ? 'var(--orange)' : 'var(--blue)';
  const latestVerifiedLabel = poiTrustState.verified ? formatVerifiedDate(stop.poiTrust?.latestVerifiedAt) : '待验证';

  return (
    <>
      <div
        className={`stop-card ${isSelected ? 'active' : ''}`}
        draggable={canEdit}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="stop-card-indicator" style={{ background: scoreColor }} />
        <div className="stop-card-content">
          <button className="stop-card-header" onClick={onSelect} aria-expanded={isSelected}>
            <span className="stop-num"><GripVertical size={12} /> {index + 1}</span>
            <div style={{ flex: 1 }}>
              <strong className="text-body" style={{ fontWeight: 600 }}>{stop.name}</strong>
              <div className="stop-meta">
                <span><Clock size={11} /> {stop.time}</span>
                <span>{stop.stay}</span>
                <span><DollarSign size={11} /> {stop.cost}</span>
              </div>
            </div>
            <span className="text-micro" style={{ color: scoreColor, fontWeight: 700 }}>{poiTrustState.value}</span>
          </button>
          {isSelected && (
            <div className="stop-detail">
              <p className="text-caption"><Check size={12} style={{ color: 'var(--blue)' }} /> 复核建议：{stop.verify || '出发前核对开放时间与现场条件'}</p>
              <p className="text-caption" style={{ marginTop: 4 }}><AlertTriangle size={12} style={{ color: 'var(--orange)' }} /> {stop.risk}</p>
              <div className="stop-evidence-strip">
                <span className={`badge ${isNavigableCoordinate(stop) ? 'badge-green' : 'badge-orange'}`}>{coordinateReviewLabel(stop)}</span>
                <span className={`badge ${poiTrustState.badgeClass}`}>{poiTrustState.label}</span>
                {latestVerifiedLabel !== '待验证' && <span className="badge badge-green">最近验证 {latestVerifiedLabel}</span>}
              </div>
              {stop.sourceEvidence?.length > 0 && (
                <div className="stop-evidence-strip">
                  {stop.sourceEvidence.slice(0, 3).map((item) => (
                    <span key={item.id || item.label} className={`badge ${item.type === 'approved-correction' ? 'badge-green' : 'badge-blue'}`}>
                      {item.type === 'approved-correction' ? '已审' : '来源预测'} {sourceEvidencePrediction(item)}
                    </span>
                  ))}
                </div>
              )}
              <div className="stop-edit-actions">
                <button className="btn btn-secondary btn-sm" onClick={onDetail}><Info size={13} /> 详情</button>
                {canEdit && <button className="btn btn-secondary btn-sm" onClick={onEdit}><Pencil size={13} /> 替换</button>}
                {canEdit && <button className="btn btn-secondary btn-sm" onClick={onMoveUp} disabled={!canMoveUp}><ArrowUp size={13} /> 上移</button>}
                {canEdit && <button className="btn btn-secondary btn-sm" onClick={onMoveDown} disabled={!canMoveDown}><ArrowDown size={13} /> 下移</button>}
                {canEdit && <button className="btn btn-secondary btn-sm" onClick={onDelete}><Trash2 size={13} /> 删除</button>}
              </div>
            </div>
          )}
        </div>
      </div>
      {!isLast && nextStop && (
        <div className="stop-connector">
          <div className="connector-line" />
          <span className="text-micro">{routeLegLabel(stop, nextStop)}</span>
        </div>
      )}
    </>
  );
}

function buildTrustMetrics(routebook) {
  const trust = getRouteTrustPresentation(routebook);
  const feedback = routebook.feedbackSummary ?? {};
  return [
    { label: '有效到达', value: trust.sampleCount ? `${trust.sampleCount} 次` : '待验证' },
    { label: '完成率', value: trust.sampleCount ? `${Math.round(Number(feedback.completionRate) || 0)}%` : '待验证' },
    { label: '踩坑反馈', value: trust.sampleCount ? `${Math.round(Number(feedback.pitfallRate) || 0)}%` : '待验证' },
    { label: '最近验证', value: formatVerifiedDate(trust.latestVerifiedAt) }
  ];
}

function buildRouteTrustState(trust, isTrustedCity) {
  if (!isTrustedCity) {
    return {
      tone: 'trial',
      badgeClass: 'badge-orange',
      label: '试验生成 · POI、营业信息和导航需人工复核',
      shortLabel: '试验生成',
      value: '待人工复核',
      note: '当前城市尚未进入可信范围，暂不输出数值分。'
    };
  }
  if (trust.verified) {
    return {
      tone: 'verified',
      badgeClass: 'badge-green',
      label: trust.label,
      shortLabel: '真实打卡验证',
      value: trust.scoreText,
      note: `${trust.sampleCount} 个独立身份有效样本`
    };
  }
  return {
    tone: 'prediction',
    badgeClass: 'badge-blue',
    label: trust.label,
    shortLabel: '预测可信度',
    value: '待验证',
    note: `独立有效样本 ${Math.min(trust.sampleCount, PUBLIC_TRUST_SAMPLE_THRESHOLD)}/${PUBLIC_TRUST_SAMPLE_THRESHOLD}，暂不输出验证分。`
  };
}

function canEditRoutebook(routebook, profileId) {
  if (!routebook || !profileId) return false;
  const owned = routebook.profileId === profileId || routebook.creator?.id === profileId;
  const isDraft = (routebook.publishStatus || 'draft') === 'draft';
  const isUnsavedGeneratedDraft = Boolean(routebook.provider?.generatedAt) && !routebook.editToken;
  return owned && isDraft && (Boolean(routebook.editToken) || isUnsavedGeneratedDraft);
}

function createDraftStop(routebook, activeDay) {
  const center = cityCenters[routebook.city] ?? { lat: 35.8617, lng: 104.1954 };
  return {
    id: makeStopId(),
    day: activeDay || routebook.days?.[0] || 'Day 1',
    time: '14:00',
    name: '',
    area: '',
    stay: '60 分钟',
    cost: '待估算',
    verify: '新增站点，需真实打卡验证',
    risk: '需复核营业时间和交通',
    score: 72,
    lat: center.lat,
    lng: center.lng,
    geoConfidence: 45,
    coordinateSystem: 'WGS84',
    coordinateSource: 'user-edit',
    coordinatePrecision: 'approximate',
    coordinateRadiusMeters: 1500,
    navigationDisabled: true
  };
}

function coordinatesChanged(previous, next) {
  if (!previous) return true;
  return Number(previous.lat) !== Number(next?.lat) || Number(previous.lng) !== Number(next?.lng);
}

function makeStopId() {
  if (globalThis.crypto?.randomUUID) return `stop-${globalThis.crypto.randomUUID()}`;
  return `stop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableStopId(value) {
  const text = String(value ?? '').trim();
  return text || makeStopId();
}

function stopKey(value) {
  return String(value ?? '').trim();
}

function StopEditor({ stop, isNew = false, routebook, onClose, onSave }) {
  const [form, setForm] = useState(() => ({ ...stop }));
  const dialogRef = useDialogFocus(true, onClose);

  function update(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function submit(event) {
    event.preventDefault();
    if (!String(form.name ?? '').trim()) return;
    onSave({
      ...form,
      name: String(form.name).trim(),
      area: String(form.area || routebook.city).trim(),
      day: form.day || routebook.days?.[0] || 'Day 1'
    });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form ref={dialogRef} className="modal-content stop-editor-modal" role="dialog" aria-modal="true" aria-labelledby="stop-editor-title" tabIndex={-1} onSubmit={submit} onClick={(event) => event.stopPropagation()}>
        <div className="poi-detail-header">
          <div>
            <span className="badge badge-blue">{isNew ? '新增站点' : '编辑站点'}</span>
            <h2 className="text-title" id="stop-editor-title" style={{ marginTop: 8 }}>{isNew ? '新增路线站点' : `编辑：${form.name || '未命名站点'}`}</h2>
          </div>
          <button type="button" className="btn btn-icon btn-sm" onClick={onClose} aria-label="关闭站点编辑"><X size={18} /></button>
        </div>
        <div className="stop-editor-grid">
          <label>
            <span className="input-label">站点名称</span>
            <input className="input-field" value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="例如：武康路" />
          </label>
          <label>
            <span className="input-label">所属天数</span>
            <select className="input-field" value={form.day} onChange={(event) => update('day', event.target.value)}>
              {(routebook.days ?? ['Day 1']).map((day) => <option key={day}>{day}</option>)}
            </select>
          </label>
          <label>
            <span className="input-label">时间</span>
            <input className="input-field" value={form.time} onChange={(event) => update('time', event.target.value)} placeholder="14:00" />
          </label>
          <label>
            <span className="input-label">区域</span>
            <input className="input-field" value={form.area} onChange={(event) => update('area', event.target.value)} placeholder={`${routebook.city}核心区`} />
          </label>
          <label>
            <span className="input-label">停留</span>
            <input className="input-field" value={form.stay} onChange={(event) => update('stay', event.target.value)} />
          </label>
          <label>
            <span className="input-label">费用</span>
            <input className="input-field" value={form.cost} onChange={(event) => update('cost', event.target.value)} />
          </label>
          <label>
            <span className="input-label">纬度</span>
            <input className="input-field" value={form.lat} onChange={(event) => update('lat', event.target.value)} />
          </label>
          <label>
            <span className="input-label">经度</span>
            <input className="input-field" value={form.lng} onChange={(event) => update('lng', event.target.value)} />
          </label>
        </div>
        <div className="stop-editor-stack">
          <label>
            <span className="input-label">验证理由</span>
            <textarea className="input-field" value={form.verify} onChange={(event) => update('verify', event.target.value)} />
          </label>
          <label>
            <span className="input-label">风险提示</span>
            <textarea className="input-field" value={form.risk} onChange={(event) => update('risk', event.target.value)} />
          </label>
        </div>
        <div className="poi-detail-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>取消</button>
          <button type="submit" className="btn btn-primary"><Check size={16} /> {isNew ? '添加站点' : '保存并重校验'}</button>
        </div>
      </form>
    </div>
  );
}

function buildEditedMetrics(stops, existingMetrics = []) {
  const avg = stops.length ? Math.round(stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stops.length) : 78;
  const lowGeo = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const budget = stops.reduce((sum, stop) => sum + (Number(String(stop.cost ?? '').match(/\d+/)?.[0]) || 0), 0);
  const calculated = [
    { label: '站点预测均分', value: `${avg}` },
    { label: '定位待复核', value: lowGeo ? `${lowGeo} 处` : '0 处' },
    { label: '预算估算', value: budget ? `约 ${budget} 元` : '待验证' },
    { label: '平均修改', value: '本次已编辑' }
  ];
  return [...calculated, ...(existingMetrics ?? []).filter((item) => !calculated.some((next) => next.label === item.label))].slice(0, 6);
}

function buildEditedValidations(stops, existingValidations = [], reason = '编辑') {
  const dayCounts = stops.reduce((acc, stop) => {
    const day = stop.day || 'Day 1';
    acc[day] = (acc[day] ?? 0) + 1;
    return acc;
  }, {});
  const dense = Object.entries(dayCounts).find(([, count]) => count > 6);
  const lowGeo = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length;
  const longestLeg = longestRouteLeg(stops);
  const calculated = [
    { id: 'client-edit-route', label: `${reason || '编辑'}后动线`, state: '已更新', detail: '已重新计算站点顺序、天数分组和地图连线。' },
    { id: 'client-edit-density', label: '节奏密度', state: dense ? '偏紧' : '可执行', detail: dense ? `${dense[0]} 有 ${dense[1]} 站，建议继续删减或拆天。` : '单日站点密度在可执行范围内。' },
    { id: 'client-edit-geo', label: '定位复核', state: lowGeo ? '需复核' : '通过', detail: lowGeo ? `${lowGeo} 个站点坐标置信度偏低。` : '当前站点坐标可用于地图展示。' },
    { id: 'client-edit-leg', label: '转场距离', state: longestLeg > 12000 ? '偏远' : longestLeg > 6000 ? '需留缓冲' : '可执行', detail: longestLeg ? `最长相邻转场约 ${(longestLeg / 1000).toFixed(1)} km，建议结合真实交通复核。` : '站点距离信息不足，建议补充坐标。' },
    { id: 'client-edit-ai-stale', label: 'AI 校验状态', state: '需复核', detail: '路线已被人工编辑，旧模型校验只作参考；分享前建议重新保存并按实际日期复核开放时间。' }
  ];
  const staleIds = new Set(['hours', 'walk', 'budget', 'crowd']);
  return [...calculated, ...(existingValidations ?? []).filter((item) => !calculated.some((next) => next.id === item.id) && !staleIds.has(item.id))].slice(0, 8);
}

function longestRouteLeg(stops) {
  let longest = 0;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const current = stops[index];
    const next = stops[index + 1];
    if (current.day !== next.day) continue;
    const distance = distanceMeters(current, next);
    if (distance > longest) longest = distance;
  }
  return longest;
}

function distanceMeters(a, b) {
  const lat1 = Number(a?.lat);
  const lng1 = Number(a?.lng);
  const lat2 = Number(b?.lat);
  const lng2 = Number(b?.lng);
  if (!isValidCoordinate(lat1, lng1) || !isValidCoordinate(lat2, lng2)) return 0;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function calculateLocalTrustScore(stops) {
  if (!stops.length) return 60;
  const avg = stops.reduce((sum, stop) => sum + Number(stop.score ?? 78), 0) / stops.length;
  const lowGeoPenalty = stops.filter((stop) => Number(stop.geoConfidence ?? 0) < 60).length * 3;
  const missingCostPenalty = stops.filter((stop) => !/\d/.test(String(stop.cost ?? ''))).length * 1.5;
  return Math.round(Math.max(45, Math.min(96, avg - lowGeoPenalty - missingCostPenalty)));
}

function RouteMap({ city, stops, selectedId, onSelect, onTileStatus }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const stopLayersRef = useRef(new Map());
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches);
  const [interactive, setInteractive] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(max-width: 900px)');
    const update = () => {
      setCompact(query.matches);
      if (!query.matches) setInteractive(true);
    };
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const center = cityCenters[city] ?? { lat: 35.8617, lng: 104.1954, zoom: 4 };
    const map = L.map(containerRef.current, {
      zoomControl: false,
      attributionControl: true,
      dragging: !compact,
      touchZoom: !compact,
      scrollWheelZoom: !compact,
      doubleClickZoom: !compact,
      boxZoom: !compact,
      keyboard: !compact
    })
      .setView([center.lat, center.lng], center.zoom);
    let hadTileError = false;
    const primaryLayer = L.tileLayer('/api/map-tiles/{z}/{x}/{y}.png', {
      maxZoom: 19,
      errorTileUrl: '',
      updateWhenIdle: true,
      keepBuffer: 2,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    });
    primaryLayer.on('loading', () => onTileStatus?.('地图底图加载中...'));
    primaryLayer.on('load', () => onTileStatus?.(hadTileError ? '部分地图瓦片加载失败，可继续查看站点和使用导航。' : ''));
    primaryLayer.on('tileerror', () => {
      hadTileError = true;
      onTileStatus?.('地图底图暂时不可用，可继续查看站点列表和使用导航。');
    });
    primaryLayer.addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      onTileStatus?.('');
    };
  }, [city, onTileStatus]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const enabled = !compact || interactive;
    ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom', 'boxZoom', 'keyboard'].forEach((handler) => {
      map[handler]?.[enabled ? 'enable' : 'disable']?.();
    });
  }, [compact, interactive]);

  // stops 变化才重建图层并 fitBounds；点选站点只更新样式，不重置用户缩放平移。
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Clear existing
    map.eachLayer(l => { if (l instanceof L.Marker || l instanceof L.Polyline || l instanceof L.Circle) map.removeLayer(l); });
    stopLayersRef.current = new Map();

    const allLatLngs = stops.map(s => [Number(s.lat), Number(s.lng)]).filter(([a, b]) => isValidCoordinate(a, b));
    const navigableLatLngs = stops.filter(isNavigableCoordinate).map(s => [Number(s.lat), Number(s.lng)]);
    if (navigableLatLngs.length > 1) {
      L.polyline(navigableLatLngs, { color: '#007AFF', weight: 3, opacity: 0.6, dashArray: '6 4' }).addTo(map);
    }

    stops.forEach((stop, i) => {
      const lat = Number(stop.lat), lng = Number(stop.lng);
      if (!isValidCoordinate(lat, lng)) return;
      if (!isNavigableCoordinate(stop)) {
        const circle = L.circle([lat, lng], {
          radius: Number(stop.coordinateRadiusMeters) || 1500,
          color: '#D97706',
          fillColor: '#F59E0B',
          fillOpacity: 0.1,
          weight: 1,
          dashArray: '4 4'
        });
        circle.on('click', () => onSelect(stop.id));
        circle.addTo(map);
        stopLayersRef.current.set(stopKey(stop.id), { type: 'circle', layer: circle });
        return;
      }
      const marker = L.marker([lat, lng], { icon: buildStopPinIcon(stop, i, false) });
      marker.on('click', () => onSelect(stop.id));
      marker.addTo(map);
      stopLayersRef.current.set(stopKey(stop.id), { type: 'marker', layer: marker, stop, index: i });
    });

    if (allLatLngs.length) map.fitBounds(L.latLngBounds(allLatLngs).pad(0.15), { animate: true, maxZoom: 15 });
  }, [stops, onSelect]);

  // selectedId 变化仅更新 marker/圈层样式。
  useEffect(() => {
    stopLayersRef.current.forEach((entry, key) => {
      const isActive = key === stopKey(selectedId);
      if (entry.type === 'circle') {
        entry.layer.setStyle({ fillOpacity: isActive ? 0.18 : 0.1, weight: isActive ? 2 : 1 });
      } else {
        entry.layer.setIcon(buildStopPinIcon(entry.stop, entry.index, isActive));
      }
    });
  }, [selectedId, stops]);

  return (
    <>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {compact && (
        <button type="button" className="btn btn-secondary btn-sm route-map-interaction" onClick={() => setInteractive((value) => !value)}>
          <Navigation size={14} /> {interactive ? '退出地图操作' : '操作地图'}
        </button>
      )}
    </>
  );
}

function buildStopPinIcon(stop, index, isActive) {
  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    html: `<div class="map-pin ${isActive ? 'active' : ''}"><span class="pin-num">${index + 1}</span><span class="pin-name">${escapeHtml(stop.name)}</span></div>`
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
