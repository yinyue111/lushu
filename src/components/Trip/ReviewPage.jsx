import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, MapPin, FileText, DollarSign, Clock, AlertTriangle, Share2, Shield, CheckCircle, XCircle } from 'lucide-react';
import { checkinPhotoUrl, createReviewShare, getMyCheckins } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { checkinStorageKey } from '../../lib/storage';
import { normalizeTripStops, readTripSession, tripRoutebookId } from '../../lib/tripSession';
import { flushAllCheckinQueues, isServerSyncedCheckin } from '../../lib/checkinQueue';

export default function ReviewPage({ routebook, onBack }) {
  // 打开回顾页会触发一次全局补传；补传可能注册身份并迁移本地存储 key，因此 profile 用 state。
  const [profile, setProfile] = useState(() => getProfile());
  const [shareState, setShareState] = useState({ loading: false, message: '', url: '' });
  const [serverCheckins, setServerCheckins] = useState([]);
  const [localTick, setLocalTick] = useState(0);
  const storageKey = checkinStorageKey(routebook, profile.id);
  const routeId = tripRoutebookId(routebook);
  const tripSession = useMemo(() => readTripSession(routebook, profile.id), [profile.id, routebook]);
  const localCheckins = useMemo(
    () => safeReadCheckins(storageKey).filter((item) => sameRoute(item, routeId)),
    // localTick 变化时重读本地存储（补传完成后刷新）。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localTick is a cache-busting tick.
    [routeId, storageKey, localTick]
  );
  const checkins = useMemo(
    () =>
      mergeCheckins(
        localCheckins,
        serverCheckins.filter((item) => sameRoute(item, routeId))
      ),
    [localCheckins, routeId, serverCheckins]
  );
  const stops = tripSession?.stops?.length ? tripSession.stops : normalizeTripStops(routebook);
  const latestByStop = useMemo(() => latestCheckinsByStop(checkins), [checkins]);
  const photoCheckins = useMemo(() => [...latestByStop.values()].filter((item) => String(item?.photoId ?? '').trim()), [latestByStop]);
  const isPublic = ['published', 'featured'].includes(routebook.publishStatus);
  const dayCount = new Set(stops.map((stop) => stop.day || 'Day 1')).size || 1;

  const stats = useMemo(() => computeStats(checkins, stops), [checkins, stops]);

  // 打开回顾页时触发一次离线队列全局补传，完成后刷新本地记录。
  useEffect(() => {
    let cancelled = false;
    flushAllCheckinQueues({ profile })
      .then(() => {
        if (cancelled) return;
        const latest = getProfile();
        // 注册可能只补发 token 而不换 id：token 变化也要刷新，让服务端拉取生效。
        if (latest.id !== profile.id || latest.profileAccessToken !== profile.profileAccessToken) {
          setProfile(latest);
        }
        setLocalTick((tick) => tick + 1);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // 仅在打开时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on open.
  }, []);

  useEffect(() => {
    // 未注册（无 profile token）时服务端只会回 401/403，直接跳过拉取、只用本地记录（对齐我的页做法）。
    if (!profile.profileAccessToken) return undefined;
    const ctrl = new AbortController();
    getMyCheckins(profile.id, 200, ctrl.signal)
      .then((data) => setServerCheckins(data.checkins ?? []))
      .catch(() => {});
    return () => ctrl.abort();
  }, [profile.id, profile.profileAccessToken, localTick]);

  return (
    <div className="container page-enter" style={{ paddingTop: 40, paddingBottom: 60, maxWidth: 680, margin: '0 auto' }}>
      <button className="btn btn-ghost btn-sm" onClick={onBack} style={{ marginBottom: 24 }}>
        <ArrowLeft size={16} /> 返回路书
      </button>

      {/* Hero */}
      <div className="card review-hero">
        <span className="badge badge-green">
          <Shield size={12} /> 实际执行回顾
        </span>
        <h1 className="text-title" style={{ marginTop: 12 }}>
          {routebook.title}
        </h1>
        <p className="text-caption" style={{ marginTop: 6 }}>
          {routebook.city} · {dayCount} 天 · {stops.length} 站
        </p>

        <div className="review-stats-grid">
          <div className="review-stat">
            <CheckCircle size={18} style={{ color: 'var(--green)' }} />
            <strong>{stats.syncedCount === 0 && stats.pendingCount > 0 ? '待同步' : `${stats.completionRate}%`}</strong>
            <span>有效到达率</span>
          </div>
          <div className="review-stat">
            <DollarSign size={18} style={{ color: 'var(--blue)' }} />
            <strong>{stats.totalCost}</strong>
            <span>实际花费</span>
          </div>
          <div className="review-stat">
            <Clock size={18} style={{ color: 'var(--orange)' }} />
            <strong>{stats.avgQueue}</strong>
            <span>平均排队</span>
          </div>
          <div className="review-stat">
            <AlertTriangle size={18} style={{ color: 'var(--red)' }} />
            <strong>{stats.pitfalls}</strong>
            <span>踩坑反馈</span>
          </div>
        </div>
        <p className="text-caption" style={{ marginTop: 12 }}>
          已服务端校验 {stats.syncedCount} 条 · 本地待同步 {stats.pendingCount} 条
          {stats.pendingCount > 0 && '（待同步记录不计入有效到达率，恢复网络后会自动补传）'}
        </p>
      </div>

      {/* Timeline */}
      <div className="review-timeline" style={{ marginTop: 24 }}>
        <h2 className="text-subtitle" style={{ marginBottom: 16 }}>
          行程轨迹
        </h2>
        {stops.map((stop, idx) => {
          const checkin = latestByStop.get(stopKeyForStop(stop));
          const wasSkipped = stop.tripStatus === 'skipped' || checkin?.worth === '跳过' || checkin?.status === 'skipped';
          const hasResult = Boolean(checkin || wasSkipped);
          return (
            <div key={stop.id ?? idx} className={`review-stop ${hasResult ? (wasSkipped ? 'skipped' : 'done') : 'missed'}`}>
              <div className="review-stop-marker">
                {checkin && !wasSkipped ? (
                  <CheckCircle size={16} style={{ color: 'var(--green)' }} />
                ) : wasSkipped ? (
                  <XCircle size={16} style={{ color: 'var(--muted)' }} />
                ) : (
                  <MapPin size={16} style={{ color: 'var(--muted-2)' }} />
                )}
              </div>
              <div className="review-stop-content">
                <div className="review-stop-header">
                  <strong>{stop.name}</strong>
                  <span className="text-micro">{stop.time}</span>
                </div>
                {checkin && !wasSkipped && (
                  <div className="review-stop-feedback">
                    {!isServerSyncedCheckin(checkin) && <span className="badge badge-orange">待同步（本地）</span>}
                    {checkin.worth && (
                      <span className={`badge ${checkin.worth === '值得' ? 'badge-green' : checkin.worth === '踩坑' ? 'badge-red' : 'badge-orange'}`}>
                        {checkin.worth}
                      </span>
                    )}
                    {checkin.queue && (
                      <span className="text-micro">
                        <Clock size={10} /> {checkin.queue}
                      </span>
                    )}
                    {checkin.cost && (
                      <span className="text-micro">
                        <DollarSign size={10} /> {checkin.cost}
                      </span>
                    )}
                    {checkin.crowd && <span className="text-micro">拥挤: {checkin.crowd}</span>}
                  </div>
                )}
                {checkin?.comment && (
                  <p className="text-caption" style={{ marginTop: 4 }}>
                    {checkin.comment}
                  </p>
                )}
                {checkin?.pitfall && (
                  <p className="text-caption" style={{ marginTop: 2, color: 'var(--red)' }}>
                    踩坑: {checkin.pitfall}
                  </p>
                )}
                {checkin?.photoId && (
                  <a href={checkinPhotoUrl(checkin.photoId)} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6 }}>
                    <img
                      src={checkinPhotoUrl(checkin.photoId)}
                      alt={`${stop.name}打卡照片`}
                      loading="lazy"
                      style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8 }}
                    />
                  </a>
                )}
                {checkin?.photoName && !checkin?.photoId && (
                  <p className="text-micro" style={{ marginTop: 4 }}>
                    <FileText size={10} /> 历史记录仅保留文件名（非照片证据）：{checkin.photoName}
                  </p>
                )}
                {wasSkipped && (
                  <p className="text-caption" style={{ color: 'var(--muted)' }}>
                    已跳过
                  </p>
                )}
                {!checkin && !wasSkipped && (
                  <p className="text-caption" style={{ color: 'var(--muted-2)' }}>
                    未打卡
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {photoCheckins.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2 className="text-subtitle" style={{ marginBottom: 12 }}>
            打卡照片墙
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(96px, 1fr))', gap: 8 }}>
            {photoCheckins.map((item) => (
              <a key={item.photoId} href={checkinPhotoUrl(item.photoId)} target="_blank" rel="noreferrer" title={item.stopName || '打卡照片'}>
                <img
                  src={checkinPhotoUrl(item.photoId)}
                  alt={`${item.stopName || '打卡'}照片`}
                  loading="lazy"
                  style={{ width: '100%', height: 96, objectFit: 'cover', borderRadius: 8 }}
                />
              </a>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 32, textAlign: 'center' }}>
        <button className="btn btn-primary btn-lg" onClick={createShare} disabled={shareState.loading || !isPublic}>
          <Share2 size={18} /> {shareState.loading ? '生成中...' : '生成回顾分享页'}
        </button>
        <p className="text-caption" style={{ marginTop: 8 }}>
          {isPublic ? '分享后其他用户能看到可信分、有效 GPS 到达率和你的真实反馈' : '路书发布后才能生成公开回顾页'}
        </p>
        {shareState.url && (
          <p className="text-caption" style={{ marginTop: 8, wordBreak: 'break-all' }}>
            {shareState.url}
          </p>
        )}
        {shareState.message && (
          <p className="text-caption" style={{ marginTop: 8 }}>
            {shareState.message}
          </p>
        )}
      </div>
    </div>
  );

  async function createShare() {
    if (!isPublic) {
      setShareState({ loading: false, message: '请先在路书页发布 H5 链接，再生成公开回顾', url: '' });
      return;
    }
    setShareState({ loading: true, message: '', url: '' });
    try {
      // 服务端只信任已持久化并通过身份校验的打卡，忽略客户端上送的 checkins，因此不再传该字段。
      const data = await createReviewShare({ routebookId: routeId, executionStops: stops, profileId: profile.id });
      const url = new URL(data.shareUrl, window.location.origin).toString();
      // 对比服务端回顾统计与本地记录数，提示未进入公开回顾的记录；
      // 本地还有待同步行时缺口大概率是同步滞后而非身份问题，按待同步归因。
      const serverCount = Number(data?.review?.stats?.checkinCount ?? 0);
      const missingCount = Math.max(0, stats.recordCount - serverCount);
      const missingNote =
        missingCount > 0
          ? stats.pendingCount > 0
            ? `；${stats.pendingCount} 条记录待同步，同步完成后会进入公开回顾`
            : `；${missingCount} 条记录因身份未验证未进入公开回顾`
          : '';
      setShareState({ loading: false, message: `已生成实际执行路线回顾链接${missingNote}`, url });
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(url);
        setShareState({ loading: false, message: `已生成并复制实际执行路线回顾链接${missingNote}`, url });
      } catch {
        setShareState({ loading: false, message: `回顾链接已生成；浏览器未允许自动复制，请手动复制下方链接${missingNote}`, url });
      }
    } catch (error) {
      setShareState({ loading: false, message: error.message, url: '' });
    }
  }
}

function safeReadCheckins(storageKey) {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function mergeCheckins(localRows, serverRows) {
  const map = new Map();
  for (const row of [...serverRows, ...localRows]) {
    // 优先按 clientLocalId 去重：同一条打卡的服务端行（先入 map）胜过本地待同步副本。
    const key =
      String(row?.clientLocalId ?? '').trim() ||
      `${row.routeId ?? ''}:${row.localStopKey ?? row.stopId ?? ''}:${row.createdAt ?? row.time ?? ''}:${row.status ?? ''}`;
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) => String(a.createdAt ?? a.time ?? '').localeCompare(String(b.createdAt ?? b.time ?? '')));
}

function sameRoute(item, routeId) {
  return Boolean(routeId && String(item?.routeId ?? '') === String(routeId));
}

function computeStats(checkins, stops) {
  const stopIds = new Set((stops ?? []).map(stopKeyForStop));
  const latestRows = [...latestCheckinsByStop(checkins).entries()].filter(([key]) => stopIds.has(key)).map(([, row]) => row);
  // 区分已服务端校验与本地待同步：待同步行保留展示，但不计入有效到达率。
  const syncedRows = latestRows.filter(isServerSyncedCheckin);
  const pendingCount = latestRows.length - syncedRows.length;
  const feedbackCheckins = latestRows.filter((c) => c.worth !== '跳过' && c.status !== 'skipped');
  const validCheckins = syncedRows.filter((c) => c.worth !== '跳过' && c.status !== 'skipped' && (c.arrival?.valid || c.arrivalConfidence === 'valid'));
  const completionRate = stops.length ? Math.min(100, Math.round((validCheckins.length / stops.length) * 100)) : 0;

  let totalCost = 0;
  let queueMinutes = [];
  let pitfalls = 0;

  for (const c of feedbackCheckins) {
    const costNum = parseInt(String(c.cost ?? '').replace(/[^\d]/g, ''), 10);
    if (costNum > 0) totalCost += costNum;
    const queueNum = parseInt(String(c.queue ?? '').replace(/[^\d]/g, ''), 10);
    if (queueNum > 0) queueMinutes.push(queueNum);
    if (c.worth === '踩坑' || c.pitfall) pitfalls++;
  }

  const avgQueue = queueMinutes.length ? `${Math.round(queueMinutes.reduce((a, b) => a + b, 0) / queueMinutes.length)} 分钟` : '无数据';

  return {
    completionRate,
    totalCost: totalCost > 0 ? `${totalCost} 元` : '无数据',
    avgQueue,
    pitfalls: `${pitfalls} 条`,
    syncedCount: syncedRows.length,
    pendingCount,
    recordCount: latestRows.length
  };
}

// 不再丢弃未同步行：queued/syncing/failed 的本地记录也进入站点状态，由调用方标注「待同步（本地）」。
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
