import React, { useEffect, useMemo, useState } from 'react';
import { Camera, Copy, ExternalLink, Heart, KeyRound, MapPin, Plus, RotateCcw, Route, Save, Share2, Shield, Ticket, Trash2, UserRound } from 'lucide-react';
import { getMyCheckins, getMyClicks, getMyFavorites, getMyRoutebooks, saveProfile } from '../../lib/api';
import { flushAllCheckinQueues } from '../../lib/checkinQueue';
import { deleteRoutebook, getStoredClicks, getStoredFavorites, getStoredRoutebooks, listStoredCheckins, removeFavorite } from '../../lib/storage';
import { createProfileSyncCode, getProfile, parseProfileSyncCode, updateProfile } from '../../lib/profile';
import { adoptServerProfile } from '../../lib/profileSync';
import { getRouteTrustBadgeState } from '../../lib/trust';

export default function MyPage({ onOpenBook, onNewBook, onOpenCreator, onProfileChanged, onLocalBooksChanged }) {
  const [serverData, setServerData] = useState({ routebooks: [], checkins: [], clicks: [], favorites: [] });
  const [profile, setProfile] = useState(() => getProfile());
  const [profileMessage, setProfileMessage] = useState('');
  const [syncCode, setSyncCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('routebooks');
  const [localDataVersion, setLocalDataVersion] = useState(0);
  const [removedFavoriteKeys, setRemovedFavoriteKeys] = useState(() => new Set());
  const [favoriteNotice, setFavoriteNotice] = useState('');
  const localBooks = useMemo(() => getStoredRoutebooks(profile.id), [profile.id, localDataVersion]);
  const localCheckins = useMemo(() => listStoredCheckins().filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);
  const localClicks = useMemo(() => getStoredClicks().filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);
  const localFavorites = useMemo(() => getStoredFavorites(profile.id).filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);

  useEffect(() => {
    const ctrl = new AbortController();
    setServerData({ routebooks: [], checkins: [], clicks: [], favorites: [] });
    setError('');
    // 未注册（无 profile token）时服务端只会回 401/403，直接跳过请求、渲染本地数据。
    if (!profile.profileAccessToken) return () => ctrl.abort();
    Promise.allSettled([
      getMyRoutebooks(profile.id, 80, ctrl.signal),
      getMyCheckins(profile.id, 80, ctrl.signal),
      getMyClicks(profile.id, 80, ctrl.signal),
      getMyFavorites(profile.id, 80, ctrl.signal)
    ]).then(([bookResult, checkinResult, clickResult, favoriteResult]) => {
      if (ctrl.signal.aborted) return;
      setServerData({
        routebooks: bookResult.status === 'fulfilled' ? (bookResult.value.routebooks ?? []) : [],
        checkins: checkinResult.status === 'fulfilled' ? (checkinResult.value.checkins ?? []) : [],
        clicks: clickResult.status === 'fulfilled' ? (clickResult.value.clicks ?? []) : [],
        favorites: favoriteResult.status === 'fulfilled' ? (favoriteResult.value.favorites ?? []) : []
      });
      // 401/403 视为未授权静默降级，仅 5xx 才展示错误横幅。
      const failures = [bookResult, checkinResult, clickResult, favoriteResult]
        .filter((item) => item.status === 'rejected' && Number(item.reason?.status) >= 500);
      setError(failures.length ? failures.map((item) => item.reason?.message).filter(Boolean).join('；') || '服务端暂时不可用' : '');
    });
    return () => ctrl.abort();
  }, [profile.id, profile.profileAccessToken]);

  useEffect(() => {
    if (activeTab !== 'checkins') return;
    // rank7①：打开打卡 tab 时尝试补传一次离线打卡队列，失败保持静默。
    try {
      if (typeof flushAllCheckinQueues === 'function') {
        Promise.resolve(flushAllCheckinQueues({ profile: getProfile() }))
          .then((result) => {
            // 补传有实际写入（成功与失败都会改写队列行）时重读本地打卡/点击列表。
            if (result?.attempted) setLocalDataVersion((value) => value + 1);
          })
          .catch(() => {});
      }
    } catch {
      // 补传失败静默，队列会在网络恢复时自动重试。
    }
  }, [activeTab]);

  const books = mergeBooks(localBooks, serverData.routebooks);
  // 打卡去重键与 ReviewPage 口径一致：clientLocalId 优先（服务端行也带）、服务端 id 兜底，
  // 避免本地行还没回写服务端 id 时本地 + 服务端双倍计数。
  const checkins = mergeRows(localCheckins, serverData.checkins, (item) =>
    String(item.clientLocalId || item.id || `${item.routeTitle ?? ''}:${item.stopId ?? item.stopName ?? ''}:${item.time ?? item.createdAt ?? ''}`));
  // 点击优先用 productId + 分钟级时间复合键（服务端行也能匹配到未回写 id 的本地行），拼不出复合键再退服务端 id。
  const clicks = mergeRows(localClicks, serverData.clicks, (item) => {
    const productKey = String(item.productId ?? item.productTitle ?? item.title ?? '').trim();
    const timeKey = minuteTimestamp(item.createdAt ?? item.clickedAt);
    if (productKey && timeKey) return `${item.routeId ?? ''}:${productKey}:${timeKey}`;
    return String(item.id || `${item.routeId ?? ''}:${productKey}:${timeKey}`);
  });
  const favorites = mergeRows(localFavorites, serverData.favorites, (item) => `${item.routeId ?? ''}:${item.routeTitle ?? ''}:${item.createdAt ?? ''}`)
    .filter((item) => !removedFavoriteKeys.has(favoriteKeyOf(item)));
  const sharedBooks = books.filter((book) => ['published', 'featured'].includes(book.publishStatus));
  const creatorBooks = sharedBooks.filter((book) => book.creator?.id === profile.id || book.profileId === profile.id);

  function handleRemoveFavorite(item) {
    // 服务端暂无取消收藏接口：仅删除本地记录，并在本次会话中隐藏服务端返回的同一条。
    removeFavorite(item, profile.id);
    const key = favoriteKeyOf(item);
    if (key) setRemovedFavoriteKeys((prev) => new Set(prev).add(key));
    setLocalDataVersion((value) => value + 1);
    setFavoriteNotice('已取消收藏；服务端暂无取消接口，仅移除了本机记录。');
  }

  function handleDeleteBook(book) {
    const label = book?.title || book?.city || '未命名路书';
    if (!window.confirm(`确定删除路书「${label}」的本机存档吗？服务端已保存的副本不受影响。`)) return;
    deleteRoutebook(book);
    setLocalDataVersion((value) => value + 1);
    // 通知 App 就地更新 savedBooks，避免停留本页时 TripReminderBanner 仍持已删的书。
    onLocalBooksChanged?.(book);
  }

  async function handleProfileSave(event) {
    event.preventDefault();
    const next = updateProfile(profile);
    setProfile(next);
    setProfileMessage('保存中...');
    try {
      const data = await saveProfile(next);
      const adoption = adoptServerProfile(data.profile, next);
      const saved = adoption.profile;
      setProfile(saved);
      onProfileChanged?.(saved);
      setProfileMessage(adoption.migratedCount
        ? `已保存偏好，并迁移 ${adoption.migratedCount} 条本机资产到新身份`
        : '已保存偏好，下一次生成会默认套用');
    } catch (err) {
      setProfileMessage(`本地已保存，服务端同步失败：${err.message}`);
    }
  }

  async function prepareSyncCode({ copy = false } = {}) {
    setSyncBusy(true);
    setProfileMessage('正在准备跨设备恢复码...');
    try {
      let activeProfile = profile;
      if (!activeProfile.profileAccessToken) {
        const data = await saveProfile(activeProfile);
        const adoption = adoptServerProfile(data.profile, activeProfile);
        activeProfile = adoption.profile;
        setProfile(activeProfile);
        onProfileChanged?.(activeProfile);
      }
      const code = createProfileSyncCode(activeProfile);
      setSyncCode(code);
      if (copy) {
        if (!navigator.clipboard?.writeText) throw new Error('浏览器未开放剪贴板权限');
        await navigator.clipboard.writeText(code);
        setProfileMessage('恢复码已复制，请只保存到自己的密码管理器或私密设备');
      } else {
        setProfileMessage('恢复码已生成');
      }
    } catch (err) {
      setProfileMessage(`恢复码生成失败：${err.message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  async function recoverProfile() {
    setSyncBusy(true);
    setProfileMessage('正在校验恢复码并同步账号...');
    try {
      const credentials = parseProfileSyncCode(recoveryCode);
      const data = await saveProfile({
        id: credentials.profileId,
        profileId: credentials.profileId,
        profileAccessToken: credentials.profileAccessToken
      });
      const adoption = adoptServerProfile({ ...data.profile, previousLocalId: profile.id }, profile);
      const next = adoption.profile;
      setProfile(next);
      setSyncCode(createProfileSyncCode(next));
      setRecoveryCode('');
      onProfileChanged?.(next);
      setProfileMessage(`账号已恢复${adoption.migratedCount ? `，并迁移 ${adoption.migratedCount} 条本机资产` : ''}`);
    } catch (err) {
      setProfileMessage(`账号恢复失败：${err.message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  return (
    <div className="container my-page page-enter">
      <div className="my-hero">
        <div>
          <span className="section-kicker">我的资产</span>
          <h1>路书、打卡和分享</h1>
          <p className="text-body">
            本机资产与服务端记录统一展示；恢复码可在另一设备继续同一段旅行。
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => onNewBook({})}><Plus size={16} /> 新建路书</button>
      </div>
      {error && <p className="text-caption" role="status" aria-live="polite" aria-atomic="true" style={{ marginTop: 12, color: 'var(--orange)' }}>服务端资产暂不可用，已显示本地数据：{error}</p>}

      <div className="stats-grid" style={{ marginTop: 28 }}>
        <Stat icon={Route} label="我的路书" value={books.length} />
        <Stat icon={Camera} label="我的打卡" value={checkins.length} />
        <Stat icon={Share2} label="我的分享" value={sharedBooks.length} />
        <Stat icon={Ticket} label="商品点击" value={clicks.length} />
      </div>

      <div className="my-tabs" role="tablist" aria-label="我的资产分类">
        <MyTab id="routebooks" activeTab={activeTab} onSelect={setActiveTab} icon={Route} label="路书" count={books.length} />
        <MyTab id="favorites" activeTab={activeTab} onSelect={setActiveTab} icon={Heart} label="收藏" count={favorites.length} />
        <MyTab id="checkins" activeTab={activeTab} onSelect={setActiveTab} icon={Camera} label="打卡" count={checkins.length} />
        <MyTab id="account" activeTab={activeTab} onSelect={setActiveTab} icon={UserRound} label="账户" />
      </div>

      {activeTab === 'routebooks' && (
        <div className="my-section-grid" role="tabpanel" aria-label="路书">
          <section className="ops-panel my-section-primary">
            <div className="ops-panel-head">
              <h2>我的路书</h2>
              <span className="badge badge-blue"><Shield size={11} /> {books.length} 条</span>
            </div>
            {books.length ? (
              <>
                <div className="book-grid compact">
                  {books.slice(0, 8).map((book) => {
                    const trustState = getRouteTrustBadgeState(book);
                    const bookKey = book.publicId ?? book.id ?? `${book.city}-${book.title}`;
                    return (
                      <div key={bookKey} style={{ position: 'relative' }}>
                        <button className="book-card compact-book" style={{ width: '100%', height: '100%' }} onClick={() => onOpenBook(book)}>
                          <span className={`badge ${trustState.badgeClass}`}><Shield size={12} /> {trustState.compactText}</span>
                          <h3>{book.title || '未命名路书'}</h3>
                          <p>{book.summary?.slice(0, 70) || '暂无路线摘要'}</p>
                          <span><MapPin size={12} /> {book.city || '城市待补充'} · {book.stops?.length ?? 0} 站</span>
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          style={{ position: 'absolute', top: 10, right: 10 }}
                          aria-label={`删除路书 ${book.title || book.city || ''}`}
                          title="删除本机存档"
                          onClick={() => handleDeleteBook(book)}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    );
                  })}
                </div>
                {books.length > 8 && <p className="text-caption" style={{ marginTop: 10 }}>仅显示最近 8 条，共 {books.length} 条</p>}
              </>
            ) : <Empty text="还没有路书，先粘贴攻略链接生成一条。" />}
          </section>

          <div className="my-section-stack">
            <section className="ops-panel">
              <div className="ops-panel-head">
                <h2>我的公开路线</h2>
                <span className="badge badge-blue"><UserRound size={11} /> {creatorBooks.length} 条</span>
              </div>
              {creatorBooks.length ? (
                <div className="ops-list">
                  {creatorBooks.slice(0, 8).map((book) => (
                    <div key={`creator-${book.publicId || book.title}`} className="checkin-review-row">
                      <strong>{book.title || '未命名路书'}</strong>
                      <span>{book.city || '城市待补充'} · {book.publishStatus || 'draft'} · {getRouteTrustBadgeState(book).compactText}</span>
                      <p><Copy size={12} /> 复制 {book.copyCount ?? 0} 次 · {book.creator?.sourceAuthorization || book.sourceAuthorization || 'user-generated'}</p>
                    </div>
                  ))}
                </div>
              ) : <Empty text="保存路书后会自动带上你的达人身份，可在运营台发布。" />}
            </section>

            <section className="ops-panel">
              <div className="ops-panel-head">
                <h2>我的分享</h2>
                <span className="badge badge-blue"><Share2 size={11} /> {sharedBooks.length} 条</span>
              </div>
              {sharedBooks.length ? (
                <div className="ops-list">
                  {sharedBooks.slice(0, 8).map((book) => {
                    const url = book.shareUrl || `/share/${book.publicId}`;
                    return (
                      <div key={`${book.publicId}-${book.title}`} className="checkin-review-row">
                        <strong>{book.title || '未命名路书'}</strong>
                        <span>{book.city || '城市待补充'} · {getRouteTrustBadgeState(book).compactText}</span>
                        <a href={url} target="_blank" rel="noreferrer"><ExternalLink size={12} /> 打开分享页</a>
                      </div>
                    );
                  })}
                </div>
              ) : <Empty text="发布或精选后的路书会出现在这里。" />}
            </section>
          </div>
        </div>
      )}

      {activeTab === 'favorites' && (
        <section className="ops-panel my-tab-panel" role="tabpanel" aria-label="收藏">
          <div className="ops-panel-head">
            <h2>我的收藏</h2>
            <span className="badge badge-blue"><Heart size={11} /> {favorites.length} 条</span>
          </div>
          {favoriteNotice && <p className="text-caption" role="status" aria-live="polite" aria-atomic="true">{favoriteNotice}</p>}
          {favorites.length ? (
            <>
              <div className="ops-list my-asset-list">
                {favorites.slice(0, 12).map((item) => (
                  <div key={item.id ?? favoriteKeyOf(item)} className="checkin-review-row">
                    <strong>{item.routeTitle || item.routeId || '未命名收藏路线'}</strong>
                    <span>{item.city || '城市待补充'} · {formatHistoryDate(item.createdAt)}</span>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={!item.routeId}
                        onClick={() => onOpenBook(books.find((book) => (book.publicId || book.id) === item.routeId) || { id: item.routeId, publicId: item.routeId })}
                      >
                        打开路线
                      </button>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => handleRemoveFavorite(item)}>
                        <Trash2 size={13} /> 取消收藏
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {favorites.length > 12 && <p className="text-caption" style={{ marginTop: 10 }}>仅显示最近 12 条，共 {favorites.length} 条</p>}
            </>
          ) : <Empty text="在路线详情页点收藏后会沉淀到这里。" />}
        </section>
      )}

      {activeTab === 'checkins' && (
        <div className="my-section-grid balanced" role="tabpanel" aria-label="打卡">
          <section className="ops-panel">
            <div className="ops-panel-head">
              <h2>我的打卡</h2>
              <span className="badge badge-green"><Camera size={11} /> {checkins.length} 条</span>
            </div>
            {checkins.length ? (
              <>
                <div className="ops-list">
                  {checkins.slice(0, 12).map((item, index) => (
                    <div key={`${item.id ?? item.stopName}-${index}`} className="checkin-review-row">
                      <strong>{item.stopName || '未命名地点'}</strong>
                      <span>{item.city || '城市待补充'} · {item.worth || '体验待补充'} · 排队 {item.queue ?? '待补充'}</span>
                      <p>{item.comment || item.pitfall || '无补充'}</p>
                    </div>
                  ))}
                </div>
                {checkins.length > 12 && <p className="text-caption" style={{ marginTop: 10 }}>仅显示最近 12 条，共 {checkins.length} 条</p>}
              </>
            ) : <Empty text="进入行中模式后，GPS 和体验反馈会沉淀到这里。" />}
          </section>

          <section className="ops-panel">
            <div className="ops-panel-head">
              <h2>最近商品点击</h2>
              <span className="badge badge-orange"><Ticket size={11} /> {clicks.length} 条</span>
            </div>
            {clicks.length ? (
              <>
                <div className="product-ops-list">
                  {clicks.slice(0, 12).map((item, index) => (
                    <div key={`${item.productTitle ?? item.title}-${index}`} className="product-ops-row">
                      <span className="badge badge-blue">{item.type || '商品'}</span>
                      <div>
                        <strong>{item.productTitle || item.title || '未命名商品'}</strong>
                        <p>{item.poi || '关联地点待补充'} · {item.provider || '本地记录'}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {clicks.length > 12 && <p className="text-caption" style={{ marginTop: 10 }}>仅显示最近 12 条，共 {clicks.length} 条</p>}
              </>
            ) : <Empty text="点击路线里的商品卡后会记录在这里。" />}
          </section>
        </div>
      )}

      {activeTab === 'account' && (
        <section className="ops-panel my-account-panel" role="tabpanel" aria-label="账户">
          <div className="ops-panel-head">
            <h2>账户与旅行偏好</h2>
            <span className="badge badge-blue"><UserRound size={11} /> {profile.id}</span>
          </div>
          <form className="profile-form" onSubmit={handleProfileSave}>
            <div className="card-flat profile-bind-card">
              <div>
                <span className="input-label">正式账号</span>
                <p className="text-caption">
                  {profile.identityBound
                    ? `当前资料保留已有身份记录：${profile.identity?.label || '已绑定身份'}；新的短信或微信绑定暂未开放。`
                    : '短信验证码和微信授权尚未接入，当前不收集手机号或微信 OpenID。可继续使用本地资料，并通过下方恢复码跨设备恢复。'}
                </p>
              </div>
              <span className="badge badge-blue">{profile.identityBound ? '已有记录' : '待接入'}</span>
            </div>
            <div className="profile-sync-section">
              <div className="profile-sync-heading">
                <div>
                  <span className="input-label"><KeyRound size={13} /> 跨设备恢复</span>
                  <p className="text-caption">恢复码等同账号访问权限，请勿发到群聊、评论区或公开笔记。</p>
                </div>
                <button className="btn btn-secondary btn-sm" type="button" disabled={syncBusy} onClick={() => prepareSyncCode({ copy: Boolean(syncCode) })}>
                  <Copy size={14} /> {syncCode ? '复制恢复码' : '生成恢复码'}
                </button>
              </div>
              {syncCode && <textarea className="input-field profile-sync-code" value={syncCode} readOnly aria-label="当前账号恢复码" />}
              <div className="profile-recovery-row">
                <textarea
                  className="input-field profile-sync-code"
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  placeholder="粘贴另一设备生成的恢复码"
                  aria-label="粘贴账号恢复码"
                />
                <button className="btn btn-secondary btn-sm" type="button" disabled={syncBusy || !recoveryCode.trim()} onClick={recoverProfile}>
                  <RotateCcw size={14} /> 恢复账号
                </button>
              </div>
            </div>
            <label>
              <span className="input-label">常住/出发城市</span>
              <input className="input-field" value={profile.homeCity ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, homeCity: event.target.value }))} />
            </label>
            <label>
              <span className="input-label">常去城市</span>
              <input className="input-field" value={(profile.preferredCities ?? []).join('、')} onChange={(event) => setProfile((prev) => ({ ...prev, preferredCities: event.target.value.split(/[、,\s]+/).filter(Boolean) }))} />
            </label>
            <label>
              <span className="input-label">预算</span>
              <input className="input-field" value={profile.budget ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, budget: event.target.value }))} />
            </label>
            <label>
              <span className="input-label">同行 / 节奏</span>
              <div className="profile-inline-fields">
                <input className="input-field" value={profile.companion ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, companion: event.target.value }))} />
                <input className="input-field" value={profile.tempo ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, tempo: event.target.value }))} />
              </div>
            </label>
            <label>
              <span className="input-label">主题偏好</span>
              <input className="input-field" value={(profile.themes ?? []).join('、')} onChange={(event) => setProfile((prev) => ({ ...prev, themes: event.target.value.split(/[、,\s]+/).filter(Boolean) }))} />
            </label>
            <label>
              <span className="input-label">达人名称</span>
              <input className="input-field" value={profile.creatorName ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, creatorName: event.target.value }))} placeholder="用于公开路线作者展示" />
            </label>
            <label>
              <span className="input-label">达人简介</span>
              <textarea className="input-field" value={profile.creatorBio ?? ''} onChange={(event) => setProfile((prev) => ({ ...prev, creatorBio: event.target.value }))} placeholder="例如：周末短途路线整理者，偏好少绕路和真实打卡反馈" />
            </label>
            <div className="profile-inline-actions">
              <button className="btn btn-primary btn-sm" type="submit"><Save size={14} /> 保存偏好</button>
              <button className="btn btn-secondary btn-sm" type="button" onClick={() => onOpenCreator?.(profile.id)}><UserRound size={14} /> 达人主页</button>
            </div>
            {profileMessage && <p className="text-caption" role="status" aria-live="polite" aria-atomic="true">{profileMessage}</p>}
          </form>
        </section>
      )}
    </div>
  );
}

function MyTab({ id, activeTab, onSelect, icon: Icon, label, count }) {
  const active = activeTab === id;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`my-tab ${active ? 'active' : ''}`}
      onClick={() => onSelect(id)}
    >
      <Icon size={16} />
      <span>{label}</span>
      {Number.isFinite(count) && <b>{count}</b>}
    </button>
  );
}

function Stat({ icon: Icon, label, value }) {
  return (
    <div className="stat-card ops-stat">
      <Icon size={20} />
      <span>{label}</span>
      <strong>{value}</strong>
      <small>本地 + 服务端</small>
    </div>
  );
}

function Empty({ text }) {
  return <p className="text-caption">{text}</p>;
}

function formatHistoryDate(value) {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN') : '时间待补充';
}

function minuteTimestamp(value) {
  // 本地点击行与服务端行的时间戳可能相差数秒，按分钟级归一后去重。
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 16) : String(value ?? '');
}

function favoriteKeyOf(favorite) {
  // 与 storage.js 的 favoriteRouteKey 保持一致，取消收藏时用同一键匹配本地与服务端行。
  return String(favorite?.routeId || favorite?.routeTitle || favorite?.id || '').trim();
}

function mergeBooks(localBooks, serverBooks) {
  const map = new Map();
  for (const book of serverBooks) {
    const key = book.publicId || `${book.city}-${book.title}`;
    map.set(key, book);
  }
  for (const book of localBooks) {
    const key = book.publicId || `${book.city}-${book.title}`;
    const remote = map.get(key);
    if (!remote) {
      map.set(key, book);
      continue;
    }
    const localIsNewer = routebookTimestamp(book) >= routebookTimestamp(remote);
    const newer = localIsNewer ? book : remote;
    const older = localIsNewer ? remote : book;
    map.set(key, {
      ...older,
      ...newer,
      provider: { ...(older.provider ?? {}), ...(newer.provider ?? {}) },
      editToken: validEditToken(newer.editToken) || validEditToken(older.editToken) || undefined
    });
  }
  return [...map.values()].sort((a, b) => routebookTimestamp(b) - routebookTimestamp(a));
}

function routebookTimestamp(book) {
  return Math.max(0, ...[
    book?.provider?.editedAt,
    book?.updatedAt,
    book?.provider?.generatedAt,
    book?.createdAt
  ].map((value) => Date.parse(value ?? '') || 0));
}

function validEditToken(value) {
  const token = String(value ?? '').trim();
  return token && token.length <= 96 && /^[A-Za-z0-9_-]+$/.test(token) ? token : '';
}

function mergeRows(localRows, serverRows, keyFn) {
  const map = new Map();
  for (const row of [...serverRows, ...localRows]) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()].sort((a, b) =>
    String(b.createdAt ?? b.time ?? b.clickedAt ?? '').localeCompare(String(a.createdAt ?? a.time ?? a.clickedAt ?? ''))
  );
}

function belongsToProfile(item, profileId) {
  if (!profileId) return false;
  return item?.profileId === profileId || item?.creator?.id === profileId;
}
