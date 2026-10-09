import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, Clock, FileText, Flag, MapPin, Share2, ShieldCheck, Wallet, X } from 'lucide-react';
import { createReviewShare, getMyCheckins } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { checkinStorageKey } from '../../lib/storage';
import { normalizeTripStops, readTripSession, tripRoutebookId } from '../../lib/tripSession';
import { flushAllCheckinQueues, isServerSyncedCheckin } from '../../lib/checkinQueue';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { StopThumb } from '../visual/StopThumb';
import { CheckinPhoto } from '../visual/CheckinPhoto';
import { dayTheme } from '../visual/theme';

/** @param {Record<string, any>} props */
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

  const days = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const doneCount = stops.filter((stop) => {
    const checkin = latestByStop.get(stopKeyForStop(stop));
    return checkin && !(checkin.worth === '跳过' || checkin.status === 'skipped');
  }).length;

  return (
    <div className="page-enter mx-auto max-w-[760px] px-4 pt-5 pb-16 lg:pt-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2">
        <ArrowLeft /> 返回路书
      </Button>

      <section className="relative isolate mt-3 overflow-hidden rounded-panel p-5 text-white shadow-pop lg:p-7">
        <div className="absolute inset-0 -z-10 bg-[linear-gradient(135deg,#157a51_0%,#1e9e6a_45%,#1666c1_100%)]" aria-hidden="true" />
        <Flag className="absolute -right-6 -bottom-8 -z-10 size-48 text-white/10" strokeWidth={1.2} aria-hidden="true" />
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-xs font-bold backdrop-blur">
          <ShieldCheck className="size-3.5" aria-hidden="true" /> 旅程回顾 · 按真实打卡统计
        </span>
        <h1 className="mt-3 text-2xl leading-tight font-black tracking-tight lg:text-3xl">{routebook.title}</h1>
        <p className="mt-1 text-sm text-white/85">
          {routebook.city} · {dayCount} 天 · {stops.length} 站 · 打卡 {doneCount} 站
        </p>
        <dl className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <HeroStat label="有效到达率" value={stats.syncedCount === 0 && stats.pendingCount > 0 ? '待同步' : `${stats.completionRate}%`} />
          <HeroStat label="实际花费" value={stats.totalCost} />
          <HeroStat label="平均排队" value={stats.avgQueue} />
          <HeroStat label="踩坑反馈" value={stats.pitfalls} />
        </dl>
        <p className="mt-4 text-xs text-white/85">
          已经服务器确认 {stats.syncedCount} 条 · 手机里待上传 {stats.pendingCount} 条
          {stats.pendingCount > 0 && '（待上传的记录暂不计入到达率，联网后会自动补传）'}
        </p>
      </section>

      <section className="mt-8" aria-labelledby="review-timeline">
        <h2 id="review-timeline" className="text-xl font-extrabold">
          这一路怎么走的
        </h2>
        {days.map((day, dayIndex) => {
          const theme = dayTheme(dayIndex);
          const dayStops = stops.filter((stop) => (stop.day || 'Day 1') === day);
          return (
            <div key={day} className="mt-4">
              <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-extrabold text-white" style={{ background: theme.ink }}>
                {day}
              </span>
              <ol className="relative mt-3 grid gap-3 pl-9 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-0.5 before:rounded-full before:bg-line">
                {dayStops.map((stop, idx) => {
                  const checkin = latestByStop.get(stopKeyForStop(stop));
                  const wasSkipped = stop.tripStatus === 'skipped' || checkin?.worth === '跳过' || checkin?.status === 'skipped';
                  const done = Boolean(checkin) && !wasSkipped;
                  return (
                    <li key={stop.id ?? idx} className="relative">
                      <span
                        className={cn(
                          'absolute top-3 -left-9 grid size-7 place-items-center rounded-full border-2 border-white shadow-card',
                          done ? 'text-white' : wasSkipped ? 'bg-canvas text-muted' : 'bg-white text-muted-2'
                        )}
                        style={done ? { background: theme.ink } : undefined}
                        aria-hidden="true"
                      >
                        {done ? <Check className="size-4" strokeWidth={3} /> : wasSkipped ? <X className="size-3.5" /> : <MapPin className="size-3.5" />}
                      </span>
                      <article
                        className={cn(
                          'rounded-card border p-3.5',
                          done
                            ? 'border-line bg-white shadow-card'
                            : 'border-dashed border-line-strong bg-[repeating-linear-gradient(135deg,#fff_0_10px,#f6f6f4_10px_20px)]'
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <StopThumb stop={stop} compact className="size-12 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline justify-between gap-2">
                              <strong className="truncate text-copy font-extrabold">{stop.name}</strong>
                              <span className="num shrink-0 text-xs font-bold text-muted">{stop.time}</span>
                            </div>
                            {done ? (
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                                {!isServerSyncedCheckin(checkin) && <Tag tone="warn">待上传</Tag>}
                                {checkin.worth && <Tag tone={checkin.worth === '值得' ? 'ok' : checkin.worth === '踩坑' ? 'bad' : 'warn'}>{checkin.worth}</Tag>}
                                {checkin.queue && (
                                  <span className="inline-flex items-center gap-1 text-ink-2">
                                    <Clock className="size-3.5 text-muted" aria-hidden="true" /> 排队 {checkin.queue}
                                  </span>
                                )}
                                {checkin.cost && (
                                  <span className="inline-flex items-center gap-1 text-ink-2">
                                    <Wallet className="size-3.5 text-muted" aria-hidden="true" /> {checkin.cost}
                                  </span>
                                )}
                                {checkin.crowd && <span className="text-ink-2">人流 {checkin.crowd}</span>}
                              </div>
                            ) : (
                              <p className="mt-1 text-sm font-semibold text-muted">{wasSkipped ? '这站跳过了' : '没有打卡'}</p>
                            )}
                          </div>
                        </div>
                        {checkin?.comment && <p className="mt-2 text-sm text-ink-2">“{checkin.comment}”</p>}
                        {checkin?.pitfall && (
                          <p className="mt-1.5 flex items-start gap-1.5 text-sm font-semibold text-danger">
                            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> 踩坑：{checkin.pitfall}
                          </p>
                        )}
                        {checkin?.photoId && (
                          <CheckinPhoto photoId={checkin.photoId} profileId={profile.id} access="owner" alt={`${stop.name}打卡照片`} className="mt-2 size-20" />
                        )}
                        {checkin?.photoName && !checkin?.photoId && (
                          <p className="mt-1.5 flex items-center gap-1 text-xs text-muted">
                            <FileText className="size-3.5" aria-hidden="true" /> 旧记录只留了文件名（不算照片证据）：{checkin.photoName}
                          </p>
                        )}
                      </article>
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </section>

      {photoCheckins.length > 0 && (
        <section className="mt-8" aria-labelledby="review-photos">
          <h2 id="review-photos" className="text-xl font-extrabold">
            打卡照片墙
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-4">
            {photoCheckins.map((item) => (
              <CheckinPhoto
                key={item.photoId}
                photoId={item.photoId}
                profileId={profile.id}
                access="owner"
                alt={`${item.stopName || '打卡'}照片`}
                className="aspect-square w-full"
                imageClassName="transition-transform hover:scale-105"
              />
            ))}
          </div>
        </section>
      )}

      <section className="mt-10 rounded-panel border border-line bg-white p-5 text-center shadow-card">
        <h2 className="text-lg font-extrabold">把这次旅程分享出去</h2>
        <p className="mx-auto mt-1 max-w-md text-sm text-muted">
          {isPublic ? '朋友能看到可信分、GPS 有效到达率和你的真实反馈。' : '这条路书还没发布。先在路书页发布，再生成公开回顾。'}
        </p>
        <Button variant="primary" size="lg" className="mt-4" onClick={createShare} disabled={shareState.loading || !isPublic}>
          <Share2 /> {shareState.loading ? '生成中...' : '生成回顾分享页'}
        </Button>
        {shareState.url && <p className="mx-auto mt-3 max-w-md rounded-tile bg-canvas px-3 py-2 font-mono text-xs break-all text-ink-2">{shareState.url}</p>}
        <p role="status" aria-live="polite" className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mt-3">
          {shareState.message}
        </p>
      </section>
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

/** @param {Record<string, any>} props */
function HeroStat({ label, value }) {
  return (
    <div className="rounded-tile bg-white/15 p-3 backdrop-blur">
      <dt className="text-xs font-semibold text-white/85">{label}</dt>
      <dd className="num mt-0.5 text-xl font-black">{value}</dd>
    </div>
  );
}

/** @param {Record<string, any>} props */
function Tag({ tone, children }) {
  const tones = {
    ok: 'bg-success-soft text-success-ink',
    warn: 'bg-lemon-soft text-lemon-ink',
    bad: 'bg-primary-soft text-primary-strong'
  };
  return <span className={cn('rounded-full px-2 py-0.5 font-bold', tones[tone])}>{children}</span>;
}
