import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, BookmarkPlus, Copy, MapPin, Play, RefreshCw, Shield, Sparkles, UserRound } from 'lucide-react';
import { getShareRoutebook, recordExposure } from '../../lib/api';
import { getProfile } from '../../lib/profile';
import { getRouteTrustBadgeState, getStopTrustState, maskTrustMetrics } from '../../lib/trust';

export default function PublicSharePage({ publicId, onBack, onSave, onUse, onCustomize, onOpenCreator }) {
  const [state, setState] = useState({ loading: true, error: '', routebook: null });
  const [actionState, setActionState] = useState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
  const exposureRef = useRef('');

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', routebook: null });
    setActionState({ pending: '', message: '', isError: false, savedDraft: null, synced: false });
    getShareRoutebook(publicId, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: '', routebook: data.routebook });
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: error.message, routebook: null });
      });
    return () => ctrl.abort();
  }, [publicId]);

  useEffect(() => {
    const routebook = state.routebook;
    const routeId = routebook?.publicId || routebook?.id;
    if (!routebook || !routeId || exposureRef.current === routeId) return;
    exposureRef.current = routeId;
    const profile = getProfile();
    recordExposure({
      profileId: profile.id,
      surface: 'public-share',
      itemType: 'routebook',
      itemId: routeId,
      routeId,
      routeTitle: routebook.title,
      city: routebook.city,
      creatorId: routebook.creator?.id
    }).catch(() => {});
  }, [state.routebook]);

  if (state.loading) {
    return (
      <div className="share-page-shell">
        <div className="share-page-loading">
          <Sparkles size={28} />
          <p>正在读取分享路书...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.routebook) {
    return (
      <div className="share-page-shell">
        <div className="share-page-error">
          <AlertCircle size={28} />
          <h1>分享路书暂不可用</h1>
          <p>{state.error || '链接不存在或已失效'}</p>
          <button className="btn btn-secondary" onClick={onBack}>
            <ArrowLeft size={16} /> 返回首页
          </button>
        </div>
      </div>
    );
  }

  const routebook = state.routebook;
  const stops = routebook.stops ?? [];
  const days = routebook.days ?? ['Day 1'];
  const trustState = getRouteTrustBadgeState(routebook);
  const TrustStateIcon = trustState.tone === 'trial' ? AlertCircle : Shield;
  const visibleMetrics = maskTrustMetrics(routebook.metrics, trustState.tone, 6);

  async function copyShareText() {
    setActionState((current) => ({ ...current, message: '', isError: false }));
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不支持自动复制');
      await navigator.clipboard.writeText(buildShareText(routebook));
      setActionState((current) => ({ ...current, message: '路线摘要已复制。', isError: false }));
    } catch (error) {
      setActionState((current) => ({
        ...current,
        message: `${error.message || '浏览器未允许复制'}，请检查浏览器剪贴板权限。`,
        isError: true
      }));
    }
  }

  async function saveToMyRoutebooks() {
    if (!onSave || actionState.pending || actionState.savedDraft) return;
    setActionState((current) => ({ ...current, pending: 'save', message: '', isError: false }));
    try {
      const result = await onSave(routebook, { surface: 'public-share-save' });
      const syncNote = result.synced
        ? result.attributionSynced === false
          ? '已保存到我的路书，来源归因暂未同步。'
          : '已保存到我的路书。'
        : `已保存到本地，服务端暂未同步：${result.syncError || '网络不可用'}`;
      setActionState({
        pending: '',
        message: syncNote,
        isError: false,
        savedDraft: result.routebook,
        synced: result.synced
      });
    } catch (error) {
      setActionState({ pending: '', message: error.message, isError: true, savedDraft: null, synced: false });
    }
  }

  async function useRoutebookNow() {
    if (!onUse || actionState.pending) return;
    setActionState((current) => ({ ...current, pending: 'use', message: '', isError: false }));
    try {
      await onUse(routebook, {
        surface: 'public-share-use',
        savedRoutebook: actionState.savedDraft,
        synced: actionState.synced
      });
    } catch (error) {
      setActionState((current) => ({ ...current, pending: '', message: error.message, isError: true }));
    }
  }

  return (
    <div className="share-page-shell page-enter">
      <div className="share-page-hero">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={16} /> 返回平台
        </button>
        <div className="share-page-title">
          <span className={`badge ${trustState.badgeClass}`}>
            <TrustStateIcon size={12} /> {trustState.compactText}
          </span>
          <h1>{routebook.title}</h1>
          <p>{routebook.summary}</p>
          {routebook.creator?.id && (
            <button className="share-creator-link" onClick={() => onOpenCreator?.(routebook.creator.id)}>
              <UserRound size={14} />
              <span>{routebook.creator.name}</span>
              <b>{routebook.copyCount ?? 0} 次复制</b>
            </button>
          )}
        </div>
        <div className="share-page-actions">
          <button className="btn btn-green btn-lg share-page-primary-action" disabled={Boolean(actionState.pending)} onClick={useRoutebookNow}>
            <Play size={18} />{' '}
            {actionState.pending === 'use' ? '正在保存私有副本...' : actionState.savedDraft ? '使用已保存副本开始行程' : '保存私有副本并开始行程'}
          </button>
          <div className="share-page-secondary-actions">
            <button className="btn btn-secondary" disabled={Boolean(actionState.pending || actionState.savedDraft)} onClick={saveToMyRoutebooks}>
              <BookmarkPlus size={16} /> {actionState.savedDraft ? '已保存私有副本' : actionState.pending === 'save' ? '正在保存...' : '仅保存私有副本'}
            </button>
            <button className="btn btn-ghost" disabled={Boolean(actionState.pending)} onClick={() => onCustomize(routebook, { surface: 'public-share' })}>
              <RefreshCw size={16} /> 定制路线
            </button>
            <button className="btn btn-ghost" disabled={Boolean(actionState.pending)} onClick={copyShareText}>
              <Copy size={16} /> 复制摘要
            </button>
          </div>
          <p
            className="share-action-feedback text-caption"
            role="status"
            aria-live="polite"
            aria-atomic="true"
            style={{ color: actionState.isError ? 'var(--red)' : 'var(--muted)' }}
          >
            {actionState.message}
          </p>
        </div>
      </div>

      <div className="share-page-grid">
        <section className="share-page-panel">
          <h2>路线结构</h2>
          <div className="share-page-days">
            {days.map((day) => (
              <div key={day} className="share-page-day">
                <span className="badge badge-blue">{day}</span>
                {stops
                  .filter((stop) => stop.day === day)
                  .map((stop, index) => {
                    const stopTrust = getStopTrustState(stop, trustState.tone);
                    return (
                      <div key={stop.id ?? `${day}-${index}`} className="share-page-stop">
                        <span>{index + 1}</span>
                        <div>
                          <strong>{stop.name}</strong>
                          <small>
                            {stop.time} · {stop.stay} · {stop.cost}
                          </small>
                          <p>{stop.verify}</p>
                        </div>
                        <b className={`trust-${stopTrust.tone}`}>{stopTrust.value}</b>
                      </div>
                    );
                  })}
              </div>
            ))}
          </div>
        </section>

        <aside className="share-page-side">
          <section className="share-page-panel compact">
            <h2>可信依据</h2>
            <div className="share-page-metrics">
              {visibleMetrics.map((metric) => (
                <div key={metric.label}>
                  <span>{metric.label}</span>
                  <strong>{metric.value}</strong>
                </div>
              ))}
            </div>
          </section>
          <section className="share-page-panel compact">
            <h2>可执行校验</h2>
            <div className="share-page-validations">
              {(routebook.validations ?? []).slice(0, 6).map((item) => (
                <div key={item.id}>
                  <span className="badge badge-orange">{item.state}</span>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
              ))}
            </div>
          </section>
          <section className="share-page-panel compact">
            <h2>分享说明</h2>
            <p className="text-caption">公开页只展示结构化路线、站点可信度和校验结果；不搬运第三方攻略原文。真实打卡会继续校准路线质量。</p>
            <p className="text-caption" style={{ marginTop: 10 }}>
              <MapPin size={12} /> {routebook.city} · {stops.length} 站
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function buildShareText(routebook) {
  const stops = routebook.stops ?? [];
  return [
    `${routebook.title}`,
    `${getRouteTrustBadgeState(routebook).compactText}｜${routebook.city}`,
    routebook.summary,
    '',
    ...stops.slice(0, 10).map((stop, index) => `${index + 1}. ${stop.time} ${stop.name}｜${stop.stay}｜${stop.cost}`),
    '',
    '由可信路书 AI 生成，真实打卡持续验证。'
  ].join('\n');
}
