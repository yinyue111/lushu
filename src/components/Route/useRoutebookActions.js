import { useRef, useState } from 'react';
import { coordinateForName, cityCenters, isValidCoordinate } from '../../lib/coordinates';
import { clickStorageKey, getStoredRoutebookById, saveFavorite, saveRoutebook, safeWriteJsonStorage } from '../../lib/storage';
import {
  copyRoutebookRemote,
  createFavorite,
  getJson,
  getRoutebookRemote,
  recordClick,
  recordJourneyEvent,
  saveRoutebookRemote,
  saveRoutebookVariant
} from '../../lib/api';
import { profileRoutebookFields } from '../../lib/profile';
import { downloadTripIcs, requestTripNotification } from '../../lib/reminders';
import { preserveRoutebookConflictDraft } from '../../lib/routebookConflict';
import { modeSlug, orderedDays, reorderStopsByMode, variantSummary } from '../../lib/routeModes';
import {
  adoptNewerServerVersionScalars,
  buildEditedMetrics,
  buildEditedValidations,
  calculateLocalTrustScore,
  coordinatesChanged,
  currentRoutebookVersion,
  hasUnsyncedLocalEdits,
  mergeServerClickIntoLocal,
  mergeServerDerivedRoutebookFields,
  safeReadClicks,
  stableStopId,
  stopKey
} from './routebookModel';

/**
 * All routebook mutations of the route page (edit, reorder, variants, save, copy,
 * favourite, reminders, product clicks, conflict recovery). Behaviour is unchanged
 * from the former RouteView; only the presentation moved out.
 */
export function useRoutebookActions({
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
}) {
  const [shareState, setShareState] = useState('');
  const [saving, setSaving] = useState(false);
  const [variantState, setVariantState] = useState('');
  const routebookSyncSequenceRef = useRef(0);
  // 本地是否有尚未同步到服务端的编辑（删除/拖拽/替换等只写 localStorage 的操作）。
  const localEditsDirtyRef = useRef(hasUnsyncedLocalEdits(routebook));
  const latestRoutebookRef = useRef(routebook);
  latestRoutebookRef.current = routebook;
  const stops = routebook.stops ?? [];

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
    const dayIndexes = stops.reduce((indexes, stop, index) => (stop.day === activeDay ? [...indexes, index] : indexes), []);
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
    const lastDayIndex = stops.reduce((last, stop, index) => ((stop.day || 'Day 1') === day ? index : last), -1);
    setDraggedStopId(null);
    if (sourceIndex === lastDayIndex) return;
    const nextStops = [...stops];
    const [moved] = nextStops.splice(sourceIndex, 1);
    const insertIndex = nextStops.reduce((last, stop, index) => ((stop.day || 'Day 1') === day ? index : last), -1) + 1;
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
      geoConfidence: coordinatesEdited ? 45 : Number(nextStop.geoConfidence) || 55,
      coordinateSystem: 'WGS84',
      ...(coordinatesEdited || renamed
        ? {
            coordinateSource: 'user-edit',
            coordinatePrecision: 'approximate',
            coordinateRadiusMeters: 1500,
            navigationDisabled: true
          }
        : {}),
      ...(renamed ? { geoConfidence: 30 } : {})
    };
    if (renamed) {
      setShareState(
        coordinateForName(prepared.name, routebook.city)
          ? `「${prepared.name}」坐标待确认，导航已暂停；本地目录有参考坐标，正在向服务端确认`
          : `「${prepared.name}」坐标待确认，导航已暂停，正在向服务端匹配可信坐标`
      );
    }
    const nextStops = isNew ? [...stops, prepared] : stops.map((stop) => (stableStopId(stop.id) === prepared.id ? prepared : stop));
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
      if (!target || String(target.name ?? '').trim() !== name || target.coordinateSource !== 'user-edit' || target.navigationDisabled !== true) return;
      const upgradedStops = currentStops.map((item) =>
        stopKey(item.id) === stopId
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
          : item
      );
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
        const reason =
          saveResult?.status === 'conflict'
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
    const nextStops = Array.isArray(presetStops) && presetStops.length ? presetStops : reorderStopsByMode(base.stops ?? [], mode, { preferredDays: base.days });
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
      setVariantState(
        localSaved ? `${variant.label}仅保存在本机，服务端同步失败：${error.message}` : `${variant.label}在本机和服务端均未保存：${error.message}`
      );
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
      const anonymousNote = data.routebook?.profileId === 'anonymous' ? '；云端暂存为匿名草稿，同步身份后可关联到你的账号' : '';
      setShareState(
        localSaved
          ? data.shareUrl
            ? `已保存并发布，H5 分享页：${new URL(data.shareUrl, window.location.origin).toString()}${anonymousNote}`
            : `已保存为草稿，点击分享可发布 H5 链接${anonymousNote}`
          : `服务端已保存，但浏览器本地存储失败${anonymousNote}`
      );
      return { status: 'saved', routebook: next };
    } catch (error) {
      if (error?.status === 409) {
        setShareState(await refreshAfterVersionConflict(error, '本次保存未提交', current, operationSequence));
        return { status: 'conflict', routebook: current };
      }
      if (routebookSyncSequenceRef.current !== operationSequence) return { status: 'stale', routebook: current };
      const localSaved = saveRoutebook(current);
      if (localSaved) onSaved?.(current);
      setShareState(localSaved ? `已保存到本地，服务端保存失败：${error.message}` : `本地和服务端均保存失败：${error.message}`);
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
    setShareState(ics.ok ? `${result.reason || '已保存提醒'}，并已下载日历文件` : result.reason || ics.reason);
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
      setShareState(['published', 'featured'].includes(next.publishStatus) ? '路书已发布，但浏览器本地存储失败' : '已读取服务端最新版本，但浏览器本地存储失败');
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

  return {
    shareState,
    setShareState,
    saving,
    variantState,
    removeStop,
    moveStop,
    moveStopBefore,
    moveStopToDayEnd,
    upsertStop,
    applyModeReorder,
    applyVariant,
    saveCurrentRoutebook,
    copyRoute,
    recordProductClick,
    favoriteRoute,
    saveTripReminder,
    handleShared
  };
}
