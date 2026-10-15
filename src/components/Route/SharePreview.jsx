import { costDisplay } from '../../lib/cost';
import { useMemo, useRef, useState } from 'react';
import { ClipboardCopy, ExternalLink, Link2, MapPin, Share2 } from 'lucide-react';
import { createFriendLink, getRoutebookRemote, publishOwnRoutebook, recordJourneyEvent, revokeFriendLink, saveRoutebookRemote } from '../../lib/api';
import { IMPORTED_PUBLIC_EXPLANATION, isImportedRoutebook, routebookGuideOrigins } from '../../lib/importOrigins';
import ShareVisibility from './ShareVisibility';
import { curatedRoutes } from '../../lib/content';
import { getProfile, profileRoutebookFields } from '../../lib/profile';
import { formatStayText } from '../../lib/routeMeta.js';
import { getRouteTrustBadgeState, getStopTrustState, maskTrustMetrics } from '../../lib/trust';
import { preserveRoutebookConflictDraft } from '../../lib/routebookConflict';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui/button';
import { cn } from '../ui/cn';
import { TrustChip } from '../cards/TrustChip';
import { CITY_SCENE, cityCover, dayTheme, smallImage } from '../visual/theme';
import { SceneBadge, SceneImage } from '../visual/SceneImage';

/** @param {Record<string, any>} props */
export default function SharePreview({ routebook, onClose, onShared, onConflictDraftSaved }) {
  // 只有精选目录里的原始 id 才允许派生 /share/publicId（服务端该路径有效已验证）；
  // 用户复制精选生成的个人草稿（provider 仍为 curation）不派生，避免复制到无效链接。
  const isCuratedCatalogRoute = curatedRoutes.some((route) => route.id === (routebook.publicId || routebook.id));
  const isCuratedRoute = routebook.provider?.name === 'curation' || isCuratedCatalogRoute;
  const derivedShareUrl = useMemo(() => {
    // 精选路线视为已上架公开内容：允许复制与系统分享；
    // 「发布」仍被禁（有 shareUrl 时主按钮只做复制，publish 分支不可达）。
    const shareable = ['published', 'featured'].includes(routebook.publishStatus) || isCuratedCatalogRoute;
    const sharePath = shareable ? routebook.shareUrl || (routebook.publicId ? `/share/${routebook.publicId}` : '') : '';
    return sharePath ? new URL(sharePath, window.location.origin).toString() : '';
  }, [routebook, isCuratedCatalogRoute]);
  const [shareState, setShareState] = useState({ loading: false, message: '', url: '' });
  const shareUrl = shareState.url || derivedShareUrl;
  const stops = routebook.stops ?? [];
  const days = routebook.days ?? ['Day 1'];
  const trustState = getRouteTrustBadgeState(routebook);
  const visibleMetrics = maskTrustMetrics(routebook.metrics, trustState.tone, 4);
  const requestSequenceRef = useRef(0);
  const latestRoutebookRef = useRef(routebook);
  latestRoutebookRef.current = routebook;
  // The server attaches the authoritative policy on owner reads; freshly generated or
  // local-only routebooks fall back to the default (imported => not publicly listed).
  const publication = routebook.publication ?? localPublication(routebook);
  const [friendState, setFriendState] = useState({ loading: false, url: '' });
  const friendUrl = friendState.url || (routebook.friendShareUrl ? new URL(routebook.friendShareUrl, window.location.origin).toString() : '');
  const pendingPriceCount = (routebook.stops ?? []).filter((stop) => costDisplay(stop).pending).length;
  const publicBlocked = publication.publicAllowed === false && !shareUrl;

  async function copyText(text, okMessage, fallbackMessage) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setShareState((prev) => ({ ...prev, loading: false, message: okMessage }));
    } catch {
      setShareState((prev) => ({ ...prev, loading: false, message: fallbackMessage }));
    }
  }

  async function saveForSharing(profile) {
    // Only drafts are saved first; pending/public routebooks cannot be overwritten.
    if ((routebook.publishStatus || 'draft') !== 'draft') return routebook;
    const saved = await saveRoutebookRemote({ ...routebook, ...profileRoutebookFields(profile) });
    return saved.routebook;
  }

  async function handleCreateFriendLink() {
    if (friendUrl) return copyText(friendUrl, '已复制朋友链接', '朋友链接已就绪；浏览器未允许自动复制，请手动复制上方链接');
    setFriendState((prev) => ({ ...prev, loading: true }));
    setShareState((prev) => ({ ...prev, message: '' }));
    try {
      const profile = getProfile();
      const target = await saveForSharing(profile);
      const routeId = target.publicId || target.id;
      const expectedVersion = currentRoutebookVersion(target);
      const data = await createFriendLink(routeId, {
        ...profileRoutebookFields(profile),
        editToken: target.editToken || routebook.editToken,
        ...(expectedVersion != null ? { expectedVersion } : {})
      });
      const url = new URL(data.friendShareUrl, window.location.origin).toString();
      onShared?.(data.routebook);
      setFriendState({ loading: false, url });
      await copyText(url, '已生成并复制朋友链接：只有拿到链接的人能打开', '已生成朋友链接；浏览器未允许自动复制，请手动复制上方链接');
    } catch (error) {
      setFriendState((prev) => ({ ...prev, loading: false }));
      setShareState((prev) => ({ ...prev, message: `朋友链接生成失败：${error.message}` }));
    }
  }

  async function handleRevokeFriendLink() {
    // V-U15: say what happens to links already sent before stopping them.
    if (!window.confirm('停用后，已经发出去的链接都打不开了；之后可以再生成一个新的。停用？')) return;
    setFriendState((prev) => ({ ...prev, loading: true }));
    try {
      const profile = getProfile();
      const routeId = routebook.publicId || routebook.id;
      const expectedVersion = currentRoutebookVersion(routebook);
      const data = await revokeFriendLink(routeId, {
        ...profileRoutebookFields(profile),
        editToken: routebook.editToken,
        ...(expectedVersion != null ? { expectedVersion } : {})
      });
      onShared?.(data.routebook);
      setFriendState({ loading: false, url: '' });
      setShareState((prev) => ({ ...prev, message: '朋友链接已停用，之前发出去的链接打不开了' }));
    } catch (error) {
      setFriendState((prev) => ({ ...prev, loading: false }));
      setShareState((prev) => ({ ...prev, message: `停用失败：${error.message}` }));
    }
  }

  /** @param {{ claimOriginalAuthor?: boolean }} [options] */
  async function createShareLink(options = {}) {
    setShareState((prev) => ({ ...prev, loading: true, message: '' }));
    if (shareUrl) {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(shareUrl);
        setShareState((prev) => ({ ...prev, loading: false, message: '已复制分享链接' }));
      } catch {
        setShareState((prev) => ({ ...prev, loading: false, message: '分享链接已就绪；浏览器未允许自动复制，请手动复制下方链接' }));
      }
      return;
    }
    if (isCuratedRoute) {
      setShareState((prev) => ({ ...prev, loading: false, message: '精选路线请先『定制同款』复制为个人路书再发布' }));
      return;
    }
    let routeId = routebook.publicId || routebook.id;
    let pendingSnapshot = routebook;
    const operationSequence = ++requestSequenceRef.current;
    try {
      const profile = getProfile();
      const saved = await saveRoutebookRemote({ ...routebook, ...profileRoutebookFields(profile) });
      pendingSnapshot = saved.routebook;
      routeId = saved.routebook.publicId || saved.routebook.id;
      const expectedVersion = currentRoutebookVersion(saved.routebook);
      const data = await publishOwnRoutebook(routeId, {
        ...profileRoutebookFields(profile),
        editToken: saved.routebook.editToken || routebook.editToken,
        ...(options.claimOriginalAuthor ? { claimOriginalAuthor: true } : {}),
        ...(expectedVersion != null ? { expectedVersion } : {})
      });
      if (requestSequenceRef.current !== operationSequence) return;
      if (data.routebook?.publishStatus === 'pending_review') {
        onShared?.({ ...data.routebook, shareUrl: '' });
        await recordJourneyEvent('routebook-submit-review', data.routebook, profile.id).catch(() => {});
        setShareState({
          loading: false,
          message: options.claimOriginalAuthor
            ? '已申请公开（原作者授权）：确认授权、查过路线后才会公开，这期间可以先用朋友链接分享。'
            : '已申请公开。确认来源授权、查过路线后才会公开。',
          url: ''
        });
        return;
      }
      await Promise.allSettled([
        recordJourneyEvent('routebook-save', data.routebook, profile.id),
        recordJourneyEvent('routebook-share', data.routebook, profile.id)
      ]);
      const url = new URL(data.shareUrl ?? `/share/${data.routebook.publicId}`, window.location.origin).toString();
      onShared?.({ ...data.routebook, shareUrl: data.shareUrl ?? `/share/${data.routebook.publicId}` });
      setShareState({ loading: false, message: '已发布分享链接', url });
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(url);
        setShareState({ loading: false, message: '已发布并复制分享链接', url });
      } catch {
        setShareState({ loading: false, message: '已发布分享链接；浏览器未允许自动复制，请手动复制下方链接', url });
      }
    } catch (error) {
      if (error?.status === 409 && ['VERSION_CONFLICT', 'ROUTEBOOK_VERSION_CONFLICT', 'EXPECTED_VERSION_REQUIRED'].includes(error?.code) && routeId) {
        const conflictCopy = preserveRoutebookConflictDraft(pendingSnapshot, '发布版本冲突');
        if (conflictCopy.saved) onConflictDraftSaved?.(conflictCopy.draft);
        const recoveryText = conflictCopy.saved
          ? `待发布内容已保留为“${conflictCopy.draft.title}”，可在“我的”中继续编辑。`
          : '冲突副本未能写入本地存储，请暂时不要关闭当前页面。';
        if (requestSequenceRef.current !== operationSequence) {
          setShareState((previous) => ({ ...previous, loading: false, message: `发布未提交：当前已有后续操作，未启动旧版本刷新。${recoveryText}` }));
          return;
        }
        const refreshSequence = ++requestSequenceRef.current;
        const routebookBeforeRefresh = latestRoutebookRef.current;
        try {
          const latest = await getRoutebookRemote(routeId);
          const latestRoutebook = latest.routebook;
          if (requestSequenceRef.current !== refreshSequence || latestRoutebookRef.current !== routebookBeforeRefresh) {
            setShareState((previous) => ({
              ...previous,
              loading: false,
              message: `发布未提交：刷新期间当前页面已有新更新，未用较早响应覆盖。${recoveryText}`
            }));
            return;
          }
          const latestVersion = currentRoutebookVersion(latestRoutebook) ?? error.currentVersion;
          const isPublished = ['published', 'featured'].includes(latestRoutebook?.publishStatus);
          const latestUrl = isPublished ? new URL(`/share/${latestRoutebook.publicId || routeId}`, window.location.origin).toString() : '';
          onShared?.(latestRoutebook);
          setShareState({
            loading: false,
            message: `没有重复发布：云端${latestVersion != null ? `已更新到 v${latestVersion}` : '版本已更新'}，已刷新最新内容。${isPublished ? '当前版本已经公开，可再次点击复制链接。' : '请重新检查后再发布。'}${recoveryText}`,
            url: latestUrl
          });
        } catch (refreshError) {
          setShareState({
            loading: false,
            message: `没有发布：云端${Number.isInteger(error.currentVersion) ? `已更新到 v${error.currentVersion}` : '版本已更新'}，自动刷新失败（${refreshError.message}）。${recoveryText}`,
            url: shareState.url
          });
        }
        return;
      }
      if (error?.code === 'IMPORTED_ROUTEBOOK_PUBLIC_DISABLED' || error?.code === 'PUBLIC_PUBLISHING_DISABLED') {
        setShareState({ loading: false, message: `暂不能公开发布：${error.message}`, url: shareState.url });
        return;
      }
      setShareState({ loading: false, message: `发布失败：${error.message}`, url: shareState.url });
    }
  }

  async function copyShareText() {
    const text = buildShareText(routebook);
    setShareState((prev) => ({ ...prev, message: '' }));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      setShareState((prev) => ({ ...prev, message: '已复制路线摘要' }));
    } catch {
      setShareState((prev) => ({ ...prev, message: '浏览器未允许自动复制，请检查剪贴板权限后重试' }));
    }
  }

  const cover = cityCover(routebook.city);
  const curatedHint = '精选路线请先「定制同款」复制为个人路书再发布';

  return (
    <Sheet title="分享路书" description="公开页只展示路线和核对状态，不转载原攻略。" onClose={onClose} wide>
      {!isCuratedRoute && (
        <ShareVisibility
          routebook={routebook}
          publication={publication}
          shareUrl={shareUrl}
          friendUrl={friendUrl}
          busy={friendState.loading || shareState.loading}
          onCreateFriendLink={handleCreateFriendLink}
          onCopyFriendLink={handleCreateFriendLink}
          onRevokeFriendLink={handleRevokeFriendLink}
          onClaimAuthorship={() => createShareLink({ claimOriginalAuthor: true })}
        />
      )}
      <article className="overflow-hidden rounded-card border border-line shadow-card">
        <header className="relative isolate p-5 text-white" style={cover ? undefined : { backgroundImage: 'linear-gradient(135deg,#e8553d,#7c5cdb)' }}>
          {cover ? (
            <img src={smallImage(cover)} alt="" className="absolute inset-0 -z-20 size-full object-cover" />
          ) : (
            <SceneImage
              src={CITY_SCENE}
              sizes="720px"
              className="absolute inset-0 -z-20 size-full object-cover"
              badge={<SceneBadge className="right-3 bottom-3">示意图</SceneBadge>}
            />
          )}
          <div className="absolute inset-0 -z-10 bg-[linear-gradient(180deg,rgba(10,12,16,.2),rgba(10,12,16,.78))]" aria-hidden="true" />
          <TrustChip routebook={routebook} curated={isCuratedRoute} className="bg-white/95" />
          <h3 className="mt-3 text-2xl leading-tight font-black tracking-tight">{routebook.title}</h3>
          {routebook.summary && <p className="mt-1.5 line-clamp-2 text-sm text-white/90">{routebook.summary}</p>}
          <div className="num mt-4 flex gap-5 text-sm font-semibold">
            <span>
              <b className="text-xl font-black">{stops.length}</b> 站
            </span>
            <span>
              <b className="text-xl font-black">{days.length}</b> 天
            </span>
            <span className="flex items-center gap-1">
              <MapPin className="size-4" aria-hidden="true" /> {routebook.city}
            </span>
          </div>
          {trustState.tone === 'prediction' && trustState.sampleProgressText && <p className="mt-2 text-xs text-white/85">{trustState.sampleProgressText}</p>}
        </header>

        <div className="grid gap-4 bg-white p-4">
          {days.map((day, dayIndex) => {
            const theme = dayTheme(dayIndex);
            const dayStops = stops.filter((s) => s.day === day);
            if (!dayStops.length) return null;
            return (
              <section key={day}>
                <span className="inline-flex rounded-full px-2.5 py-0.5 text-xs font-extrabold text-white" style={{ background: theme.ink }}>
                  {day}
                </span>
                <ol className="mt-2 grid gap-1">
                  {dayStops.map((stop, i) => {
                    const stopTrust = getStopTrustState(stop, trustState.tone);
                    return (
                      <li key={stop.id ?? i} className="flex items-center gap-3 rounded-tile px-1 py-1.5">
                        <span
                          className="num grid size-6 shrink-0 place-items-center rounded-full text-xs font-black text-white"
                          style={{ background: theme.ink }}
                          aria-hidden="true"
                        >
                          {i + 1}
                        </span>
                        <span className="num w-11 shrink-0 text-xs font-bold text-muted">{stop.time}</span>
                        <span className="min-w-0 flex-1">
                          <strong className="block truncate text-sm font-bold">{stop.name}</strong>
                          <span className="text-xs text-muted">
                            {/* U20: pending prices live in 「出发前确认」 below, not on the row. */}
                            {[formatStayText(stop.stay), costDisplay(stop).pending ? '' : costDisplay(stop).text].filter(Boolean).join(' · ')}
                          </span>
                        </span>
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
                      </li>
                    );
                  })}
                </ol>
              </section>
            );
          })}
          {pendingPriceCount > 0 && (
            <p className="text-meta text-ink-2" data-testid="preview-pending-price">
              出发前确认：{pendingPriceCount} 站的价格
            </p>
          )}

          {routebook.validations?.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-line pt-3">
              <span className="w-full text-xs font-bold text-muted">出发前检查</span>
              {routebook.validations.slice(0, 3).map((v) => (
                <span key={v.id} className="rounded-full bg-lemon-soft px-2.5 py-0.5 text-xs font-bold text-lemon-ink">
                  {v.label}：{v.state}
                </span>
              ))}
            </div>
          )}

          {visibleMetrics.length > 0 && (
            <dl className="grid grid-cols-2 gap-2 border-t border-line pt-3 sm:grid-cols-4">
              {visibleMetrics.map((m) => (
                <div key={m.label} className="rounded-tile bg-canvas p-2.5">
                  <dt className="text-xs text-muted">{m.label}</dt>
                  <dd className="num text-base font-extrabold">{m.value}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </article>

      <div className="sticky -bottom-6 z-10 -mx-6 mt-4 border-t border-line bg-white/95 px-6 py-3 backdrop-blur max-md:-bottom-5 max-md:-mx-5 max-md:px-5">
        <div className="flex flex-wrap gap-2">
          {/* V-U19: most people just want to send it to a friend; 申请公开 is the secondary path. */}
          {shareUrl ? (
            <Button variant="primary" onClick={() => createShareLink()} disabled={shareState.loading}>
              <Link2 /> 复制分享链接
            </Button>
          ) : (
            <Button variant="primary" onClick={handleCreateFriendLink} disabled={friendState.loading}>
              <Link2 /> {friendState.loading ? '生成中…' : friendUrl ? '复制朋友链接' : '生成朋友链接'}
            </Button>
          )}
          {!publicBlocked && !shareUrl && (
            <Button
              variant="outline"
              onClick={() => createShareLink()}
              disabled={shareState.loading || routebook.publishStatus === 'pending_review' || isCuratedRoute}
              title={isCuratedRoute ? curatedHint : undefined}
            >
              {shareState.loading ? '提交中…' : routebook.publishStatus === 'pending_review' ? '已申请公开' : '申请公开'}
            </Button>
          )}
          <Button variant="outline" onClick={copyShareText}>
            <ClipboardCopy /> 复制文字摘要
          </Button>
          <Button
            variant="outline"
            className="max-md:w-11 max-md:px-0"
            aria-label="系统分享"
            disabled={!shareUrl && !friendUrl}
            title={shareUrl || friendUrl ? undefined : '发布或生成朋友链接后才能系统分享，不会分享私有链接'}
            onClick={() => {
              const target = shareUrl || friendUrl;
              if (!target) return;
              if (navigator.share) {
                navigator.share({ title: routebook.title, text: buildShareText(routebook), url: target }).catch(() => {});
              } else {
                copyShareText();
              }
            }}
          >
            <Share2 /> <span className="max-md:sr-only">系统分享</span>
          </Button>
          {shareUrl && (
            <a className="inline-flex h-11 items-center gap-2 rounded-chip px-4 text-copy font-bold text-sky-ink hover:bg-sky-soft" href={shareUrl}>
              <ExternalLink className="size-[18px]" aria-hidden="true" /> 打开公开页
            </a>
          )}
        </div>
        <p className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mt-2" role="status" aria-live="polite" aria-atomic="true">
          {shareState.message}
        </p>
      </div>
      {shareUrl ? (
        <p className="mt-3 rounded-tile bg-canvas px-3 py-2 font-mono text-xs break-all text-ink-2">{shareUrl}</p>
      ) : isCuratedRoute ? (
        <p className="mt-3 text-sm text-muted">{`${curatedHint}。`}</p>
      ) : null}
    </Sheet>
  );
}

/** Client-side fallback mirroring the server's default import policy. */
function localPublication(routebook) {
  const imported = isImportedRoutebook(routebook);
  return imported
    ? { imported, origins: routebookGuideOrigins(routebook), publicAllowed: false, canClaimAuthorship: true, reason: IMPORTED_PUBLIC_EXPLANATION }
    : { imported: false, origins: [], publicAllowed: true, canClaimAuthorship: false, reason: '' };
}

function currentRoutebookVersion(routebook) {
  const version = Number(routebook?.version ?? routebook?.currentVersion ?? routebook?.revision);
  return Number.isInteger(version) && version >= 0 ? version : null;
}

function buildShareText(routebook) {
  const stops = routebook.stops ?? [];
  const lines = [
    `📍 ${routebook.title}`,
    `🛡 ${getRouteTrustBadgeState(routebook).text}`,
    `📝 ${routebook.summary}`,
    '',
    ...stops.slice(0, 8).map((s, i) => `${i + 1}. ${s.time} ${s.name}（${s.stay}·${s.cost}）`),
    '',
    '— 由可信路书 AI 生成，出发前请核对营业时间'
  ];
  return lines.join('\n');
}
