import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Shield, X, ExternalLink, Link2 } from 'lucide-react';
import { getRoutebookRemote, publishOwnRoutebook, recordJourneyEvent, saveRoutebookRemote } from '../../lib/api';
import { curatedRoutes } from '../../lib/content';
import { getProfile, profileRoutebookFields } from '../../lib/profile';
import { getRouteTrustBadgeState, getStopTrustState, maskTrustMetrics } from '../../lib/trust';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { preserveRoutebookConflictDraft } from '../../lib/routebookConflict';

export default function SharePreview({ routebook, onClose, onShared, onConflictDraftSaved }) {
  // 只有精选目录里的原始 id 才允许派生 /share/publicId（服务端该路径有效已验证）；
  // 用户复制精选生成的个人草稿（provider 仍为 curation）不派生，避免复制到无效链接。
  const isCuratedCatalogRoute = curatedRoutes.some((route) => route.id === (routebook.publicId || routebook.id));
  const isCuratedRoute = routebook.provider?.name === 'curation' || isCuratedCatalogRoute;
  const derivedShareUrl = useMemo(() => {
    // 精选路线视为已上架公开内容：允许复制与系统分享；
    // 「发布」仍被禁（有 shareUrl 时主按钮只做复制，publish 分支不可达）。
    const shareable = ['published', 'featured'].includes(routebook.publishStatus) || isCuratedCatalogRoute;
    const sharePath = routebook.shareUrl || (shareable && routebook.publicId ? `/share/${routebook.publicId}` : '');
    return sharePath ? new URL(sharePath, window.location.origin).toString() : '';
  }, [routebook, isCuratedCatalogRoute]);
  const [shareState, setShareState] = useState({ loading: false, message: '', url: '' });
  const shareUrl = shareState.url || derivedShareUrl;
  const stops = routebook.stops ?? [];
  const days = routebook.days ?? ['Day 1'];
  const trustState = getRouteTrustBadgeState(routebook);
  const TrustStateIcon = trustState.tone === 'trial' ? AlertTriangle : Shield;
  const visibleMetrics = maskTrustMetrics(routebook.metrics, trustState.tone, 4);
  const dialogRef = useDialogFocus(true, onClose);
  const requestSequenceRef = useRef(0);
  const latestRoutebookRef = useRef(routebook);
  latestRoutebookRef.current = routebook;

  async function createShareLink() {
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
        ...(expectedVersion != null ? { expectedVersion } : {})
      });
      if (requestSequenceRef.current !== operationSequence) return;
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
      if (error?.status === 409 && routeId) {
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
            setShareState((previous) => ({ ...previous, loading: false, message: `发布未提交：刷新期间当前页面已有新更新，未用较早响应覆盖。${recoveryText}` }));
            return;
          }
          const latestVersion = currentRoutebookVersion(latestRoutebook) ?? error.currentVersion;
          const isPublished = ['published', 'featured'].includes(latestRoutebook?.publishStatus);
          const latestUrl = isPublished
            ? new URL(`/share/${latestRoutebook.publicId || routeId}`, window.location.origin).toString()
            : '';
          onShared?.(latestRoutebook);
          setShareState({
            loading: false,
            message: `发布未重复提交：服务端${latestVersion != null ? `已更新到 v${latestVersion}` : '版本已更新'}，已刷新最新内容。${isPublished ? '当前版本已经公开，可再次点击复制链接。' : '请重新检查后再发布。'}${recoveryText}`,
            url: latestUrl
          });
        } catch (refreshError) {
          setShareState({
            loading: false,
            message: `发布未提交：服务端${Number.isInteger(error.currentVersion) ? `已更新到 v${error.currentVersion}` : '版本已更新'}，自动刷新失败（${refreshError.message}）。${recoveryText}`,
            url: shareState.url
          });
        }
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

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div ref={dialogRef} className="modal-content share-preview" role="dialog" aria-modal="true" aria-labelledby="share-preview-title" tabIndex={-1} onClick={e => e.stopPropagation()}>
        <div className="share-header">
          <div>
            <h2 className="text-title" id="share-preview-title">{routebook.title}</h2>
            <p className="text-caption" style={{ marginTop: 4 }}>{routebook.summary}</p>
          </div>
          <button className="btn btn-icon btn-sm" onClick={onClose} aria-label="关闭分享预览"><X size={18} /></button>
        </div>

        {/* Hero trust score */}
        <div className={`share-trust-hero trust-${trustState.tone}`}>
          <div className="share-trust-ring">
            <TrustStateIcon size={20} />
            <strong>{trustState.value}</strong>
            <span>{trustState.text}</span>
          </div>
          <div className="share-trust-stats">
            <span><b>{stops.length}</b> 站点</span>
            <span><b>{days.length}</b> 天</span>
            <span><b>{routebook.city}</b></span>
          </div>
          {trustState.tone === 'prediction' && trustState.sampleProgressText && (
            <p className="text-micro">{trustState.sampleProgressText}</p>
          )}
        </div>

        {/* Route summary */}
        <div className="share-route-list">
          {days.map(day => (
            <div key={day} className="share-day-section">
              <span className="badge badge-blue">{day}</span>
              <div className="share-stops">
                {stops.filter(s => s.day === day).map((stop, i) => {
                  const stopTrust = getStopTrustState(stop, trustState.tone);
                  return (
                    <div key={stop.id ?? i} className="share-stop-row">
                      <span className="share-stop-time">{stop.time}</span>
                      <div>
                        <strong>{stop.name}</strong>
                        <span className="text-micro">{stop.stay} · {stop.cost}</span>
                      </div>
                      <span className={`share-stop-score trust-${stopTrust.tone}`}>
                        {stopTrust.value}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* Validations highlight */}
        {routebook.validations?.length > 0 && (
          <div className="share-validations">
            <p className="text-micro" style={{ marginBottom: 8 }}>可执行校验</p>
            {routebook.validations.slice(0, 3).map(v => (
              <span key={v.id} className="badge badge-orange" style={{ marginRight: 6, marginBottom: 4 }}>
                {v.label}: {v.state}
              </span>
            ))}
          </div>
        )}

        {/* Metrics */}
        {visibleMetrics.length > 0 && (
          <div className="share-metrics">
            {visibleMetrics.map(m => (
              <div key={m.label} className="share-metric-item">
                <span className="text-micro">{m.label}</span>
                <strong>{m.value}</strong>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="share-footer">
          <p className="text-caption">
            公开页只展示路线结构与可信状态，不搬运第三方攻略原文。真实打卡持续校准。
          </p>
          <div className="share-actions">
            <button
              className="btn btn-primary"
              onClick={createShareLink}
              disabled={shareState.loading || (isCuratedRoute && !shareUrl)}
              title={isCuratedRoute && !shareUrl ? '精选路线请先『定制同款』复制为个人路书再发布' : undefined}
            >
              <Link2 size={14} /> {shareState.loading ? '生成中...' : shareUrl ? '复制 H5 链接' : '发布 H5 链接'}
            </button>
            <button className="btn btn-secondary" onClick={copyShareText}>
              <ExternalLink size={14} /> 复制摘要
            </button>
            <button
              className="btn btn-secondary"
              disabled={!shareUrl}
              title={shareUrl ? undefined : '发布 H5 链接后才能系统分享，不会分享私有链接'}
              onClick={() => {
                if (!shareUrl) return;
                if (navigator.share) {
                  navigator.share({ title: routebook.title, text: buildShareText(routebook), url: shareUrl }).catch(() => {});
                } else {
                  copyShareText();
                }
              }}
            >
              系统分享
            </button>
            {shareUrl && (
              <a className="btn btn-ghost" href={shareUrl}>
                <ExternalLink size={14} /> 打开公开分享页
              </a>
            )}
          </div>
          {!shareUrl && (
            <p className="text-caption" style={{ marginTop: 10 }}>
              {isCuratedRoute
                ? '精选路线请先『定制同款』复制为个人路书再发布。'
                : '路线尚未发布：发布 H5 链接后才能使用系统分享，私有编辑链接不会被分享。'}
            </p>
          )}
          {shareUrl && <p className="text-caption" style={{ marginTop: 10, wordBreak: 'break-all' }}>{shareUrl}</p>}
          <p className="text-caption" role="status" aria-live="polite" aria-atomic="true" style={{ marginTop: shareState.message ? 8 : 0 }}>
            {shareState.message}
          </p>
        </div>
      </div>
    </div>
  );
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
    '— 由可信路书 AI 生成，真实打卡验证每一站'
  ];
  return lines.join('\n');
}
