import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Camera,
  Check,
  ChevronRight,
  Clock,
  CloudCheck,
  CloudOff,
  CloudRain,
  CloudUpload,
  Footprints,
  MapPin,
  Navigation,
  RefreshCw,
  SkipForward,
  TriangleAlert,
  X
} from 'lucide-react';
import { getMyCheckins, getPoiKnowledge, recordJourneyEvent } from '../../lib/api';
import { canSyncToCloud, getProfile, hasProfileCloudRegistrationConsent } from '../../lib/profile';
import { useAccount } from '../Account/AccountProvider';
import { checkinStorageKey, safeWriteJsonStorage } from '../../lib/storage';
import { amapNameSearchUrl, isNavigableCoordinate } from '../../lib/coordinates';
import { buildNearbyFacilities, filterNearbyRecommendations, NEARBY_FILTERS } from '../../lib/nearbyRecommendations';
import { normalizeTripStops, readTripSession, saveTripSession, tripRoutebookId } from '../../lib/tripSession';
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
import { trustedCities } from '../../lib/content';
import { Button } from '../ui/button';
import { Chip } from '../ui/chip';
import { cn } from '../ui/cn';
import { Drawer, DrawerContent } from '../ui/drawer';
import { StopThumb } from '../visual/StopThumb';
import { dayTheme } from '../visual/theme';
import CheckinForm from './CheckinForm';
import { useTripCloudSync } from './useTripCloudSync';
import { stashCheckinPhoto } from '../../lib/photoStore';
import {
  buildAlternativeStop,
  buildAlternatives,
  buildPendingCheckin,
  buildReview,
  buildStopsForMode,
  checkinForStatusDisplay,
  latestCheckinsByStop,
  navigationForStop,
  nextStopEta,
  isTripLiveToday,
  publicTrustEvidenceLabel,
  safeReadCheckins,
  stopKeyForStop,
  summarizeProgress,
  syncStatusLabel
} from './tripModel';

export default function TripView({ routebook, onBack, onAdoptTrip = undefined, onReview }) {
  // 队列补传可能触发身份注册与本地数据迁移（profileId 变化），因此用 state 保存。
  const [profile, setProfile] = useState(() => getProfile());
  const [initialSession] = useState(() => readTripSession(routebook, profile.id));
  const { required: loginRequired, account, requireLogin } = useAccount();
  // Guests keep the whole trip on this device; logging in uploads it.
  const guestLocalOnly = loginRequired && !account;
  const cloudSyncOff =
    guestLocalOnly || Boolean(profile?.id && profile.id !== 'anonymous' && !profile.profileAccessToken && !hasProfileCloudRegistrationConsent(profile));
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
  const submittingCheckinRef = useRef(false);
  const [showCheckin, setShowCheckin] = useState(false);
  const [modeNote, setModeNote] = useState('');
  const [activeStops, setActiveStops] = useState(initialStops);
  const [storageWarning, setStorageWarning] = useState('');
  const [tripStorageWarning, setTripStorageWarning] = useState('');
  const [queueFlushing, setQueueFlushing] = useState(false);
  const [poiKnowledge, setPoiKnowledge] = useState([]);
  const [nearbyFilter, setNearbyFilter] = useState('all');
  const [nowTick, setNowTick] = useState(() => Date.now());
  const tripCloud = useTripCloudSync(routebook, profile, (session) => {
    setActiveStops(session.stops);
    const index = session.stops.findIndex((stop) => String(stop.id) === String(session.currentStopId));
    setCurrentIdx(Math.max(0, index));
  });

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
  const pendingSyncCount = useMemo(() => checkins.filter((item) => !isServerSyncedCheckin(item)).length, [checkins]);
  const statusCheckin = useMemo(() => checkinForStatusDisplay(checkins), [checkins]);
  const statusEvidence = useMemo(() => checkinEvidenceState(statusCheckin), [statusCheckin]);
  const alternatives = useMemo(
    () => buildAlternatives(current, routebook, stops, latestByStop, poiKnowledge),
    [current, latestByStop, poiKnowledge, routebook, stops]
  );
  const nearbyItems = useMemo(
    () => [
      ...alternatives.map((item) => ({ ...item, kind: 'alternative', id: item.stop.id, canNavigate: true })),
      ...buildNearbyFacilities({ current, routebook: { ...routebook, stops }, poiKnowledge })
    ],
    [alternatives, current, routebook, stops, poiKnowledge]
  );
  const nearbyVisible = filterNearbyRecommendations(nearbyItems, nearbyFilter);
  const navigation = useMemo(() => navigationForStop(stops, effectiveIdx, routebook, latestByStop), [effectiveIdx, latestByStop, routebook, stops]);
  const travelDate = routebook?.constraints?.date || routebook?.travelDate || '';
  const tripLiveToday = useMemo(
    () => isTripLiveToday({ travelDate, day: current?.day, checkins, nowMs: nowTick }),
    [travelDate, current?.day, checkins, nowTick]
  );
  const nextStopCountdown = useMemo(() => (tripLiveToday ? nextStopEta(next, nowTick, current) : null), [tripLiveToday, next, nowTick, current]);

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
    if (readTripSession(routebook, profile.id)) return;
    const ok = saveTripSession(routebook, profile.id, {
      stops: normalizeTripStops(routebook),
      currentStopId: routebook.stops?.[0]?.id,
      pendingSync: false
    });
    setTripStorageWarning(ok ? '' : '实际执行路线未能写入本地存储，请保持当前页面打开。');
  }, [profile.id, routebook]);

  // 跨设备续行程：从服务端拉回本人已同步的打卡，回填本地进度；失败时静默降级本地记录。
  useEffect(() => {
    if (!routeId) return undefined;
    // 未注册（无 profile token）时服务端只会回 401/403，直接跳过回填、只用本地记录（对齐我的页做法）。
    if (!canSyncToCloud(profile)) return undefined;
    const ctrl = new AbortController();
    getMyCheckins(profile.id, 200, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        const serverRows = (Array.isArray(data?.checkins) ? data.checkins : []).filter((item) => String(item?.routeId ?? '') === routeId);
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
  }, [profile.id, profile.profileAccessToken, profile.accountUserId, routeId]);

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

  async function submitCheckin(data) {
    if (!current || currentProcessed || currentSyncPending || submittingCheckinRef.current) return;
    submittingCheckinRef.current = true;
    try {
      await submitCheckinRow(data);
    } finally {
      submittingCheckinRef.current = false;
    }
  }

  async function submitCheckinRow(data) {
    const { photoData, ...fields } = data ?? {};
    const row = buildPendingCheckin(routebook, current, profile, { status: 'visited', ...fields }, { type: 'visit' });
    if (photoData) {
      // F09: photos go to IndexedDB (Blob) and the queue row keeps a reference; without
      // IndexedDB we fall back to inlining (form caps it at <=400KB). The queue uploads
      // the photo first to get a photoId, then the check-in row.
      if (await stashCheckinPhoto(row.clientLocalId, photoData)) row.clientPhotoRef = row.clientLocalId;
      else row.clientPhotoData = photoData;
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
    const row = buildPendingCheckin(
      routebook,
      current,
      profile,
      {
        status: 'replaced',
        worth: '替换',
        comment: `行中替换为：${alternativeStop.name}`,
        replacementStopId: alternativeStop.id
      },
      { type: 'replace', replacementStop: alternativeStop, reason: alternative.reason }
    );
    queueAndApplyLocalAction(row);
  }

  function queueAndApplyLocalAction(row) {
    const previousRows = latestKnownCheckins();
    const nextRows = queueCheckin(previousRows, row);
    // 本地写入成功后才提交 React 状态，避免存储配额/隐私模式失败时误推进行程。
    if (!persistCheckins(nextRows)) {
      setModeNote('本地存储不可用，本次操作未生效；请释放空间或保持当前页面后重试。');
      return;
    }
    const actionPlan = applyLocalAction(row, { commitState: false });
    if (!actionPlan) {
      // 路线会话写失败时尽力回滚打卡行；即使回滚失败，React 状态仍不提交。
      persistCheckins(previousRows);
      setModeNote('行程状态未能写入本地存储，本次操作未生效；请保持当前页面后重试。');
      return;
    }
    commitCheckinsState(nextRows);
    applyLocalActionState(actionPlan);
    if (navigator.onLine === false) {
      setModeNote('已在这台设备上记下，可以继续走；联网后会自动同步并校验。');
      return;
    }
    void syncQueuedCheckins();
  }

  function applyLocalAction(row, { commitState = true } = {}) {
    const action = row.clientAction ?? {};
    if (action.type === 'replace' && action.replacementStop) {
      const alternativeStop = action.replacementStop;
      const nextStops = [
        ...stops.slice(0, effectiveIdx),
        alternativeStop,
        ...stops.slice(effectiveIdx + 1).filter((stop) => stopKeyForStop(stop) !== stopKeyForStop(alternativeStop))
      ];
      const extra = {
        currentStopId: alternativeStop.id,
        lastAction: { type: 'replace', stopId: current.id, replacementStopId: alternativeStop.id, at: row.time }
      };
      if (!persistTripRoute(nextStops, extra)) return null;
      const plan = {
        nextStops,
        nextIndex: effectiveIdx,
        message: `已在本地用 ${alternativeStop.name} 替换当前站${action.reason ? `：${action.reason}` : ''}`
      };
      if (commitState) applyLocalActionState(plan);
      return plan;
    }

    const tripStatus = action.type === 'skip' ? 'skipped' : 'visited';
    const updatedStops = stops.map((stop) => (stopKeyForStop(stop) === row.localStopKey ? { ...stop, tripStatus } : stop));
    const nextIndex = Math.min(effectiveIdx + 1, Math.max(0, updatedStops.length - 1));
    const extra = { currentStopId: updatedStops[nextIndex]?.id, lastAction: { type: action.type || 'visit', stopId: row.stopId, at: row.time } };
    if (!persistTripRoute(updatedStops, extra)) return null;
    const plan = {
      nextStops: updatedStops,
      nextIndex,
      message: action.type === 'skip' ? '已在本地跳过此站，并进入下一站。' : '到达已记录在本地，并进入下一站。'
    };
    if (commitState) applyLocalActionState(plan);
    return plan;
  }

  function applyLocalActionState(plan) {
    if (!plan) return;
    setActiveStops(plan.nextStops);
    setCurrentIdx(plan.nextIndex);
    setModeNote(plan.message);
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
      const terminalCount = checkinsRef.current.filter((item) => item?.clientSyncStatus === 'failed' && item.clientSyncRetryable === false).length;
      if (terminalCount) {
        setModeNote(`${terminalCount} 条记录没传上去，需要手动重试；其他可同步记录已继续处理${synced ? `，本次成功 ${synced} 条` : ''}。`);
      } else {
        setModeNote(`${failed} 条记录暂未同步成功，将在 15 秒后自动重试${synced ? `；本次已成功 ${synced} 条` : ''}。`);
      }
    } else if (synced) {
      setModeNote(`已同步 ${synced} 条，每条是否计入可信度见下方状态。`);
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
      const queued = commitCheckins(requeueCheckin(checkinsRef.current, statusCheckin.clientLocalId));
      setModeNote(queued ? '已将此条记录重新加入同步队列。' : '本地存储不可用，未能重新加入同步队列；请稍后重试。');
    }
    void syncQueuedCheckins();
  }

  function persistCheckins(rows) {
    // 截断上限与迁移侧一致（120），且优先丢弃已同步行、保住 queued/failed 行。
    const ok = safeWriteJsonStorage(storageKey, capCheckinRows(rows));
    setStorageWarning(ok ? '' : '手机存储空间不够，这条反馈先留在当前页面，正在上传。');
    return ok;
  }

  function commitCheckins(rows) {
    if (!persistCheckins(rows)) return false;
    commitCheckinsState(rows);
    return true;
  }

  function commitCheckinsState(rows) {
    const nextRows = capCheckinRows(rows);
    checkinsRef.current = nextRows;
    setCheckins(nextRows);
  }

  function openNavigation() {
    if (!current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setModeNote('需要网络：联网后才能打开高德导航。行程和地址离线也能看。');
      return;
    }
    if (!isNavigableCoordinate(current)) {
      // 位置没核准：不导航到猜的坐标，改为在高德按名字搜，让用户自己挑。
      window.open(amapNameSearchUrl(current, routebook.city), '_blank', 'noopener,noreferrer');
      return;
    }
    window.open(
      `https://uri.amap.com/navigation?to=${current.lng},${current.lat},${encodeURIComponent(current.name)}&mode=${navigation.mode}&src=trusted-routebook&coordinate=wgs84&callnative=1`,
      '_blank',
      'noopener,noreferrer'
    );
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
    const ok = saveTripSession(routebook, profile.id, { stops: nextStops, ...extra, pendingSync: true });
    setTripStorageWarning(ok ? '' : '实际执行路线未能写入本地存储，请保持当前页面打开。');
    if (ok) tripCloud.sync();
    return ok;
  }

  if (!current)
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 pt-24 text-center">
        <p className="text-muted">这条路书还没有站点</p>
        <Button onClick={onBack}>返回</Button>
      </div>
    );

  const theme = dayTheme(Math.max(0, (routebook.days ?? []).indexOf(current.day)));
  const actionDisabled = currentProcessed || currentSyncPending || isFinished;
  const notes = [modeNote, storageWarning, tripStorageWarning].filter(Boolean);

  return (
    <div className="min-h-dvh bg-canvas pb-[calc(96px+env(safe-area-inset-bottom))] text-ink lg:pb-12">
      {/* Sticky header with progress */}
      <header className="sticky top-0 z-[1200] border-b border-line bg-white/94 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1180px] items-center gap-3 px-4 lg:px-8">
          <Button size="icon" onClick={onBack} aria-label="退出行中">
            <X />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-copy font-extrabold">{routebook.title}</p>
            <p className="truncate text-meta text-muted">{review}</p>
          </div>
          <TripSyncBadge state={tripCloud.state} />
          <span className="num shrink-0 rounded-full bg-ink px-3 py-1.5 text-sm text-white">
            {effectiveIdx + 1} / {stops.length}
          </span>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          {tripCloud.state.message}
        </p>
        <div className="h-1.5 bg-line" role="progressbar" aria-label="行程进度" aria-valuenow={Math.min(100, progress)} aria-valuemin={0} aria-valuemax={100}>
          <div
            className="h-full rounded-r-full transition-[width] duration-500"
            style={{ width: `${Math.min(100, progress)}%`, backgroundImage: `linear-gradient(90deg, ${theme.from}, ${theme.to})` }}
          />
        </div>
      </header>

      <div className="mx-auto grid max-w-[1180px] grid-cols-[minmax(0,1fr)] gap-5 px-4 pt-5 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8 lg:px-8 lg:pt-8">
        <div className="flex min-w-0 flex-col gap-4">
          {(tripCloud.state.status === 'error' || tripCloud.state.status === 'conflict') && (
            <section className="rounded-card bg-lemon-soft px-4 py-3 text-sm text-lemon-ink" aria-label="行中计划同步">
              <p className="flex items-start gap-2 font-semibold">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {tripCloud.state.message}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                {tripCloud.state.status === 'error' ? (
                  <Button size="sm" variant="outline" onClick={tripCloud.retry}>
                    重试同步
                  </Button>
                ) : (
                  <>
                    <Button size="sm" variant="outline" onClick={() => tripCloud.resolveConflict(true)}>
                      加载云端计划
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => tripCloud.resolveConflict(false)}>
                      保留本机计划并同步
                    </Button>
                  </>
                )}
              </div>
            </section>
          )}
          {!trustedCities.includes(routebook.city) && (
            <p className="rounded-card bg-lemon-soft px-4 py-3 text-sm font-semibold text-lemon-ink" role="status">
              {routebook.city}还在试运行：地点、营业时间和导航请出发前自己再核对。
            </p>
          )}

          {/* Current stop */}
          <section className="overflow-hidden rounded-panel bg-white shadow-card" aria-labelledby="trip-current-title">
            <StopThumb stop={current} number={effectiveIdx + 1} color={theme.ink} time={current.time} className="h-40 rounded-none sm:h-52" />
            <div className="p-5">
              <Chip tone={isFinished ? 'ok' : 'primary'}>
                {isFinished ? '全部完成' : currentProcessed ? checkinStatusLabel(currentLatest) : '现在在这一站'}
              </Chip>
              <h1 id="trip-current-title" className="mt-2.5 text-display-sm leading-tight font-extrabold tracking-tight lg:text-display-md">
                {current.name}
              </h1>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {current.time && (
                  <Chip size="sm">
                    <Clock /> {current.time}
                  </Chip>
                )}
                {current.stay && <Chip size="sm">停留 {String(current.stay).replace(/^停留\s*/, '')}</Chip>}
                {current.area && (
                  <Chip size="sm">
                    <MapPin /> {current.area}
                  </Chip>
                )}
                {!isNavigableCoordinate(current) && (
                  <Chip size="sm" tone="warn">
                    位置待确认
                  </Chip>
                )}
              </div>
              {current.risk && (
                <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-warn-soft px-3 py-2 text-sm font-semibold text-warn-ink">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden="true" />
                  {current.risk}
                </p>
              )}
              {next && !isFinished && (
                <div className="mt-4 flex items-center gap-3 rounded-card bg-canvas px-3.5 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-white text-ink-2 shadow-card">
                    <ChevronRight className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-meta text-muted">下一站 · {next.time}</p>
                    <p className="truncate text-copy font-bold">{next.name}</p>
                  </div>
                  {nextStopCountdown && (
                    <Chip size="sm" tone={nextStopCountdown.overdue ? 'warn' : 'ok'} className="shrink-0">
                      {nextStopCountdown.overdue ? (
                        // Exact overdue minutes ("超时 601 分钟") read as an alarm; the full figure stays in the tooltip/SR text.
                        <span title={nextStopCountdown.label}>
                          比建议晚了<span className="sr-only">：{nextStopCountdown.label}</span>
                        </span>
                      ) : (
                        nextStopCountdown.label.replace('距建议到达还有', '还有')
                      )}
                    </Chip>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Desktop actions (phones use the fixed bottom bar) */}
          <div className="hidden gap-3 lg:flex">
            <Button variant="primary" size="lg" className="flex-[2]" onClick={() => setShowCheckin(true)} disabled={actionDisabled}>
              <Camera /> {checkinLabel(isFinished, currentProcessed, currentSyncPending, currentLatest)}
            </Button>
            <Button variant="dark" size="lg" className="flex-1" onClick={openNavigation}>
              <Navigation /> {isNavigableCoordinate(current) ? navigation.label : '在高德按名字搜'}
            </Button>
          </div>

          <div className="flex flex-wrap gap-2" aria-label="临时调整">
            <Button size="sm" variant="outline" onClick={() => applyTripMode('少走路')}>
              <Footprints /> 少走点路
            </Button>
            <Button size="sm" variant="outline" onClick={() => applyTripMode('雨天')}>
              <CloudRain /> 下雨了
            </Button>
            <Button size="sm" variant="outline" onClick={skipStop} disabled={actionDisabled}>
              <SkipForward /> 跳过这站
            </Button>
          </div>
          {notes.map((note) => (
            <p key={note} className="rounded-card bg-sky-soft px-4 py-3 text-sm text-sky-ink" role="status">
              {note}
            </p>
          ))}

          {statusCheckin && (
            <div className="flex items-start gap-3 rounded-card bg-white p-4 shadow-card" role="status" aria-live="polite">
              <span
                className={cn(
                  'grid size-10 shrink-0 place-items-center rounded-full',
                  statusEvidence.syncStatus === 'synced'
                    ? 'bg-success-soft text-success-ink'
                    : statusEvidence.syncStatus === 'failed'
                      ? 'bg-primary-soft text-primary-strong'
                      : 'bg-sky-soft text-sky-ink'
                )}
              >
                {statusEvidence.syncStatus === 'synced' ? <CloudCheck className="size-5" /> : <CloudUpload className="size-5" />}
              </span>
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-bold">
                  {statusEvidence.localCompleted ? checkinStatusLabel(statusCheckin) : '还没记录'} ·{' '}
                  {syncStatusLabel(statusEvidence.syncStatus, statusCheckin, { cloudSyncOff })}
                </p>
                <p className="mt-0.5 text-meta text-muted">{publicTrustEvidenceLabel(statusCheckin, statusEvidence)}</p>
                {guestLocalOnly && statusEvidence.syncStatus !== 'synced' && (
                  <p className="mt-0.5 text-meta text-ink-2">
                    打卡先存在这台手机上。
                    <button
                      type="button"
                      className="font-bold underline underline-offset-2"
                      onClick={() => requireLogin('登录后，打卡和照片会自动上传，计入路线可信度。', () => setProfile(getProfile()))}
                    >
                      登录
                    </button>
                    后会自动上传，计入路线可信度。
                  </p>
                )}
                {cloudSyncOff && !guestLocalOnly && statusEvidence.syncStatus !== 'synced' && (
                  <p className="mt-0.5 text-meta text-ink-2">要让打卡计入路线可信度，请先在「我的 → 账号」开启云端同步，开启后会自动补传。</p>
                )}
                {pendingSyncCount > 1 && !cloudSyncOff && (
                  <p className="mt-0.5 text-meta text-muted">另有 {pendingSyncCount - 1} 条记录等待上传，联网后会自动补传。</p>
                )}
                {statusEvidence.syncStatus === 'failed' && statusCheckin.clientSyncError && (
                  <p className="mt-0.5 text-meta text-primary-strong">原因：{statusCheckin.clientSyncError}</p>
                )}
              </div>
              {pendingSyncCount > 0 && (
                <Button size="sm" onClick={handleSyncAction} disabled={queueFlushing}>
                  <RefreshCw /> {queueFlushing ? '上传中' : statusEvidence.syncStatus === 'failed' ? '重试' : '立即上传'}
                </Button>
              )}
            </div>
          )}

          <details className="group rounded-card bg-white shadow-card">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5">
              <span className="min-w-0">
                <span className="block text-copy font-bold">{current?.name ? `「${current.name}」附近的替代点与设施` : '附近替代点与设施'}</span>
                <span className="block text-meta text-muted">以当前计划站点为中心，不是你的实时位置</span>
              </span>
              <span className="text-meta text-muted">{nearbyItems.length} 个</span>
            </summary>
            <div className="flex flex-wrap gap-2 border-t border-line p-3" aria-label="附近地点筛选">
              {NEARBY_FILTERS.map((filter) => (
                <Button
                  key={filter.value}
                  size="sm"
                  variant={nearbyFilter === filter.value ? 'dark' : 'outline'}
                  aria-pressed={nearbyFilter === filter.value}
                  onClick={() => setNearbyFilter(filter.value)}
                >
                  {filter.label}
                </Button>
              ))}
            </div>
            <div className="grid gap-2 p-3 pt-0 sm:grid-cols-2">
              {nearbyVisible.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() =>
                    item.kind === 'alternative'
                      ? applyAlternative(item)
                      : window.open(
                          `https://uri.amap.com/navigation?to=${item.stop.lng},${item.stop.lat},${encodeURIComponent(item.stop.name)}&mode=walk&src=trusted-routebook&coordinate=wgs84&callnative=1`,
                          '_blank',
                          'noopener,noreferrer'
                        )
                  }
                  disabled={item.kind === 'alternative' ? actionDisabled : !item.canNavigate}
                  className="flex items-center gap-3 rounded-tile bg-canvas p-2.5 text-left hover:bg-line disabled:opacity-50"
                >
                  <StopThumb stop={item.stop} compact className="size-12 shrink-0 rounded-xl" />
                  <span className="min-w-0">
                    <b className="block truncate text-copy">{item.name}</b>
                    <span className="line-clamp-2 text-meta text-muted">
                      {item.type} · {item.reason}
                    </span>
                  </span>
                </button>
              ))}
              {!nearbyVisible.length && (
                <p className="p-2 text-sm text-muted">
                  暂无已核验位置的{NEARBY_FILTERS.find((filter) => filter.value === nearbyFilter)?.label || '附近地点'}。设施类型不会根据名称猜测。
                </p>
              )}
            </div>
          </details>

          {checkins.length > 0 && (
            <div className="rounded-card bg-white p-4 text-center shadow-card">
              <p className="text-sm text-ink-2">
                到达验证 <b className="num">{progressStats.validArrivals}</b> 站 · 计入可信度 <b className="num">{progressStats.publicTrustSamples}</b> 站
              </p>
              <p className="mt-1 text-meta text-muted">
                普通反馈 {progressStats.feedbackOnly} 站 · 定位偏离 {progressStats.lowConfidenceArrivals} 次 · 跳过 {progressStats.skipped} 站 · 替换{' '}
                {progressStats.replaced} 次
              </p>
              <Button size="sm" variant="ghost" className="mt-2 text-sky-ink" onClick={onReview}>
                <BookOpen /> {isFinished ? '生成这趟旅程的回顾' : '看看目前的回顾'}
              </Button>
              {isFinished && onAdoptTrip && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    if (window.confirm('把行中的顺序和替换写回主路书？可在路书页再撤销。')) {
                      onAdoptTrip(stops);
                    }
                  }}
                >
                  把今日改动写回路书
                </Button>
              )}
            </div>
          )}
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start" aria-label="行程总览">
          <div className="rounded-panel bg-white p-4 shadow-card lg:p-5">
            <h2 className="mb-3 text-lg font-extrabold">行程总览</h2>
            <ol className="relative flex flex-col gap-1 before:absolute before:top-4 before:bottom-4 before:left-[15px] before:border-l-2 before:border-dotted before:border-line-strong before:content-['']">
              {stops.map((stop, idx) => {
                const stopCheckin = latestByStop.get(stopKeyForStop(stop));
                const processed = isLocallyProcessedCheckin(stopCheckin);
                const statusKind = checkinStatusKind(stopCheckin);
                const state = processed ? 'done' : idx === effectiveIdx ? 'current' : 'upcoming';
                return (
                  <li
                    key={stopKeyForStop(stop) || idx}
                    className={cn('relative flex items-center gap-3 rounded-tile px-0 py-1.5', state === 'current' && 'bg-primary-soft/60')}
                  >
                    <span
                      className={cn(
                        'num relative z-[1] grid size-8 shrink-0 place-items-center rounded-full border-2 border-white text-meta',
                        state === 'done' && 'bg-success-ink text-white',
                        state === 'current' && 'bg-primary-strong text-white shadow-[0_0_0_3px_rgba(232,85,61,.25)]',
                        state === 'upcoming' && 'bg-canvas text-ink-2'
                      )}
                      aria-hidden="true"
                    >
                      {processed ? checkinStatusIcon(statusKind) : idx + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate text-copy font-bold', state === 'done' && 'text-muted line-through decoration-1')}>{stop.name}</p>
                      <p className="truncate text-meta text-muted">{[stop.day, stop.time, stop.area].filter(Boolean).join(' · ')}</p>
                    </div>
                    {state === 'current' && (
                      <Chip size="sm" tone="primary" className="mr-2">
                        当前
                      </Chip>
                    )}
                    {state === 'done' && (
                      <Chip size="sm" tone="ok" className="mr-2">
                        {checkinStatusLabel(stopCheckin)}
                      </Chip>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </aside>
      </div>

      {/* Phone action bar */}
      {/* @container: when the bar is narrower than 22rem (320px phones, or a large system font
          that grows rem), 导航 collapses to its icon so the check-in label keeps one line. */}
      <div className="@container fixed inset-x-0 bottom-0 z-[1300] flex gap-2.5 border-t border-line bg-white/96 px-4 pt-2.5 pb-[calc(10px+env(safe-area-inset-bottom))] backdrop-blur-md lg:hidden">
        <Button
          variant="dark"
          size="lg"
          className="h-[54px] flex-1 text-base @max-[22rem]:flex-none @max-[22rem]:px-3"
          onClick={openNavigation}
          aria-label={isNavigableCoordinate(current) ? '导航' : '在高德按名字搜'}
        >
          <Navigation /> <span className="@max-[22rem]:sr-only">{isNavigableCoordinate(current) ? '导航' : '按名字搜'}</span>
        </Button>
        <Button
          variant="primary"
          size="lg"
          className="h-auto min-h-[54px] min-w-0 flex-[2] py-2 text-base leading-tight whitespace-normal @max-[22rem]:flex-1 @max-[22rem]:gap-1.5 @max-[22rem]:rounded-2xl @max-[22rem]:px-3"
          onClick={() => setShowCheckin(true)}
          disabled={actionDisabled}
        >
          <Camera /> {checkinLabel(isFinished, currentProcessed, currentSyncPending, currentLatest)}
        </Button>
      </div>

      <Drawer open={showCheckin} onOpenChange={setShowCheckin}>
        <DrawerContent title={`记录到达 · ${current.name}`} description="都是选填。开了 GPS 并确认你到了这里的记录，才计入路线可信度。">
          <CheckinForm onSubmit={submitCheckin} onCancel={() => setShowCheckin(false)} />
        </DrawerContent>
      </Drawer>
    </div>
  );
}

function checkinStatusKind(row) {
  if (!row) return '';
  const actionType = row.clientAction?.type;
  if (row.status === 'skipped' || row.worth === '跳过' || actionType === 'skip') return 'skipped';
  if (row.status === 'replaced' || row.worth === '替换' || actionType === 'replace') return 'replaced';
  if (row.status === 'visited' || actionType === 'visit' || row.worth || row.arrival || row.arrivalConfidence) return 'visited';
  return 'recorded';
}

function checkinStatusLabel(row) {
  const labels = { visited: '已到达', skipped: '已跳过', replaced: '已替换', recorded: '已记录' };
  return labels[checkinStatusKind(row)] || '已记录';
}

function checkinStatusIcon(kind) {
  if (kind === 'skipped') return <SkipForward className="size-4" />;
  if (kind === 'replaced') return <RefreshCw className="size-4" />;
  return <Check className="size-4" />;
}

function checkinLabel(isFinished, processed, syncing, row) {
  if (isFinished) return '全部完成';
  if (processed) return checkinStatusLabel(row);
  if (syncing) return '上传中';
  return '我到了，记录一下';
}

const TRIP_SYNC_BADGES = {
  local: { icon: CloudOff, label: '本机', className: 'bg-canvas text-muted' },
  loading: { icon: RefreshCw, label: '同步中', className: 'bg-sky-soft text-sky-ink', spin: true },
  syncing: { icon: RefreshCw, label: '同步中', className: 'bg-sky-soft text-sky-ink', spin: true },
  synced: { icon: CloudCheck, label: '已同步', className: 'bg-success-soft text-success-ink' },
  error: { icon: TriangleAlert, label: '未同步', className: 'bg-lemon-soft text-lemon-ink' },
  conflict: { icon: TriangleAlert, label: '有冲突', className: 'bg-lemon-soft text-lemon-ink' }
};

/** Compact cloud-sync state for the trip header; the full message is announced via the live region. */
function TripSyncBadge({ state }) {
  const badge = TRIP_SYNC_BADGES[state?.status] ?? TRIP_SYNC_BADGES.local;
  const Icon = badge.icon;
  return (
    <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-meta font-bold ${badge.className}`} title={state?.message}>
      <Icon className={`size-3.5 ${badge.spin ? 'motion-safe:animate-spin' : ''}`} aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{badge.label}</span>
    </span>
  );
}
