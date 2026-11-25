import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Clock,
  Copy,
  Download,
  FileText,
  Flag,
  Image as ImageIcon,
  MapPin,
  Plus,
  Share2,
  ShieldCheck,
  Sparkles,
  Wallet,
  X
} from 'lucide-react';
import { createReviewShare, getMyCheckins, saveRoutebookExpenses } from '../../lib/api';
import { canSyncToCloud, getProfile } from '../../lib/profile';
import { checkinStorageKey } from '../../lib/storage';
import { normalizeTripStops, readTripSession, tripRoutebookId } from '../../lib/tripSession';
import { flushAllCheckinQueues, isServerSyncedCheckin } from '../../lib/checkinQueue';
import { buildXiaohongshuNote, renderReviewPoster, renderReviewSlideCards } from '../../lib/reviewNote';
import { trackEvent } from '../../lib/betaTelemetry.js';
import {
  addExpenseTraveler,
  addExtraExpenseItem,
  calculateExpenseSplit,
  formatExpenseSplitSummary,
  readExpenseState,
  removeExtraExpenseItem
} from '../../lib/expenseSplit';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { StopThumb } from '../visual/StopThumb';
import { CheckinPhoto } from '../visual/CheckinPhoto';
import { dayTheme } from '../visual/theme';

/** @param {Record<string, any>} props */
export default function ReviewPage({ routebook, onBack }) {
  // 打开回顾页会触发一次全局补传；补传可能注册身份并迁移本地存储 key，因此 profile 用 state。
  const [profile, setProfile] = useState(() => getProfile());
  const cloudCapable = canSyncToCloud(profile);
  const [shareState, setShareState] = useState({ loading: false, message: '', url: '' });
  const [noteStyle, setNoteStyle] = useState(/** @type {'guide' | 'vibe'} */ ('guide'));
  const [noteCopyMessage, setNoteCopyMessage] = useState('');
  const [posterState, setPosterState] = useState(
    /** @type {{ busy: boolean, dataUrl: string, blob: Blob | null, photoCount?: number, error: string }} */ ({
      busy: false,
      dataUrl: '',
      blob: null,
      photoCount: 0,
      error: ''
    })
  );
  const [slidesState, setSlidesState] = useState(
    /** @type {{ busy: boolean, cards: Array<{ index: number, label: string, fileName: string, dataUrl: string }>, error: string }} */ ({
      busy: false,
      cards: [],
      error: ''
    })
  );
  const [serverCheckins, setServerCheckins] = useState([]);
  const [localTick, setLocalTick] = useState(0);
  const [aaTravelerInput, setAaTravelerInput] = useState('');
  const [aaTitle, setAaTitle] = useState('');
  const [aaAmount, setAaAmount] = useState('');
  const [aaPayer, setAaPayer] = useState('我');
  const [aaCopyMessage, setAaCopyMessage] = useState('');
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
  // PUBLIC_PUBLISHING=disabled: 「先发布」 would be a dead end, so say what is possible instead.
  const publishingDisabled = Boolean(routebook.publication?.publishingDisabled);
  const notPublicText = publishingDisabled
    ? '这个站点暂不开放公开发布，回顾分享页也先不开放。想给同行的人看，可以在路书页生成朋友链接。'
    : '这条路书还没发布。先在路书页发布，再生成公开回顾。';
  const dayCount = new Set(stops.map((stop) => stop.day || 'Day 1')).size || 1;

  const stats = useMemo(() => computeStats(checkins, stops), [checkins, stops]);
  const companionNames = useMemo(
    () => (Array.isArray(routebook?.companions) ? routebook.companions.map((c) => c?.nickname).filter(Boolean) : []),
    [routebook?.companions]
  );
  const expenseState = useMemo(
    () => readExpenseState(routeId, companionNames, undefined, routebook?.expenseLedger, routebook?.companions),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- localTick refreshes localStorage expense state
    [routeId, companionNames, routebook?.expenseLedger, routebook?.companions, localTick]
  );

  function syncOwnerExpensesToCloud(nextLocalState) {
    if (!cloudCapable || !routeId) return;
    const ownerOnlyExtras = (nextLocalState?.extraExpenses ?? []).filter((e) => !e.companionOwned && !String(e.id).startsWith('comp:'));
    saveRoutebookExpenses(routeId, {
      profileId: profile.id,
      editToken: routebook?.editToken,
      expenseLedger: {
        travelers: nextLocalState?.travelers ?? ['我'],
        extraExpenses: ownerOnlyExtras
      }
    }).catch(() => {});
  }
  const aaResult = useMemo(
    () =>
      calculateExpenseSplit({
        stops,
        latestByStop,
        travelers: expenseState.travelers,
        extraExpenses: expenseState.extraExpenses
      }),
    [stops, latestByStop, expenseState]
  );
  const aaSummaryText = useMemo(() => formatExpenseSplitSummary(routebook?.city, routebook?.title, aaResult), [routebook?.city, routebook?.title, aaResult]);
  const xhsNote = useMemo(() => buildXiaohongshuNote(routebook, stops, latestByStop, noteStyle), [routebook, stops, latestByStop, noteStyle]);
  const posterShareUrl = useMemo(() => {
    if (typeof window === 'undefined') return 'https://lushu.aiwuq.cn';
    if (shareState.url) return shareState.url;
    if (routebook?.shareUrl) return new URL(routebook.shareUrl, window.location.origin).toString();
    if (isPublic && routeId) return `${window.location.origin}/share/${encodeURIComponent(routeId)}`;
    return window.location.origin;
  }, [shareState.url, routebook?.shareUrl, isPublic, routeId]);

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
    if (!cloudCapable) return undefined;
    const ctrl = new AbortController();
    getMyCheckins(profile.id, 200, ctrl.signal)
      .then((data) => setServerCheckins(data.checkins ?? []))
      .catch(() => {});
    return () => ctrl.abort();
  }, [profile.id, cloudCapable, localTick]);

  const days = [...new Set(stops.map((stop) => stop.day || 'Day 1'))];
  const doneCount = stops.filter((stop) => {
    const checkin = latestByStop.get(stopKeyForStop(stop));
    return checkin && !(checkin.worth === '跳过' || checkin.status === 'skipped');
  }).length;
  const heroStats = [
    { label: '打卡完成', value: `${doneCount}/${stops.length} 站` },
    stats.worthCount > 0 ? { label: '亲测值得', value: `${stats.worthCount} 处` } : null,
    { label: '实际花费', value: stats.totalCost },
    stats.validCount > 0 || stats.pendingCount > 0
      ? { label: 'GPS 位置核对', value: stats.syncedCount === 0 && stats.pendingCount > 0 ? '待同步' : `${stats.validCount} 站` }
      : null,
    stats.pitfallCount > 0 ? { label: '避坑提醒', value: stats.pitfalls } : null
  ].filter(Boolean);

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
        <dl
          className={cn(
            'mt-5 grid grid-cols-2 gap-2.5',
            heroStats.length === 3 ? 'sm:grid-cols-3' : heroStats.length >= 4 ? 'sm:grid-cols-4' : 'sm:grid-cols-2'
          )}
        >
          {heroStats.map((item) => (
            <HeroStat key={item.label} label={item.label} value={item.value} />
          ))}
        </dl>
        {(stats.pendingCount > 0 || stats.avgQueue) && (
          <p className="mt-4 text-xs text-white/85">
            {stats.pendingCount > 0
              ? `还有 ${stats.pendingCount} 条记录待联网上传（上传后自动计入位置核对）${stats.avgQueue ? ` · 平均排队 ${stats.avgQueue}` : ''}`
              : `实测平均排队 ${stats.avgQueue}`}
          </p>
        )}
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

      <section data-testid="review-aa-section" aria-labelledby="review-aa-heading" className="mt-8 rounded-panel border border-line bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="review-aa-heading" className="flex items-center gap-1.5 text-lg font-extrabold">
              <Wallet className="size-5 text-primary" aria-hidden="true" />
              同行记账与 AA 分摊
            </h2>
            <p className="mt-0.5 text-xs text-muted">免注册认个称呼即可算清垫付与分摊，打卡花费会自动汇总，也可补记打车、住宿或聚餐。</p>
          </div>
          {aaSummaryText && (
            <Button size="sm" variant="dark" onClick={copyAaBill} data-testid="copy-aa-summary-btn">
              <Copy /> 复制 AA 账单发群里
            </Button>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-muted">参与同行人：</span>
          {aaResult.travelers.map((person) => (
            <span key={person} className="rounded-full border border-line bg-canvas px-2.5 py-1 font-bold text-ink-2">
              {person}
            </span>
          ))}
          <form
            className="inline-flex items-center gap-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (!aaTravelerInput.trim()) return;
              const next = addExpenseTraveler(routeId, aaTravelerInput, companionNames);
              syncOwnerExpensesToCloud(next);
              setAaTravelerInput('');
              setLocalTick((t) => t + 1);
            }}
          >
            <label className="sr-only" htmlFor="review-aa-traveler">
              添加同行人称呼
            </label>
            <input
              id="review-aa-traveler"
              data-testid="review-aa-traveler-input"
              value={aaTravelerInput}
              onChange={(e) => setAaTravelerInput(e.target.value)}
              placeholder="加同行人，如 阿杰"
              className="h-9 w-32 rounded-full border border-line-strong bg-white px-3 text-xs text-ink"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!aaTravelerInput.trim()}>
              <Plus /> 添加
            </Button>
          </form>
        </div>

        <form
          className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_7.5rem_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (!aaTitle.trim() || !aaAmount.trim()) return;
            const next = addExtraExpenseItem(routeId, { title: aaTitle, amount: aaAmount, paidBy: aaPayer, splitWith: aaResult.travelers }, companionNames);
            syncOwnerExpensesToCloud(next);
            trackEvent('expense_add', 'owner');
            setAaTitle('');
            setAaAmount('');
            setLocalTick((t) => t + 1);
          }}
        >
          <label className="sr-only" htmlFor="review-aa-title">
            开销项目
          </label>
          <input
            id="review-aa-title"
            data-testid="review-aa-title-input"
            className="h-10 rounded-xl border border-line-strong bg-canvas px-3 text-sm text-ink focus:bg-white"
            value={aaTitle}
            onChange={(e) => setAaTitle(e.target.value)}
            placeholder="补记开销，如：高铁站打车、晚饭聚餐"
          />
          <label className="sr-only" htmlFor="review-aa-amount">
            金额（元）
          </label>
          <input
            id="review-aa-amount"
            data-testid="review-aa-amount-input"
            className="h-10 rounded-xl border border-line-strong bg-canvas px-3 text-sm text-ink focus:bg-white"
            value={aaAmount}
            onChange={(e) => setAaAmount(e.target.value)}
            placeholder="金额（元）"
          />
          <label className="sr-only" htmlFor="review-aa-payer">
            谁垫付的
          </label>
          <select
            id="review-aa-payer"
            data-testid="review-aa-payer-select"
            className="h-10 rounded-xl border border-line-strong bg-canvas px-2.5 text-sm font-semibold text-ink focus:bg-white"
            value={aaResult.travelers.includes(aaPayer) ? aaPayer : '我'}
            onChange={(e) => setAaPayer(e.target.value)}
          >
            {aaResult.travelers.map((p) => (
              <option key={p} value={p}>
                {p}付的
              </option>
            ))}
          </select>
          <Button type="submit" variant="outline" data-testid="review-aa-add-btn" disabled={!aaTitle.trim() || !aaAmount.trim()}>
            <Plus /> 记一笔
          </Button>
        </form>

        {aaResult.totalCents > 0 ? (
          <div className="mt-4 grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-tile bg-canvas px-3.5 py-2.5 text-sm">
              <span>
                共记 <b className="num">{aaResult.entries.length}</b> 笔 · 合计 <b className="num">{aaResult.totalYuan}</b> 元
              </span>
              <span className="font-bold text-ink-2">
                {aaResult.travelers.length} 人人均约 <b className="num">{aaResult.perPersonYuan}</b> 元
              </span>
            </div>

            {aaResult.transfers.length > 0 ? (
              <div className="rounded-card border border-line bg-sky-soft/60 p-3.5 text-sm" data-testid="review-aa-transfers">
                <strong className="font-extrabold text-ink">最少转账结清方案</strong>
                <ul className="mt-1.5 grid gap-1 text-xs font-semibold text-ink-2">
                  {aaResult.transfers.map((t, i) => (
                    <li key={`${t.from}-${t.to}-${i}`}>
                      • <b className="text-ink">{t.from}</b> 转给 <b className="text-ink">{t.to}</b>：
                      <b className="num text-primary-strong">{t.amountYuan} 元</b>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-xs font-semibold text-success-ink">当前只有一人付款或各人垫付恰好持平，添加同行人并记录各自垫付后会自动生成转账方案。</p>
            )}

            <ul className="divide-y divide-line rounded-card border border-line bg-white px-3 text-xs">
              {aaResult.entries.map((entry) => (
                <li key={entry.id} className="flex items-center justify-between gap-2 py-2">
                  <span className="min-w-0 truncate font-semibold text-ink-2">
                    {entry.title} ·{' '}
                    <span className="text-muted">
                      {entry.paidBy}付（{entry.splitWith.join('、')}分摊）
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <b className="num text-ink">{entry.amount} 元</b>
                    {entry.source === 'extra' && !String(entry.id).startsWith('comp:') ? (
                      <button
                        type="button"
                        aria-label={`删除记账 ${entry.title}`}
                        onClick={() => {
                          const next = removeExtraExpenseItem(routeId, entry.id, companionNames);
                          syncOwnerExpensesToCloud(next);
                          setLocalTick((t) => t + 1);
                        }}
                        className="grid size-6 place-items-center rounded-full text-muted hover:bg-canvas hover:text-ink"
                      >
                        ×
                      </button>
                    ) : String(entry.id).startsWith('comp:') ? (
                      <span className="rounded-full bg-sky-soft px-2 py-0.5 text-tag font-bold text-sky-ink">同伴共记</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted">还没有记录具体金额。在行中打卡填写「实际花了多少」或在上方补记一笔后，这里会自动算出每人应分摊金额。</p>
        )}

        {aaCopyMessage && (
          <p role="status" aria-live="polite" className="mt-2.5 text-xs font-semibold text-success-ink">
            {aaCopyMessage}
          </p>
        )}
      </section>

      <section data-testid="review-xhs-studio" aria-labelledby="review-xhs-heading" className="mt-8 rounded-panel border border-line bg-white p-5 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="review-xhs-heading" className="flex items-center gap-1.5 text-lg font-extrabold">
              <Sparkles className="size-5 text-primary" aria-hidden="true" />
              做成小红书 / 朋友圈游记
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              {xhsNote.fallbackPreview
                ? '根据你的顺路行程先排好游记初稿；出行打卡后会自动带入真实排队、花费和短评。'
                : xhsNote.isPartialProgress
                  ? `已按目前打卡的 ${doneCount}/${stops.length} 站生成阶段记录；继续打卡后续站点会自动补全。`
                  : '已按你的真实打卡时间轴、排队实况和花费自动排版，复制就能直接发。'}
            </p>
          </div>
          <div className="flex gap-1.5" role="group" aria-label="游记文风">
            <button
              type="button"
              aria-pressed={noteStyle === 'guide'}
              onClick={() => {
                setNoteStyle('guide');
                setNoteCopyMessage('');
              }}
              className={cn(
                'min-h-11 rounded-full px-3 text-xs font-bold sm:min-h-9',
                noteStyle === 'guide' ? 'bg-ink text-white' : 'border border-line-strong bg-canvas text-ink-2 hover:bg-line'
              )}
            >
              实用干货版
            </button>
            <button
              type="button"
              aria-pressed={noteStyle === 'vibe'}
              onClick={() => {
                setNoteStyle('vibe');
                setNoteCopyMessage('');
              }}
              className={cn(
                'min-h-11 rounded-full px-3 text-xs font-bold sm:min-h-9',
                noteStyle === 'vibe' ? 'bg-ink text-white' : 'border border-line-strong bg-canvas text-ink-2 hover:bg-line'
              )}
            >
              轻松漫游版
            </button>
          </div>
        </div>

        <div className="mt-3.5 rounded-card border border-line bg-canvas/70 p-3.5">
          <p className="text-copy font-extrabold text-ink">{xhsNote.headline}</p>
          <pre
            tabIndex={0}
            role="region"
            aria-label="游记文案预览"
            className="mt-2 max-h-60 overflow-y-auto font-sans text-xs leading-relaxed whitespace-pre-wrap text-ink-2 focus-visible:outline-2 focus-visible:outline-sky"
            data-testid="review-xhs-preview"
          >
            {xhsNote.fullText}
          </pre>
        </div>

        <div className="mt-4 flex flex-wrap gap-2.5">
          <Button variant="primary" onClick={copyXiaohongshuNote} data-testid="copy-xhs-note-btn">
            <Copy /> 一键复制游记文案
          </Button>
          <Button variant="dark" onClick={generateTraveloguePoster} disabled={posterState.busy} data-testid="generate-review-poster-btn">
            <ImageIcon /> {posterState.busy ? '正在生成长图…' : posterState.dataUrl ? '重新生成游记长图' : '生成游记长图海报'}
          </Button>
          <Button variant="outline" onClick={generateXiaohongshuSlides} disabled={slidesState.busy} data-testid="generate-xhs-slides-btn">
            <ImageIcon /> {slidesState.busy ? '生成配图卡中…' : slidesState.cards.length ? '重新生成 3:4 配图卡' : '导出小红书 3:4 配图卡'}
          </Button>
        </div>

        {noteCopyMessage && (
          <p role="status" aria-live="polite" className="mt-2.5 text-sm font-semibold text-success-ink">
            {noteCopyMessage}
          </p>
        )}
        {(posterState.error || slidesState.error) && (
          <p role="alert" className="mt-2.5 text-sm font-semibold text-danger">
            {posterState.error || slidesState.error}
          </p>
        )}

        {posterState.dataUrl && (
          <div className="mt-4 rounded-card border border-line bg-canvas p-3.5 text-center">
            <img
              src={posterState.dataUrl}
              alt={`${routebook.title}游记长图海报`}
              data-testid="review-poster-img"
              className="mx-auto max-h-[440px] w-auto rounded-xl border border-line shadow-card"
            />
            <p className="mt-2 text-xs text-muted">
              {posterState.photoCount > 0 ? `已自动拼入 ${posterState.photoCount} 张打卡实拍照片 · ` : ''}
              手机或微信内可长按上方图片保存，也可点下方按钮下载原图（1080px 高清）
            </p>
            <div className="mt-2.5 flex flex-wrap justify-center gap-2">
              <Button size="sm" variant="outline" className="bg-white" onClick={downloadReviewPoster}>
                <Download /> 保存高清长图
              </Button>
            </div>
          </div>
        )}

        {slidesState.cards.length > 0 && (
          <div className="mt-4 rounded-card border border-line bg-canvas p-3.5" data-testid="review-xhs-slides">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-bold text-ink-2">已按顺序准备好 {slidesState.cards.length} 张 3:4 配图（1080×1440），先存图再粘贴文案发布</p>
              <Button size="sm" variant="outline" className="bg-white" onClick={downloadAllSlides}>
                <Download /> 依次保存全部配图
              </Button>
            </div>
            <div
              tabIndex={0}
              role="region"
              aria-label="小红书配图卡片预览"
              className="mt-3 flex gap-3 overflow-x-auto pb-1 focus-visible:outline-2 focus-visible:outline-sky"
            >
              {slidesState.cards.map((card) => (
                <figure key={card.index} className="w-40 shrink-0 rounded-xl border border-line bg-white p-2 shadow-card">
                  <img src={card.dataUrl} alt={`${card.label}配图卡`} className="aspect-[3/4] w-full rounded-lg border border-line object-cover" />
                  <figcaption className="mt-1.5 flex items-center justify-between gap-1 text-xs">
                    <span className="truncate font-bold text-ink-2">
                      {card.index}. {card.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => triggerDataUrlDownload(card.dataUrl, card.fileName)}
                      className="min-h-9 shrink-0 font-bold text-sky-ink underline underline-offset-2 sm:min-h-0"
                    >
                      存图
                    </button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <p className="max-w-md text-xs leading-relaxed text-muted">{isPublic ? '也可生成带真实打卡和位置核对的网页回顾链接发给朋友。' : notPublicText}</p>
          {isPublic ? (
            <Button variant="outline" size="sm" onClick={createShare} disabled={shareState.loading}>
              <Share2 /> {shareState.loading ? '生成中…' : '生成网页回顾链接'}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={onBack}>
              <ArrowLeft /> 返回路书分享链接
            </Button>
          )}
        </div>
        {shareState.url && <p className="mt-2.5 rounded-tile bg-canvas px-3 py-2 font-mono text-xs break-all text-ink-2">{shareState.url}</p>}
        <p role="status" aria-live="polite" className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mt-2">
          {shareState.message}
        </p>
      </section>
    </div>
  );

  async function createShare() {
    if (!isPublic) {
      setShareState({ loading: false, message: publishingDisabled ? notPublicText : '请先在路书页发布 H5 链接，再生成公开回顾', url: '' });
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
            ? `；${stats.pendingCount} 条记录待同步，回顾链接是生成时的快照，同步完成后请重新生成链接才会包含这些记录`
            : `；${missingCount} 条记录因账号还没完成认证，没进入公开回顾`
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

  async function copyAaBill() {
    if (!aaSummaryText) return;
    setAaCopyMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(aaSummaryText);
      setAaCopyMessage('已复制 AA 账单与转账明细，直接粘贴到微信群即可。');
    } catch {
      setAaCopyMessage('当前浏览器未开启自动复制，请对照上方明细转账。');
    }
  }

  async function copyXiaohongshuNote() {
    setNoteCopyMessage('');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(xhsNote.fullText);
      setNoteCopyMessage('已复制小红书游记文案，打开小红书或朋友圈直接粘贴即可发布。');
    } catch {
      setNoteCopyMessage('当前浏览器未开启自动复制，可长按上方预览框全选复制。');
    }
  }

  async function generateTraveloguePoster() {
    setPosterState((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const res = await renderReviewPoster(routebook, stops, latestByStop, { shareUrl: posterShareUrl, profileId: profile.id });
      setPosterState({ busy: false, dataUrl: res.dataUrl, blob: res.blob, photoCount: res.photoCount ?? 0, error: '' });
      trackEvent('review_export', 'poster');
    } catch (err) {
      setPosterState({ busy: false, dataUrl: '', blob: null, photoCount: 0, error: err?.message || '长图生成失败，请重试' });
    }
  }

  async function generateXiaohongshuSlides() {
    setSlidesState((prev) => ({ ...prev, busy: true, error: '' }));
    try {
      const cards = await renderReviewSlideCards(routebook, stops, latestByStop, { shareUrl: posterShareUrl, profileId: profile.id });
      setSlidesState({ busy: false, cards, error: '' });
      trackEvent('review_export', 'slides');
    } catch (err) {
      setSlidesState({ busy: false, cards: [], error: err?.message || '配图卡生成失败，请重试' });
    }
  }

  function triggerDataUrlDownload(dataUrl, fileName) {
    if (!dataUrl) return;
    const anchor = document.createElement('a');
    anchor.href = dataUrl;
    anchor.download = fileName;
    anchor.click();
  }

  function downloadAllSlides() {
    slidesState.cards.forEach((card, idx) => {
      window.setTimeout(() => triggerDataUrlDownload(card.dataUrl, card.fileName), idx * 140);
    });
  }

  function downloadReviewPoster() {
    if (!posterState.dataUrl) return;
    triggerDataUrlDownload(posterState.dataUrl, `${routebook.city || '旅行'}-${routebook.title || '游记回顾'}.png`.replace(/[\\/:*?"<>|]+/g, '-'));
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
  let worthCount = 0;

  for (const c of feedbackCheckins) {
    const costNum = parseInt(String(c.cost ?? '').replace(/[^\d]/g, ''), 10);
    if (costNum > 0) totalCost += costNum;
    const queueNum = parseInt(String(c.queue ?? '').replace(/[^\d]/g, ''), 10);
    if (queueNum > 0) queueMinutes.push(queueNum);
    if (c.worth === '踩坑' || c.pitfall) pitfalls++;
    if (c.worth === '值得') worthCount++;
  }

  const avgQueue = queueMinutes.length ? `${Math.round(queueMinutes.reduce((a, b) => a + b, 0) / queueMinutes.length)} 分钟` : '';

  return {
    completionRate,
    validCount: validCheckins.length,
    worthCount,
    pitfallCount: pitfalls,
    totalCost: totalCost > 0 ? `${totalCost} 元` : '未记账',
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
