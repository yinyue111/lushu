import { useEffect, useState } from 'react';
import { ArrowLeft, Camera, Copy, MapPin, Route, Shield, Star, Ticket } from 'lucide-react';
import { getCreatorProfile } from '../../lib/api';
import { getRouteTrustBadgeState } from '../../lib/trust';

export default function CreatorPage({ creatorId, onBack, onOpenBook, onCustomize }) {
  const [state, setState] = useState({ loading: true, error: '', data: null });

  useEffect(() => {
    const ctrl = new AbortController();
    setState({ loading: true, error: '', data: null });
    getCreatorProfile(creatorId, ctrl.signal)
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: '', data: data.profile });
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setState({ loading: false, error: error.message, data: null });
      });
    return () => ctrl.abort();
  }, [creatorId]);

  if (state.loading) {
    return (
      <div className="creator-page-shell page-enter">
        <div className="share-page-loading">
          <Route size={28} />
          <p>正在读取达人路线合集...</p>
        </div>
      </div>
    );
  }

  if (state.error || !state.data) {
    return (
      <div className="creator-page-shell page-enter">
        <div className="share-page-error">
          <Route size={28} />
          <h1>达人主页暂不可用</h1>
          <p>{state.error || '达人不存在或尚未发布路线'}</p>
          <button className="btn btn-secondary" onClick={onBack}>
            <ArrowLeft size={16} /> 返回
          </button>
        </div>
      </div>
    );
  }

  const { creator, stats, routebooks } = state.data;
  const visibleRoutebooks = (routebooks ?? []).filter((book) => book.publishStatus !== 'archived');
  const verifiedScores = visibleRoutebooks
    .map((book) => getRouteTrustBadgeState(book))
    .filter((trustState) => trustState.verified)
    .map((trustState) => trustState.score);
  const verifiedAverage = verifiedScores.length ? Math.round(verifiedScores.reduce((sum, score) => sum + score, 0) / verifiedScores.length) : null;

  return (
    <div className="creator-page-shell page-enter">
      <section className="creator-hero">
        <button className="btn btn-ghost btn-sm" onClick={onBack}>
          <ArrowLeft size={16} /> 返回平台
        </button>
        <div className="creator-avatar" aria-hidden="true">
          {creator.name?.slice(0, 1) || '路'}
        </div>
        <div className="creator-title">
          <span className="badge badge-blue">{creator.sourceAuthorization === 'user-generated' ? '用户发布' : '授权内容'}</span>
          <h1>{creator.name || creator.id}</h1>
          <p>{creator.bio || '路线合集由真实保存、复制和打卡反馈持续校准。'}</p>
        </div>
      </section>

      <div className="creator-stats-grid">
        <Stat icon={Route} label="公开路线" value={stats.routebookCount ?? visibleRoutebooks.length} />
        <Stat icon={Copy} label="复制次数" value={stats.copyCount ?? 0} />
        <Stat icon={Camera} label="有效打卡" value={stats.validCheckins ?? 0} />
        <Stat icon={Ticket} label="商品点击" value={stats.clickCount ?? 0} />
      </div>

      <section className="creator-route-section">
        <div className="ops-panel-head">
          <h2>路线合集</h2>
          <span className={`badge ${verifiedAverage === null ? 'badge-blue' : 'badge-green'}`}>
            <Shield size={11} /> {verifiedAverage === null ? '真实可信均分待验证' : `真实可信均分 ${verifiedAverage}`}
          </span>
        </div>
        {visibleRoutebooks.length ? (
          <div className="creator-route-grid">
            {visibleRoutebooks.map((book) => {
              const trustState = getRouteTrustBadgeState(book);
              return (
                <article key={book.publicId || book.title} className="creator-route-card">
                  <div>
                    <span className={`badge ${trustState.badgeClass}`}>
                      <Shield size={12} /> {trustState.compactText}
                    </span>
                    <h3>{book.title}</h3>
                    <p>{book.summary}</p>
                  </div>
                  <div className="creator-route-meta">
                    <span>
                      <MapPin size={13} /> {book.city}
                    </span>
                    <span>
                      <Copy size={13} /> {book.copyCount ?? 0}
                    </span>
                    <span>
                      <Star size={13} /> {book.publishStatus || 'draft'}
                    </span>
                  </div>
                  <div className="creator-route-actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => onOpenBook(book)}>
                      查看路书
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={() => onCustomize(book)}>
                      生成定制版
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="text-caption">该达人暂未发布公开路线。</p>
        )}
      </section>
    </div>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="stat-card ops-stat">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>平台聚合</small>
    </div>
  );
}
