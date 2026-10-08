import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Camera, Map as MapIcon, Check, ChevronRight, LocateFixed, SkipForward, CloudRain, Footprints, BookOpen, RefreshCw } from 'lucide-react';
import { getMyCheckins, getPoiKnowledge, recordJourneyEvent } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { checkinStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { coordinateForName, distanceKm, isNavigableCoordinate } from '../../lib/coordinates';
import { normalizeTripStops, readTripSession, saveTripSession, tripRoutebookId } from '../../lib/tripSession';
import { greedyModeOrder } from '../../lib/routeModes';
import {
  capCheckinRows,
  checkinEvidenceState,
  flushAllCheckinQueues,
  isCheckinFlushInFlight,
  isLocallyProcessedCheckin,
  isServerSyncedCheckin,
  listQueuedCheckins,
  markCheckinSynced,
  queueCheckin,
  requeueCheckin,
  recoverInterruptedCheckins,
  upsertCheckin
} from '../../lib/checkinQueue';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { trustedCities } from '../../lib/content';

export default function TripView({ routebook, onBack, onReview }) {
  // 队列补传可能触发身份注册与本地数据迁移（profileId 变化），因此用 state 保存。
  const [profile, setProfile] = useState(() => getProfile());
  const [initialSession] = useState(() => readTripSession(routebook, profile.id));
  const initialStops = initialSession?.stops ?? normalizeTripStops(routebook);
  const [currentIdx, setCurrentIdx] = useState(() => {
    const storedIndex = initialStops.findIndex((stop) => stopKeyForStop(stop) === String(initialSession?.currentStopId ?? ''));
    return storedIndex >= 0 ? storedIndex : 0;
  });
  const storageKey = checkinStorageKey(routebook, profile.id);
  const routeId = tripRoutebookId(routebook);
  const [checkins, setCheckins] = useState(() => {
    const stored = safeReadCheckins(storageKey).filter((item) => String(item?.routeId ?? '') === routeId);
    const recovered = recoverInterruptedCheckins(stored);
    if (recovered.some((item, index) => item !== stored[index])) safeWriteJsonStorage(storageKey, recovered);
    return recovered;
  });
  const checkinsRef = useRef(checkins);
  const syncInFlightRef = useRef('');
  const tripOpenRef = useRef('');
  const [showCheckin, setShowCheckin] = useState(false);
  const [modeNote, setModeNote] = useState('');
  const [activeStops, setActiveStops] = useState(initialStops);
  const [storageWarning, setStorageWarning] = useState('');
  const [tripStorageWarning, setTripStorageWarning] = useState('');
  const [queueFlushing, setQueueFlushing] = useState(false);
  const [poiKnowledge, setPoiKnowledge] = useState([]);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const checkinDialogRef = useDialogFocus(showCheckin, () => setShowCheckin(false));

  const stops = activeStops;
  const latestByStop = useMemo(() => latestCheckinsByStop(checkins), [checkins]);
  const firstOpenIndex = stops.findIndex((stop) => !isLocallyProcessedCheckin(latestByStop.get(stopKeyForStop(stop))));
  const effectiveIdx = firstOpenIndex >= 0 ? Math.max(currentIdx, firstOpenIndex) : Math.min(currentIdx, Math.max(0, stops.length - 1));
  const current = stops[effectiveIdx];
  const next = stops[effectiveIdx + 1];
  const progressStats = useMemo(() => summarizeProgress(checkins, stops), [checkins, stops]);
  const progress = progressStats.progress;
  const review = useMemo(() => buildReview(checkins, stops), [checkins, stops]);
  const isFinished = stops.length > 0 && progressStats.processed >= stops.length;
  const currentLatest = current ? latestByStop.get(stopKeyForStop(current)) : null;
  const currentProcessed = isLocallyProcessedCheckin(currentLatest);
  const currentSyncPending = queueFlushing && Boolean(currentLatest) && !isServerSyncedCheckin(currentLatest);
  const pendingSyncCount = useMemo(
    () => checkins.filter((item) => !isServerSyncedCheckin(item)).length,
    [checkins]
  );
  const statusCheckin = useMemo(() => checkinForStatusDisplay(checkins), [checkins]);
  const statusEvidence = useMemo(() => checkinEvidenceState(statusCheckin), [statusCheckin]);
  const alternatives = useMemo(
    () => buildAlternatives(current, routebook, stops, latestByStop, poiKnowledge),
    [current, latestByStop, poiKnowledge, routebook, stops]
  );
  const navigation = useMemo(
    () => navigationForStop(stops, effectiveIdx, routebook, latestByStop),
    [effectiveIdx, latestByStop, routebook, stops]
  );
  const nextStopCountdown = useMemo(() => nextStopEta(next, nowTick), [next, nowTick]);

  useEffect(() => {
    checkinsRef.current = checkins;
  }, [checkins]);

  useEffect(() => {
    if (!routeId) return;
    const key = `${profile.id}:${routeId}`;
    if (tripOpenRef.current === key) return;
    tripOpenRef.current = key;
    recordJourneyEvent('trip-open', routebook, profile.id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- record trip-open once per profile/route; the listed fields are what the event reports.
  }, [profile.id, routeId, routebook.city, routebook.creator?.id, routebook.title]);

  useEffect(() => {
    const ok = saveTripSession(routebook, profile.id, {
      stops,
      currentStopId: current?.id
    });
    setTripStorageWarning(ok ? '' : '实际执行路线未能写入本地存储，请保持当前页面打开。');
  }, [current?.id, profile.id, routebook, stops]);

  // 跨设备续行程：从服务端拉回本人已同步的打卡，回填本地进度；失败时静默降级本地记录。
  useEffect(() => {
    if (!routeId) return undefined;
    // 未注册（无 profile token）时服务端只会回 401/403，直接跳过回填、只用本地记录（对齐我的页做法）。
    if (!profile.profileAccessToken) return undefined;
    const ctrl = new AbortController();
    getMyCheckins(profile.id, 200, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        const serverRows = (Array.isArray(data?.checkins) ? data.checkins : [])
          .filter((item) => String(item?.routeId ?? '') === routeId);
        if (!serverRows.length) return;
        let rows = checkinsRef.current;
        for (const serverRow of serverRows) {
          const clientLocalId = String(serverRow?.clientLocalId ?? '').trim() || (serverRow?.id ? `server-${serverRow.id}` : '');
          if (!clientLocalId) continue;
          const existing = rows.find((item) => String(item?.clientLocalId ?? '') === clientLocalId);
          rows = existing
            ? markCheckinSynced(rows, clientLocalId, serverRow)
            : upsertCheckin(rows, {
              ...serverRow,
              clientLocalId,
              clientSyncStatus: 'synced',
              clientSyncError: '',
              clientSyncRetryable: false,
              clientSyncRetryAt: '',
              clientSyncHttpStatus: ''
            });
        }
        commitCheckins(rows);
      })
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refetch only when the identity or route changes; commitCheckins is recreated every render.
  }, [profile.id, profile.profileAccessToken, routeId]);

  // 平台 POI 库（运营审核过的修正知识）作为行中替代候选来源；失败回退路书内候选。
  useEffect(() => {
    if (!routebook?.city) return undefined;
    const ctrl = new AbortController();
    getPoiKnowledge({ city: routebook.city, limit: 20 }, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setPoiKnowledge(Array.isArray(data?.knowledge) ? data.knowledge : []);
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [routebook?.city]);

  // 下一站建议时间倒计时：纯前端计算，每分钟刷新一次。
  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const handleOnline = () => {
      setModeNote('网络已恢复，正在补传本地反馈...');
      void syncQueuedCheckins();
    };
    window.addEventListener('online', handleOnline);
    if (navigator.onLine !== false && listQueuedCheckins(checkinsRef.current).length) {
      void syncQueuedCheckins();
    }
    const retryTimer = window.setInterval(() => {
      if (navigator.onLine !== false && listQueuedCheckins(checkinsRef.current).length && !syncInFlightRef.current) {
        void syncQueuedCheckins();
      }
    }, 15_000);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearInterval(retryTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listeners/timers are scoped to the storage key; syncQueuedCheckins reads state through refs.
  }, [storageKey]);

  function submitCheckin(data) {
    if (!current || currentProcessed || currentSyncPending) return;
    const { photoData, ...fields } = data ?? {};
    const row = buildPendingCheckin(routebook, current, profile, { status: 'visited', ...fields }, { type: 'visit' });
    if (photoData) {
      // 照片先随打卡行本地暂存（表单侧已限制 <=400KB），补传队列会先传照片拿 photoId 再传打卡行。
      row.clientPhotoData = photoData;
      row.clientPhotoMimeType = 'image/jpeg';
    }
    setShowCheckin(false);
    queueAndApplyLocalAction(row);
  }

  function skipStop() {
    if (!current || currentProcessed || currentSyncPending) return;
    const row = buildPendingCheckin(routebook, current, profile, { status: 'skipped', worth: '跳过', comment: '行中跳过' }, { type: 'skip' });
    queueAndApplyLocalAction(row);
  }

  function applyAlternative(alternative) {
    if (!current || currentProcessed || currentSyncPending) return;
    const alternativeStop = buildAlternativeStop(current, alternative);
    const row = buildPendingCheckin(routebook, current, profile, {
      status: 'replaced',
      worth: '替换',
      comment: `行中替换为：${alternativeStop.name}`,
      replacementStopId: alternativeStop.id
    }, { type: 'replace', replacementStop: alternativeStop, reason: alternative.reason });
    queueAndApplyLocalAction(row);
  }

  function queueAndApplyLocalAction(row) {
    commitCheckins(queueCheckin(latestKnownCheckins(), row));
    applyLocalAction(row);
    if (navigator.onLine === false) {
      setModeNote('本地操作已完成，行程可继续；服务端尚未校验，恢复网络后会自动同步。');
      return;
    }
    void syncQueuedCheckins();
  }

  function applyLocalAction(row) {
    const action = row.clientAction ?? {};
    if (action.type === 'replace' && action.replacementStop) {
      const alternativeStop = action.replacementStop;
      const nextStops = [
        ...stops.slice(0, effectiveIdx),
        alternativeStop,
        ...stops.slice(effectiveIdx + 1).filter((stop) => stopKeyForStop(stop) !== stopKeyForStop(alternativeStop))
      ];
      setActiveStops(nextStops);
      setCurrentIdx(effectiveIdx);
      persistTripRoute(nextStops, {
        currentStopId: alternativeStop.id,
        lastAction: { type: 'replace', stopId: current.id, replacementStopId: alternativeStop.id, at: row.time }
      });
      setModeNote(`已在本地用 ${alternativeStop.name} 替换当前站${action.reason ? `：${action.reason}` : ''}`);
      return;
    }

    const tripStatus = action.type === 'skip' ? 'skipped' : 'visited';
    const updatedStops = stops.map((stop) => stopKeyForStop(stop) === row.localStopKey ? { ...stop, tripStatus } : stop);
    setActiveStops(updatedStops);
    advanceFromCurrent(updatedStops, { lastAction: { type: action.type || 'visit', stopId: row.stopId, at: row.time } });
    setModeNote(action.type === 'skip' ? '已在本地跳过此站，并进入下一站。' : '到达已记录在本地，并进入下一站。');
  }

  // 队列上传逻辑已提炼到 checkinQueue.flushAllCheckinQueues（含身份注册前置与照片补传），
  // 这里只负责触发、刷新本地状态并给出行内提示。
  async function syncQueuedCheckins() {
    if (syncInFlightRef.current) return;
    if (navigator.onLine === false) return;
    syncInFlightRef.current = 'flush';
    setQueueFlushing(true);
    try {
      const result = await flushAllCheckinQueues({ profile });
      refreshAfterFlush();
      announceFlushResult(result);
    } finally {
      syncInFlightRef.current = '';
      setQueueFlushing(false);
    }
  }

  // 补传后从本地存储回读：注册可能迁移了 profileId 与存储 key。
  function refreshAfterFlush() {
    const latestProfile = getProfile();
    const nextKey = checkinStorageKey(routebook, latestProfile.id);
    const rows = safeReadCheckins(nextKey).filter((item) => String(item?.routeId ?? '') === routeId);
    checkinsRef.current = rows;
    setCheckins(rows);
    // 注册可能只补发 token 而不换 id：token 变化也要刷新，让服务端回填生效。
    if (latestProfile.id !== profile.id || latestProfile.profileAccessToken !== profile.profileAccessToken) {
      setProfile(latestProfile);
    }
  }

  function announceFlushResult(result) {
    if (result?.registrationError) {
      setModeNote(result.guidance || '身份未同步，请到『我的页』同步身份或输入恢复码后重试。');
      return;
    }
    const { attempted = 0, synced = 0, failed = 0 } = result ?? {};
    if (!attempted) return;
    if (failed) {
      const terminalCount = checkinsRef.current
        .filter((item) => item?.clientSyncStatus === 'failed' && item.clientSyncRetryable === false).length;
      if (terminalCount) {
        setModeNote(`${terminalCount} 条记录未被服务端接受，需手动重试；其他可同步记录已继续处理${synced ? `，本次成功 ${synced} 条` : ''}。`);
      } else {
        setModeNote(`${failed} 条记录暂未同步成功，将在 15 秒后自动重试${synced ? `；本次已成功 ${synced} 条` : ''}。`);
      }
    } else if (synced) {
      setModeNote(`服务端同步完成，本次成功 ${synced} 条；GPS 与身份校验结果见下方记录状态。`);
    }
  }

  // 补传进行中时以本地存储为准（flush 直接写存储），避免用过期内存快照覆盖同步结果；
  // 全局 flush（App/我的页等入口）也会写本队列，因此一并检查模块级 in-flight 标记。
  function latestKnownCheckins() {
    if (!syncInFlightRef.current && !isCheckinFlushInFlight()) return checkinsRef.current;
    const stored = safeReadCheckins(storageKey).filter((item) => String(item?.routeId ?? '') === routeId);
    return stored.length >= checkinsRef.current.length ? stored : checkinsRef.current;
  }

  function handleSyncAction() {
    if (statusCheckin?.clientSyncStatus === 'failed') {
      commitCheckins(requeueCheckin(checkinsRef.current, statusCheckin.clientLocalId));
      setModeNote('已将此条记录重新加入同步队列。');
    }
    void syncQueuedCheckins();
  }

  function advanceFromCurrent(routeStops = stops, extra = {}) {
    const nextIndex = Math.min(effectiveIdx + 1, Math.max(0, routeStops.length - 1));
    setCurrentIdx(nextIndex);
    persistTripRoute(routeStops, { ...extra, currentStopId: routeStops[nextIndex]?.id });
  }

  function persistCheckins(rows) {
    // 截断上限与迁移侧一致（120），且优先丢弃已同步行、保住 queued/failed 行。
    const ok = safeWriteJsonStorage(storageKey, capCheckinRows(rows));
    setStorageWarning(ok ? '' : '本地存储空间受限，本次反馈已保留在当前页面并尝试同步服务端。');
    return ok;
  }

  function commitCheckins(rows) {
    checkinsRef.current = rows;
    setCheckins(rows);
    persistCheckins(rows);
  }

  function openNavigation() {
    if (!current) return;
    if (!isNavigableCoordinate(current)) {
      setModeNote('当前站点定位待复核，已禁用一键导航；请先在 POI 详情里补充真实坐标或改走下一个高置信站点。');
      return;
    }
    window.open(`https://uri.amap.com/navigation?to=${current.lng},${current.lat},${encodeURIComponent(current.name)}&mode=${navigation.mode}&src=trusted-routebook&coordinate=wgs84&callnative=1`, '_blank', 'noopener,noreferrer');
  }

  function applyTripMode(mode) {
    const processedKeys = new Set([...latestByStop.entries()].filter(([, item]) => isLocallyProcessedCheckin(item)).map(([key]) => key));
    const completed = stops.filter((stop) => processedKeys.has(stopKeyForStop(stop)));
    const remaining = stops.filter((stop) => !processedKeys.has(stopKeyForStop(stop)));
    const result = buildStopsForMode(mode, remaining, routebook, completed.at(-1), processedKeys);
    const nextStops = [...completed, ...result.stops];
    setActiveStops(nextStops);
    setCurrentIdx(completed.length);
    persistTripRoute(nextStops, { currentStopId: nextStops[completed.length]?.id, lastMode: mode });
    setModeNote(`${mode}已应用：${result.source}，剩余 ${result.stops.length} 站已形成可继续导航的执行顺序。`);
  }

  function persistTripRoute(nextStops, extra = {}) {
    const ok = saveTripSession(routebook, profile.id, { stops: nextStops, ...extra });
    setTripStorageWarning(ok ? '' : '实际执行路线未能写入本地存储，请保持当前页面打开。');
    return ok;
  }

  if (!current) return (
    <div className="container page-enter" style={{ paddingTop: 80, textAlign: 'center' }}>
      <p className="text-body" style={{ color: 'var(--muted)' }}>暂无站点</p>
      <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onBack}>返回</button>
    </div>
  );

  return (
    <div className="trip-layout page-enter">
      <div className="trip-header">
        <button className="btn btn-ghost btn-sm" onClick={onBack}><ArrowLeft size={16} /> 退出行中</button>
        <span className="text-micro">{effectiveIdx + 1} / {stops.length} · 行程进度 {progress}%</span>
      </div>

      <div className="trip-columns">
      <div className="trip-main">
        <div className="trip-progress">
          <div className="trip-progress-bar"><span style={{ width: `${Math.min(100, progress)}%` }} /></div>
          <div>
            <strong>{routebook.title}</strong>
            <span>{review}</span>
          </div>
        </div>

        {!trustedCities.includes(routebook.city) && (
          <p className="text-caption trip-mode-note" role="status">
            {routebook.city}为试验生成，POI、营业信息和导航需人工复核。
          </p>
        )}

        <div className="trip-current-card card">
          <span className="badge badge-green">当前站点</span>
          <h1 className="text-hero" style={{ marginTop: 12 }}>{current.name}</h1>
          <p className="text-body" style={{ color: 'var(--muted)', marginTop: 8 }}>
            {current.time} · {current.stay} · {current.area}
          </p>
          <p className="text-caption" style={{ marginTop: 12 }}>{current.risk}</p>
        </div>

        {next && !isFinished && (
          <div className="trip-next">
            <ChevronRight size={16} style={{ color: 'var(--muted)' }} />
            <span className="text-caption">
              下一站：<strong>{next.name}</strong> · {next.time}
              {nextStopCountdown && (
                <strong style={{ marginLeft: 6, color: nextStopCountdown.overdue ? 'var(--orange)' : 'var(--green)' }}>
                  {nextStopCountdown.label}
                </strong>
              )}
            </span>
          </div>
        )}

        <div className="trip-adjustments">
          <button className="btn btn-secondary btn-sm" onClick={() => applyTripMode('少走路')}><Footprints size={14} /> 少走路</button>
          <button className="btn btn-secondary btn-sm" onClick={() => applyTripMode('雨天')}><CloudRain size={14} /> 雨天</button>
          <button className="btn btn-secondary btn-sm" onClick={skipStop} disabled={currentProcessed || currentSyncPending || isFinished}><SkipForward size={14} /> 跳过此站</button>
        </div>
        {modeNote && <p className="text-caption trip-mode-note">{modeNote}</p>}
        {storageWarning && <p className="text-caption trip-mode-note">{storageWarning}</p>}
        {tripStorageWarning && <p className="text-caption trip-mode-note">{tripStorageWarning}</p>}
        {statusCheckin && (
          <div className="trip-sync-state" role="status" aria-live="polite">
            <span>
              <strong>本地：{statusEvidence.localCompleted ? '操作已完成' : '待处理'}</strong>
              {' · '}服务端：{syncStatusLabel(statusEvidence.syncStatus, statusCheckin)}
              <br />
              <small>{publicTrustEvidenceLabel(statusCheckin, statusEvidence)}</small>
              {pendingSyncCount > 1 && <><br /><small>另有 {pendingSyncCount - 1} 条本地记录尚未同步；自动队列会继续处理可重试记录。</small></>}
              {statusEvidence.syncStatus === 'failed' && statusCheckin.clientSyncError && <><br /><small>最近错误：{statusCheckin.clientSyncError}</small></>}
            </span>
            {pendingSyncCount > 0 && (
              <button className="btn btn-secondary btn-sm" onClick={handleSyncAction} disabled={queueFlushing}>
                <RefreshCw size={14} /> {queueFlushing ? '同步中' : statusEvidence.syncStatus === 'failed' ? '重试此条' : '立即同步'}
              </button>
            )}
          </div>
        )}

        <details className="trip-alternatives">
          <summary>
            <span>附近替代与休息点</span>
            <small>
              {alternatives.length} 个
              {alternatives.length > 0 && (alternatives.some((item) => item.source === '平台 POI 库') ? ' · 含平台 POI 库' : ' · 路书内替代站点')}
            </small>
          </summary>
          <div className="trip-alternative-list">
            {alternatives.map((item) => (
              <button key={item.stop.id} className="trip-alt-card" onClick={() => applyAlternative(item)} disabled={currentProcessed || currentSyncPending || isFinished}>
                <strong>{item.name}</strong>
                <span>{item.type} · {item.reason}</span>
              </button>
            ))}
            {!alternatives.length && <p className="text-caption" style={{ color: 'var(--muted)' }}>当前路书及路线变体中没有可确认坐标或类别的替代站点。</p>}
          </div>
        </details>

        <div className="trip-actions">
          <button className="btn btn-primary btn-lg" style={{ flex: 1 }} onClick={() => setShowCheckin(true)} disabled={currentProcessed || currentSyncPending || isFinished}>
            <Camera size={18} /> {isFinished ? '已完成' : currentProcessed ? '已记录' : currentSyncPending ? '同步中' : '记录到达'}
          </button>
          <button className="btn btn-secondary btn-lg" onClick={openNavigation} disabled={!isNavigableCoordinate(current)}>
            <MapIcon size={18} /> {navigation.label}
          </button>
        </div>

        {checkins.length > 0 && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <p className="text-caption">
              服务端有效到达 {progressStats.validArrivals} 站，公开可信样本 {progressStats.publicTrustSamples} 站
            </p>
            <p className="text-caption" style={{ marginTop: 4 }}>
              普通反馈 {progressStats.feedbackOnly} 站，低置信/偏离 {progressStats.lowConfidenceArrivals} 次，跳过 {progressStats.skipped} 站，替换 {progressStats.replaced} 次
            </p>
            <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={onReview}>
              <BookOpen size={14} /> {isFinished ? '生成完整路线回顾' : '查看路线回顾'}
            </button>
          </div>
        )}
      </div>

      <aside className="trip-rail" aria-label="行程总览">
        <h2 className="text-subtitle">行程总览</h2>
        <ol className="trip-rail-list">
          {stops.map((stop, idx) => {
            const processed = isLocallyProcessedCheckin(latestByStop.get(stopKeyForStop(stop)));
            const state = processed ? 'done' : idx === effectiveIdx ? 'current' : 'upcoming';
            return (
              <li key={stopKeyForStop(stop) || idx} className={`trip-rail-item ${state}`}>
                <span className="rail-marker" aria-hidden="true">{processed ? <Check size={13} /> : idx + 1}</span>
                <div className="rail-stop">
                  <strong>{stop.name}</strong>
                  <small>{[stop.day, stop.time, stop.area].filter(Boolean).join(' · ')}</small>
                </div>
                {state === 'current' && <span className="badge badge-green">当前</span>}
                {state === 'done' && <span className="rail-done-label">已打卡</span>}
              </li>
            );
          })}
        </ol>
      </aside>
      </div>

      {showCheckin && (
        <div className="modal-backdrop" onClick={() => setShowCheckin(false)}>
          <div ref={checkinDialogRef} className="sheet-content" role="dialog" aria-modal="true" aria-labelledby="checkin-title" tabIndex={-1} onClick={e => e.stopPropagation()}>
            <h2 className="text-title" id="checkin-title">记录到达 · {current.name}</h2>
            <p className="text-caption" style={{ marginTop: 4 }}>GPS 和体验字段均为选填；只有服务端确认的实名有效 GPS 到达才计入公开可信样本。</p>
            <CheckinForm onSubmit={submitCheckin} onCancel={() => setShowCheckin(false)} />
          </div>
        </div>
      )}
    </div>
  );
}

// 打卡不需要路书写凭证（editToken），payload 里不带，减少凭证暴露面。
function buildCheckinPayload(routebook, stop, profile, data) {
  return {
    profileId: profile.id,
    routeId: tripRoutebookId(routebook),
    routeTitle: routebook.title,
    city: routebook.city,
    stopId: stop?.id,
    stopName: stop?.name,
    localStopKey: stopKeyForStop(stop),
    target: stop ? { lat: stop.lat, lng: stop.lng } : null,
    ...data,
    time: new Date().toISOString()
  };
}

function buildPendingCheckin(routebook, stop, profile, data, clientAction) {
  return {
    ...buildCheckinPayload(routebook, stop, profile, data),
    clientLocalId: createClientCheckinId(),
    clientSyncStatus: 'queued',
    clientSyncError: '',
    clientAction
  };
}

function createClientCheckinId() {
  if (globalThis.crypto?.randomUUID) return `checkin-${globalThis.crypto.randomUUID()}`;
  return `checkin-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 本地暂存照片 dataURL 上限（约 400KB），防 localStorage 被撑爆。
const MAX_PHOTO_DATA_URL_LENGTH = 400 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('照片读取失败'));
    reader.readAsDataURL(file);
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('照片解码失败'));
    image.src = dataUrl;
  });
}

async function compressImageToDataUrl(file, maxEdge = 1280, quality = 0.8) {
  const sourceDataUrl = await readFileAsDataUrl(file);
  const image = await loadImageFromDataUrl(sourceDataUrl);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (!width || !height) throw new Error('照片内容为空');
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持照片压缩');
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', quality);
}

// 下一站建议时间倒计时：解析 stop.time 里的 HH:mm，与当前时间比较；
// 解析不到或相差超过 12 小时（可能非当日）时不展示。
function nextStopEta(stop, nowMs) {
  const match = String(stop?.time ?? '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  const target = new Date(nowMs);
  target.setHours(hours, minutes, 0, 0);
  const diffMinutes = Math.round((target.getTime() - nowMs) / 60_000);
  if (Math.abs(diffMinutes) > 12 * 60) return null;
  if (diffMinutes >= 0) return { overdue: false, label: `距建议到达还有 ${diffMinutes} 分钟` };
  return { overdue: true, label: `已超出建议时间 ${Math.abs(diffMinutes)} 分钟` };
}

function CheckinForm({ onSubmit, onCancel }) {
  const fieldPrefix = useId().replaceAll(':', '');
  const [queue, setQueue] = useState('');
  const [cost, setCost] = useState('');
  const [worth, setWorth] = useState('');
  const [crowd, setCrowd] = useState('');
  const [comment, setComment] = useState('');
  const [pitfall, setPitfall] = useState('');
  const [audience, setAudience] = useState('');
  const [photoName, setPhotoName] = useState('');
  const [photoData, setPhotoData] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [photoBusy, setPhotoBusy] = useState(false);
  const [gps, setGps] = useState(null);
  const [gpsError, setGpsError] = useState('');

  function locate() {
    setGpsError('');
    if (!navigator.geolocation) {
      setGpsError('当前浏览器不支持 GPS，仍可记录到达；服务端会保存为普通反馈。');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => setGps({
        lat: Number(position.coords.latitude.toFixed(6)),
        lng: Number(position.coords.longitude.toFixed(6)),
        accuracy: Math.round(position.coords.accuracy),
        // 客户端无法可靠判定浏览器返回的坐标系，标注 unknown 交由服务端双算纠偏。
        coordinateSystem: 'unknown',
        userAgent: String(navigator.userAgent ?? '').slice(0, 160)
      }),
      () => setGpsError('定位失败，仍可记录到达；服务端会保存为普通反馈，不是已验证到达。'),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 }
    );
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    setPhotoError('');
    setPhotoData('');
    setPhotoName(file?.name ?? '');
    if (!file) return;
    setPhotoBusy(true);
    try {
      // canvas 压缩到最长边 1280、JPEG 质量 0.8，控制上传与本地暂存体积。
      const dataUrl = await compressImageToDataUrl(file, 1280, 0.8);
      if (dataUrl.length > MAX_PHOTO_DATA_URL_LENGTH) {
        setPhotoError('照片压缩后仍超过 400KB，本次不上传；请稍后重拍或换一张照片。');
        return;
      }
      setPhotoData(dataUrl);
    } catch {
      setPhotoError('照片处理失败，本次不上传；仍可直接记录到达。');
    } finally {
      setPhotoBusy(false);
    }
  }

  return (
    <form className="checkin-form" onSubmit={e => { e.preventDefault(); if (photoBusy) return; onSubmit({ queue, cost, worth, crowd, comment, pitfall, audience, photoName, photoData, gps }); }}>
      <button type="button" className="btn btn-secondary" style={{ marginTop: 18 }} onClick={locate}>
        <LocateFixed size={16} /> 可选：用 GPS 验证到达
      </button>
      {gps && <p className="text-caption" style={{ marginTop: 8 }}>已定位：{gps.lat}, {gps.lng} · 精度约 {gps.accuracy}m</p>}
      {gpsError && <p className="text-caption" style={{ marginTop: 8, color: 'var(--orange)' }}>{gpsError}</p>}
      {!gps && !gpsError && <p className="text-caption" style={{ marginTop: 8 }}>不使用 GPS 也可记录到达；服务端会保存为普通反馈，不是已验证到达。</p>}
      <fieldset className="checkin-option-group" style={{ marginTop: 20 }}>
        <legend className="input-label">是否值得去（选填）</legend>
        <div className="chip-group">
          {['值得', '一般', '踩坑'].map(v => (
            <button type="button" key={v} aria-pressed={worth === v} className={`chip ${worth === v ? 'active' : ''}`} onClick={() => setWorth(v)}>{v}</button>
          ))}
        </div>
      </fieldset>
      <fieldset className="checkin-option-group" style={{ marginTop: 12 }}>
        <legend className="input-label">现场拥挤度（选填）</legend>
        <div className="chip-group">
          {['空', '适中', '拥挤', '不建议'].map(v => (
            <button type="button" key={v} aria-pressed={crowd === v} className={`chip ${crowd === v ? 'active' : ''}`} onClick={() => setCrowd(v)}>{v}</button>
          ))}
        </div>
      </fieldset>
      <details className="trip-alternatives">
        <summary>
          <span>补充详情（选填）</span>
          <small>排队、花费、短评等</small>
        </summary>
        <div style={{ padding: 16 }}>
          <div>
            <label className="input-label" htmlFor={`${fieldPrefix}-queue`}>排队时间</label>
            <input id={`${fieldPrefix}-queue`} className="input-field" value={queue} onChange={e => setQueue(e.target.value)} placeholder="按现场情况填写，例如 15 分钟" />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="input-label" htmlFor={`${fieldPrefix}-cost`}>实际花费</label>
            <input id={`${fieldPrefix}-cost`} className="input-field" value={cost} onChange={e => setCost(e.target.value)} placeholder="按实际支付填写，例如 80 元" />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="input-label" htmlFor={`${fieldPrefix}-audience`}>适合人群</label>
            <input id={`${fieldPrefix}-audience`} className="input-field" value={audience} onChange={e => setAudience(e.target.value)} placeholder="朋友/情侣/亲子/独行" />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="input-label" htmlFor={`${fieldPrefix}-comment`}>短评</label>
            <textarea id={`${fieldPrefix}-comment`} className="input-field" value={comment} onChange={e => setComment(e.target.value)} placeholder="现场体验、是否顺路、是否值得保留..." />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="input-label" htmlFor={`${fieldPrefix}-pitfall`}>踩坑/风险</label>
            <input id={`${fieldPrefix}-pitfall`} className="input-field" value={pitfall} onChange={e => setPitfall(e.target.value)} placeholder="闭店、涨价、排队、商业推销..." />
          </div>
          <div style={{ marginTop: 12 }}>
            <label className="input-label" htmlFor={`${fieldPrefix}-photo`}>打卡照片（选填）</label>
            <input id={`${fieldPrefix}-photo`} className="input-field" type="file" accept="image/*" onChange={handlePhotoChange} />
            {photoError && <p className="text-caption" style={{ marginTop: 6, color: 'var(--orange)' }}>{photoError}</p>}
            <p className="text-caption" style={{ marginTop: 6 }}>
              {photoBusy
                ? '照片压缩中...'
                : photoData
                  ? `已压缩待上传：${photoName || '打卡照片'}`
                  : '照片将作为打卡证据上传（压缩到最长边 1280 后上传，离线时先本地暂存、恢复网络自动补传）。'}
            </p>
          </div>
        </div>
      </details>
      <div style={{ display: 'flex', gap: 12, marginTop: 24 }}>
        <button type="button" className="btn btn-secondary" style={{ flex: 1 }} onClick={onCancel}>取消</button>
        <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={photoBusy}><Check size={16} /> {photoBusy ? '照片处理中...' : '记录到达'}</button>
      </div>
    </form>
  );
}

function buildReview(checkins, stops) {
  if (!checkins.length) return '记录到达后会自动沉淀完成度、花费、排队和踩坑反馈';
  const progress = summarizeProgress(checkins, stops);
  const stopIds = new Set((stops ?? []).map(stopKeyForStop));
  const routeCheckins = checkins.filter((item) => isServerSyncedCheckin(item) && stopIds.has(checkinKey(item)));
  const pitfallCount = routeCheckins.filter((item) => item.status === 'visited' && (item.worth === '踩坑' || item.pitfall)).length;
  return `有效到达 ${progress.validArrivals}/${stops.length} 站，公开可信样本 ${progress.publicTrustSamples} 站，踩坑 ${pitfallCount} 条`;
}

function safeReadCheckins(storageKey) {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function summarizeProgress(checkins, stops) {
  const stopIds = new Set((stops ?? []).map(stopKeyForStop));
  const latestByStop = new Map();
  for (const item of checkins ?? []) {
    const key = checkinKey(item);
    if (!key || !stopIds.has(key)) continue;
    latestByStop.set(key, item);
  }
  const locallyProcessedRows = [...latestByStop.values()].filter(isLocallyProcessedCheckin);
  const syncedRows = [...latestByStop.values()].filter(isServerSyncedCheckin);
  const syncedFeedbackRows = syncedRows.filter((item) => item.status === 'visited');
  const skipped = locallyProcessedRows.filter((item) => item.status === 'skipped' || item.worth === '跳过').length;
  const replaced = (checkins ?? []).filter((item) => isLocallyProcessedCheckin(item) && (item.status === 'replaced' || item.worth === '替换')).length;
  const visited = locallyProcessedRows.filter((item) => item.status === 'visited').length;
  const validArrivals = syncedFeedbackRows.filter((item) => checkinEvidenceState(item).validArrival).length;
  const publicTrustSamples = syncedRows.filter((item) => checkinEvidenceState(item).countsTowardPublicTrust).length;
  const lowConfidenceArrivals = syncedFeedbackRows.filter((item) => ['weak', 'invalid'].includes(item.arrivalConfidence || item.arrival?.confidence)).length;
  const feedbackOnly = Math.max(0, syncedFeedbackRows.length - validArrivals - lowConfidenceArrivals);
  const processed = locallyProcessedRows.length;
  return {
    visited,
    skipped,
    replaced,
    validArrivals,
    publicTrustSamples,
    lowConfidenceArrivals,
    feedbackOnly,
    processed,
    progress: stops.length ? Math.min(100, Math.round((processed / stops.length) * 100)) : 0
  };
}

function latestCheckinsByStop(checkins) {
  const latest = new Map();
  for (const item of checkins ?? []) {
    const key = checkinKey(item);
    if (key) latest.set(key, item);
  }
  return latest;
}

function stopKeyForStop(stop) {
  return String(stop?.id ?? '').trim();
}

function checkinKey(item) {
  return String(item?.localStopKey ?? item?.stopId ?? '').trim();
}

function queuedCheckinsByTime(checkins) {
  return [...listQueuedCheckins(checkins)].sort((left, right) => {
    const leftTime = String(left?.time ?? left?.createdAt ?? '');
    const rightTime = String(right?.time ?? right?.createdAt ?? '');
    return leftTime.localeCompare(rightTime) || String(left?.clientLocalId ?? '').localeCompare(String(right?.clientLocalId ?? ''));
  });
}

function latestCheckinByTime(checkins) {
  return [...(checkins ?? [])].sort((left, right) => {
    const leftTime = String(left?.time ?? left?.createdAt ?? '');
    const rightTime = String(right?.time ?? right?.createdAt ?? '');
    return rightTime.localeCompare(leftTime) || String(right?.clientLocalId ?? '').localeCompare(String(left?.clientLocalId ?? ''));
  })[0] ?? null;
}

function checkinForStatusDisplay(checkins) {
  const rows = checkins ?? [];
  return rows.find((item) => item?.clientSyncStatus === 'syncing')
    ?? rows.find((item) => item?.clientSyncStatus === 'failed')
    ?? queuedCheckinsByTime(rows)[0]
    ?? latestCheckinByTime(rows);
}

function syncStatusLabel(status, row) {
  if (status === 'syncing') return '同步中';
  if (status === 'synced') return '已同步';
  if (status === 'failed') return row?.clientSyncRetryable === false ? '同步失败，需手动重试' : '同步失败，15 秒后自动重试';
  return '已排队，等待同步';
}

function publicTrustEvidenceLabel(row, evidence) {
  if (row?.status === 'skipped' || row?.status === 'replaced') {
    return '公开可信：行程跳过或替换记录不作为到达样本。';
  }
  if (evidence.syncStatus !== 'synced') {
    return '公开可信：尚未经过服务端校验，当前不计入样本。';
  }
  if (evidence.countsTowardPublicTrust) {
    return '公开可信：实名身份与有效 GPS 到达均已通过，已计入样本。';
  }
  if (evidence.validArrival && !evidence.identityAttested) {
    return '公开可信：GPS 到达有效，但身份尚未完成可信绑定，不计入样本。';
  }
  if (evidence.arrivalConfidence === 'weak') {
    return '普通反馈：GPS 接近但置信度不足，不计入公开可信样本。';
  }
  if (evidence.arrivalConfidence === 'invalid') {
    return '普通反馈：GPS 位置疑似偏离，不计入公开可信样本。';
  }
  return '普通反馈：没有形成有效 GPS 到达，不计入公开可信样本。';
}

function buildAlternatives(current, routebook, activeStops, latestByStop, poiKnowledge = []) {
  if (!current) return [];
  const currentCategory = stopCategory(current);
  const decorate = (candidate) => {
    const category = stopCategory(candidate.stop);
    const distance = distanceKm(current, candidate.stop);
    const sameArea = Boolean(current.area && candidate.stop.area && current.area === candidate.stop.area);
    const categoryMatch = category !== '其他' && category === currentCategory;
    return { ...candidate, category, distance, sameArea, categoryMatch };
  };

  // 平台 POI 库（运营审核过的修正知识）按与当前站点的距离排序，取前 3 个。
  const platformCandidates = buildPlatformAlternatives(current, routebook, latestByStop, poiKnowledge)
    .map(decorate)
    .sort((a, b) => {
      const distanceA = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const distanceB = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
      return distanceA - distanceB;
    })
    .slice(0, 3);

  // 平台库无数据/接口失败时回退路书内候选，来源文案标注为「路书内替代站点」。
  const routeSourceLabel = (label) => (platformCandidates.length ? label : '路书内替代站点');
  const sources = [
    { label: routeSourceLabel('主路线'), stops: routebook?.stops ?? [] },
    ...(routebook?.variants ?? []).map((variant) => ({ label: routeSourceLabel(variant.label || `${variant.mode || '路线'}变体`), stops: variant.stops ?? [] }))
  ];
  const candidates = new Map();
  for (const source of sources) {
    for (const stop of normalizeTripStops(routebook, source.stops)) {
      const key = stopKeyForStop(stop);
      if (!key || key === stopKeyForStop(current) || isLocallyProcessedCheckin(latestByStop.get(key))) continue;
      if (!candidates.has(key)) candidates.set(key, { stop, source: source.label });
    }
  }
  const routeCandidates = [...candidates.values()]
    .map(decorate)
    .filter((candidate) => Number.isFinite(candidate.distance) || candidate.category !== '其他' || candidate.sameArea)
    .sort((a, b) => {
      if (a.categoryMatch !== b.categoryMatch) return a.categoryMatch ? -1 : 1;
      if (a.sameArea !== b.sameArea) return a.sameArea ? -1 : 1;
      const distanceA = Number.isFinite(a.distance) ? a.distance : Number.POSITIVE_INFINITY;
      const distanceB = Number.isFinite(b.distance) ? b.distance : Number.POSITIVE_INFINITY;
      return distanceA - distanceB || Number(b.stop.score ?? 0) - Number(a.stop.score ?? 0);
    });

  const combined = [];
  const seenNames = new Set([String(current.name ?? '').trim()]);
  for (const candidate of [...platformCandidates, ...routeCandidates]) {
    const name = String(candidate.stop.name ?? '').trim();
    if (!name || seenNames.has(name)) continue;
    seenNames.add(name);
    combined.push(candidate);
    if (combined.length >= 5) break;
  }
  return combined.map((candidate) => ({
    ...candidate,
    name: candidate.stop.name,
    type: `${candidate.category} · ${candidate.source}`,
    reason: alternativeReason(candidate, currentCategory, activeStops)
  }));
}

// 把平台 POI 库知识行转换成可替换的候选站点；坐标从本地已知 POI 坐标表兜底解析。
function buildPlatformAlternatives(current, routebook, latestByStop, poiKnowledge) {
  const seen = new Set();
  const candidates = [];
  for (const row of Array.isArray(poiKnowledge) ? poiKnowledge : []) {
    const name = String(row?.stopName ?? '').trim();
    if (!name || name === String(current?.name ?? '').trim() || seen.has(name)) continue;
    seen.add(name);
    const coordinate = coordinateForName(name, routebook?.city);
    const stop = {
      id: `poi-knowledge-${String(row?.id ?? name)}`,
      name,
      day: current?.day,
      time: current?.time,
      area: current?.area || routebook?.city || '',
      verify: `平台 POI 库运营审核：${row?.field || '综合信息'}${row?.value ? ` · ${row.value}` : ''}`.slice(0, 120),
      risk: String(row?.reason ?? '').slice(0, 120),
      ...(coordinate ? { lat: coordinate.lat, lng: coordinate.lng, geoConfidence: 75, coordinateSource: 'known-poi' } : {})
    };
    if (isLocallyProcessedCheckin(latestByStop.get(stopKeyForStop(stop)))) continue;
    candidates.push({ stop, source: '平台 POI 库' });
  }
  return candidates;
}

function buildAlternativeStop(current, alternative) {
  const candidate = alternative.stop;
  return {
    ...candidate,
    day: current?.day || candidate.day,
    time: current?.time || candidate.time,
    tripOriginalDay: candidate.day,
    tripOriginalTime: candidate.time,
    tripReplacementFor: current?.id,
    tripStatus: 'pending',
    verify: candidate.verify || `来自${alternative.source}的真实替代站点`,
    risk: candidate.risk || alternative.reason
  };
}

function buildStopsForMode(mode, sourceStops, routebook, anchorStop, processedKeys) {
  const matchingVariant = (routebook?.variants ?? []).find((variant) => variant.mode === mode || String(variant.label ?? '').includes(mode));
  if (matchingVariant?.stops?.length) {
    const seen = new Set();
    const variantStops = normalizeTripStops(routebook, matchingVariant.stops).filter((stop) => {
      const key = stopKeyForStop(stop);
      if (!key || processedKeys.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (variantStops.length) {
      return { stops: variantStops, source: `采用现有「${matchingVariant.label || `${mode}版`}」路线变体` };
    }
  }

  // 贪心重排复用 lib/routeModes 的共享实现，与行前「一键重排」保持同一套权重。
  const days = [...new Set(sourceStops.map((stop) => stop.day || 'Day 1'))];
  let anchor = anchorStop;
  const ordered = [];
  for (const day of days) {
    const dayStops = sourceStops.filter((stop) => (stop.day || 'Day 1') === day);
    const reordered = greedyModeOrder(dayStops, anchor, mode);
    ordered.push(...reordered);
    anchor = reordered.at(-1) ?? anchor;
  }
  return {
    stops: ordered,
    source: mode === '雨天' ? '按室内属性与相邻距离重新计算' : '按站点坐标与区域做最近邻重排'
  };
}

function navigationForStop(stops, currentIndex, routebook, latestByStop) {
  const current = stops[currentIndex];
  const previous = [...stops.slice(0, currentIndex)].reverse().find((stop) => {
    const checkin = latestByStop.get(stopKeyForStop(stop));
    return checkin?.status !== 'skipped' && checkin?.status !== 'replaced' && checkin?.worth !== '跳过' && checkin?.worth !== '替换';
  }) ?? stops[currentIndex - 1];
  const distance = previous && current ? distanceKm(previous, current) : null;
  // 站点上并没有 transport/transfer 之类的转场字段；从实际存在的 verify/risk 文本
  // 与路书约束里的交通偏好推断导航模式。
  const legHint = `${current?.verify ?? ''} ${current?.risk ?? ''}`;
  const routeHint = String(routebook?.constraints?.transport ?? '');
  let mode = 'walk';
  if (/打车|驾车|自驾|租车|网约车|car/i.test(legHint)) mode = 'car';
  else if (/步行|走路|walk/i.test(legHint)) mode = 'walk';
  else if (Number.isFinite(distance)) mode = distance <= 1.5 ? 'walk' : 'car';
  else if (/打车|驾车|自驾|地铁|少走路|少换乘|car/i.test(routeHint)) mode = 'car';
  return {
    mode,
    label: mode === 'car' ? '驾车导航' : '步行导航'
  };
}

function stopCategory(stop) {
  const text = `${stop?.name ?? ''} ${stop?.area ?? ''} ${stop?.verify ?? ''} ${stop?.risk ?? ''}`;
  if (/馆|展|博物|美术|书店|剧场|艺术/.test(text)) return '展馆文化';
  if (/餐|饭|小吃|咖啡|茶|酒吧|甜品|店/.test(text)) return '餐饮休息';
  if (/寺|庙|教堂|道观/.test(text)) return '人文宗教';
  if (/园|湖|山|江|河|街|巷|古镇|景区|公园/.test(text)) return '户外景点';
  if (/商场|银泰|中心|购物/.test(text)) return '室内商业';
  return '其他';
}

function alternativeReason(candidate, currentCategory, activeStops) {
  const details = [];
  if (Number.isFinite(candidate.distance)) {
    details.push(candidate.distance < 1 ? `距当前约 ${Math.round(candidate.distance * 1000)}m` : `距当前约 ${candidate.distance.toFixed(1)}km`);
  } else if (candidate.sameArea) {
    details.push(`同在${candidate.stop.area}`);
  } else {
    details.push(`位于${candidate.stop.area || '当前目的地区域'}`);
  }
  if (candidate.categoryMatch) details.push(`与当前同属${currentCategory}`);
  else details.push(`可切换为${candidate.category}`);
  if (activeStops.some((stop) => stopKeyForStop(stop) === stopKeyForStop(candidate.stop))) details.push('将同步移除后续重复站点');
  return details.join('，');
}
