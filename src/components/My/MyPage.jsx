import { NETWORK_ERROR_TEXT } from '../../lib/networkCopy.js';
import { useEffect, useMemo, useState } from 'react';
import { Camera, Copy, ExternalLink, Heart, MapPin, Plus, Route, Ticket, Trash2, UserRound } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { LOCAL_ROUTEBOOKS_CHANGED_EVENT } from '../../lib/routebookTombstones';
import { deleteFavorite, deleteRoutebookRemote, getMyCheckins, getMyClicks, getMyFavorites, getMyRoutebooks, saveProfile } from '../../lib/api';
import { flushAllCheckinQueues, pauseCheckinQueue } from '../../lib/checkinQueue';
import { deleteRoutebook, getStoredClicks, getStoredFavorites, getStoredRoutebooks, listStoredCheckins, removeFavorite } from '../../lib/storage';
import { getProfile, hasProfileCloudRegistrationConsent, parseProfileSyncCode, resetProfile, updateProfile } from '../../lib/profile';
import { deleteProfileRemote, exportProfileData, issueRecoveryCode, logoutProfileRemote } from '../../lib/profileApi';
import { clearLocalProfileData, stripLocalExportSecrets } from '../../lib/profileData';
import { adoptServerProfile } from '../../lib/profileSync';
import { listTripSessions } from '../../lib/tripSession';
import { getRouteTrustBadgeState } from '../../lib/trust';
import { publishStatusLabel, sourceAuthorizationLabel } from '../ui/labels';
import { Button } from '../ui/button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { RouteCard } from '../cards/RouteCard';
import { routebookCardMeta } from '../../lib/routebookCardMeta';
import { EmptyArt } from '../visual/EmptyArt';
import { MyAccountPanel } from './MyAccountPanel';

/** @param {Record<string, any>} props */
export default function MyPage({ onOpenBook, onNewBook, onOpenCreator, onProfileChanged, onLocalBooksChanged }) {
  const [serverData, setServerData] = useState({ routebooks: [], checkins: [], clicks: [], favorites: [] });
  const [profile, setProfile] = useState(() => getProfile());
  const [profileMessage, setProfileMessage] = useState('');
  const [syncCode, setSyncCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [syncBusy, setSyncBusy] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState(() =>
    typeof window !== 'undefined' && ['#account', '#nickname'].includes(window.location.hash) ? 'account' : 'routebooks'
  );
  // V-U23: 「设个昵称」 links land on the nickname field itself, scrolled into view and focused.
  useEffect(() => {
    if (activeTab !== 'account' || window.location.hash !== '#nickname') return undefined;
    const timer = window.setTimeout(() => {
      const field = document.getElementById('nickname');
      field?.scrollIntoView({ block: 'center' });
      field?.focus({ preventScroll: true });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [activeTab]);
  const [localDataVersion, setLocalDataVersion] = useState(0);
  const [removedFavoriteKeys, setRemovedFavoriteKeys] = useState(() => new Set());
  const [favoriteNotice, setFavoriteNotice] = useState('');
  const [expandedSections, setExpandedSections] = useState(() => new Set());
  const [deleteTarget, setDeleteTarget] = useState(null);
  /* eslint-disable react-hooks/exhaustive-deps -- localDataVersion is a cache-busting tick: bumping it re-reads localStorage. */
  const localBooks = useMemo(() => getStoredRoutebooks(profile.id), [profile.id, localDataVersion]);
  const localCheckins = useMemo(() => listStoredCheckins().filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);
  const localClicks = useMemo(() => getStoredClicks().filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);
  const localFavorites = useMemo(() => getStoredFavorites(profile.id).filter((item) => belongsToProfile(item, profile.id)), [profile.id, localDataVersion]);
  /* eslint-enable react-hooks/exhaustive-deps */

  useEffect(() => {
    const ctrl = new AbortController();
    setServerData({ routebooks: [], checkins: [], clicks: [], favorites: [] });
    setError('');
    // 未注册（无 profile token）时服务端只会回 401/403，直接跳过请求、渲染本地数据。
    if (!profile.profileAccessToken && !profile.accountUserId) return () => ctrl.abort();
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
      const failures = /** @type {PromiseRejectedResult[]} */ (
        [bookResult, checkinResult, clickResult, favoriteResult].filter((item) => item.status === 'rejected' && Number(item.reason?.status) >= 500)
      );
      setError(
        failures.length
          ? failures
              .map((item) => item.reason?.message)
              .filter(Boolean)
              .join('；') || '云端暂时连不上'
          : ''
      );
    });
    return () => ctrl.abort();
  }, [profile.id, profile.profileAccessToken, profile.accountUserId]);

  // A routebook deleted on another device: App drops the local copy; re-read local storage and hide it here.
  useEffect(() => {
    const onChanged = (/** @type {any} */ event) => {
      const id = String(event?.detail?.id ?? '');
      setLocalDataVersion((value) => value + 1);
      if (id) setServerData((data) => ({ ...data, routebooks: data.routebooks.filter((book) => (book.publicId || book.id) !== id) }));
    };
    window.addEventListener(LOCAL_ROUTEBOOKS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(LOCAL_ROUTEBOOKS_CHANGED_EVENT, onChanged);
  }, []);

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
    String(item.clientLocalId || item.id || `${item.routeTitle ?? ''}:${item.stopId ?? item.stopName ?? ''}:${item.time ?? item.createdAt ?? ''}`)
  );
  // 点击优先用 productId + 分钟级时间复合键（服务端行也能匹配到未回写 id 的本地行），拼不出复合键再退服务端 id。
  const clicks = mergeRows(localClicks, serverData.clicks, (item) => {
    const productKey = String(item.productId ?? item.productTitle ?? item.title ?? '').trim();
    const timeKey = minuteTimestamp(item.createdAt ?? item.clickedAt);
    if (productKey && timeKey) return `${item.routeId ?? ''}:${productKey}:${timeKey}`;
    return String(item.id || `${item.routeId ?? ''}:${productKey}:${timeKey}`);
  });
  const favorites = mergeRows(localFavorites, serverData.favorites, (item) => `${item.routeId ?? ''}:${item.routeTitle ?? ''}:${item.createdAt ?? ''}`).filter(
    (item) => !removedFavoriteKeys.has(favoriteKeyOf(item))
  );
  const sharedBooks = books.filter((book) => ['published', 'featured'].includes(book.publishStatus));
  const creatorBooks = sharedBooks.filter((book) => book.creator?.id === profile.id || book.profileId === profile.id);

  async function handleRemoveFavorite(item) {
    removeFavorite(item, profile.id);
    const key = favoriteKeyOf(item);
    if (key) setRemovedFavoriteKeys((prev) => new Set(prev).add(key));
    setLocalDataVersion((value) => value + 1);
    // F14: also remove the cloud copy when this route was favourited on the server.
    const onServer = item.routeId && serverData.favorites.some((row) => row.routeId === item.routeId);
    if (!onServer) {
      setFavoriteNotice('已取消收藏。');
      return;
    }
    try {
      await deleteFavorite(profile.id, item.routeId);
      setFavoriteNotice('已取消收藏（本机和云端都已移除）。');
    } catch (removeError) {
      setFavoriteNotice(`本机已取消收藏，云端取消失败：${removeError?.message || '请稍后重试'}`);
    }
  }

  function toggleExpanded(section) {
    setExpandedSections((previous) => {
      const next = new Set(previous);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  function visibleRows(section, rows, collapsedCount) {
    return expandedSections.has(section) ? rows : rows.slice(0, collapsedCount);
  }

  function handleDeleteBook(book) {
    const label = book?.title || book?.city || '未命名路书';
    const remoteId = book?.publicId || '';
    const inAccount = Boolean(
      profile.accountUserId && remoteId && (book.profileId === profile.id || serverData.routebooks.some((item) => item.publicId === remoteId))
    );
    setDeleteTarget({ book, label, remoteId, inAccount });
  }

  async function confirmDeleteBook() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    const { book, remoteId, inAccount } = target;
    if (inAccount) {
      try {
        await deleteRoutebookRemote(remoteId, { profileId: profile.id, editToken: book.editToken || '' });
      } catch (error) {
        setDeleteTarget({ ...target, error: error?.message || NETWORK_ERROR_TEXT });
        return;
      }
      setServerData((current) => ({ ...current, routebooks: current.routebooks.filter((item) => item.publicId !== remoteId) }));
    }
    deleteRoutebook(book);
    setLocalDataVersion((value) => value + 1);
    onLocalBooksChanged?.(book);
  }

  async function handleProfileSave(event) {
    event.preventDefault();
    const next = updateProfile(profile);
    setProfile(next);
    if (!hasProfileCloudRegistrationConsent(next)) {
      setProfileMessage('偏好已保存在本机，未上传到云端');
      onProfileChanged?.(next);
      return;
    }
    setProfileMessage('保存中…');
    try {
      const data = await saveProfile(next);
      const adoption = adoptServerProfile(data.profile, next);
      const saved = adoption.profile;
      setProfile(saved);
      onProfileChanged?.(saved);
      setProfileMessage(adoption.migratedCount ? `已保存偏好，并迁移 ${adoption.migratedCount} 条本机资产到新身份` : '已保存偏好，下一次生成会默认套用');
    } catch (err) {
      setProfileMessage(`已存在这台设备上，云端同步失败：${err.message}`);
    }
  }

  async function prepareSyncCode({ copy = false } = {}) {
    setSyncBusy(true);
    setProfileMessage('正在准备跨设备恢复码…');
    try {
      let activeProfile = profile;
      if (!activeProfile.profileAccessToken) {
        const data = await saveProfile(activeProfile);
        const adoption = adoptServerProfile(data.profile, activeProfile);
        activeProfile = adoption.profile;
        setProfile(activeProfile);
        onProfileChanged?.(activeProfile);
      }
      const issued = await issueRecoveryCode(activeProfile.id);
      const code = issued.recoveryCode;
      setSyncCode(code);
      if (copy) {
        if (!navigator.clipboard?.writeText) throw new Error('浏览器未开放剪贴板权限');
        await navigator.clipboard.writeText(code);
        setProfileMessage('恢复码已复制，请只保存到自己的密码管理器或私密设备');
      } else {
        setProfileMessage('一次性恢复码已生成，有效期 7 天；恢复成功后旧设备凭据会失效');
      }
    } catch (err) {
      setProfileMessage(`恢复码生成失败：${err.message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  async function recoverProfile() {
    setSyncBusy(true);
    setProfileMessage('正在核对恢复码，同步账号…');
    try {
      const credentials = parseProfileSyncCode(recoveryCode);
      const data = await saveProfile({
        id: credentials.profileId,
        profileId: credentials.profileId,
        ...credentials
      });
      const adoption = adoptServerProfile({ ...data.profile, previousLocalId: profile.id }, profile);
      const next = adoption.profile;
      setProfile(next);
      setSyncCode('');
      setRecoveryCode('');
      onProfileChanged?.(next);
      setProfileMessage(`账号已恢复${adoption.migratedCount ? `，并迁移 ${adoption.migratedCount} 条本机资产` : ''}`);
    } catch (err) {
      setProfileMessage(`账号恢复失败：${err.message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  async function exportAccount() {
    setSyncBusy(true);
    try {
      const cloud = profile.profileAccessToken ? (await exportProfileData(profile.id)).export : null;
      const payload = stripLocalExportSecrets({
        exportedAt: new Date().toISOString(),
        cloud,
        local: {
          profile,
          routebooks: localBooks,
          checkins: localCheckins,
          clicks: localClicks,
          favorites: localFavorites,
          tripSessions: listTripSessions(profile.id)
        }
      });
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `路书个人资料-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProfileMessage('个人资料已导出，请妥善保管其中的行程和照片');
    } catch (err) {
      setProfileMessage(`导出失败：${err.message}`);
    } finally {
      setSyncBusy(false);
    }
  }

  async function endAccount(action) {
    const deleting = action === 'delete';
    if (deleting && window.prompt('将永久删除云端账号、路书、打卡、照片及本机副本。建议先导出。请输入 DELETE 确认：') !== 'DELETE') return;
    if (!deleting && !window.confirm('退出后，这台设备上的资料会清掉，云端登录凭据也会作废；要再看云端的路书，需要重新登录。确定退出？')) return;
    setSyncBusy(true);
    let resumeQueue;
    try {
      resumeQueue = await pauseCheckinQueue();
      if (profile.profileAccessToken) {
        if (deleting) await deleteProfileRemote(profile.id, 'DELETE');
        else await logoutProfileRemote(profile.id);
      }
      clearLocalProfileData(profile.id);
      const fresh = resetProfile();
      setProfile(fresh);
      setServerData({ routebooks: [], checkins: [], clicks: [], favorites: [] });
      setSyncCode('');
      setRecoveryCode('');
      setLocalDataVersion((value) => value + 1);
      onProfileChanged?.(fresh);
      onLocalBooksChanged?.();
      setProfileMessage(deleting ? '账号已注销。运营备份中的副本最多保留一个月，之后清除。' : '已退出。');
    } catch (err) {
      setProfileMessage(`${deleting ? '注销' : '退出'}未完成：${err.message}`);
    } finally {
      resumeQueue?.();
      setSyncBusy(false);
    }
  }

  const tabs = [
    { id: 'routebooks', icon: Route, label: '路书', count: books.length },
    { id: 'favorites', icon: Heart, label: '收藏', count: favorites.length },
    { id: 'checkins', icon: Camera, label: '打卡', count: checkins.length },
    { id: 'account', icon: UserRound, label: '账号' }
  ];
  const displayName = profile.creatorName || '旅行者';

  return (
    <div className="page-enter mx-auto max-w-[1200px] px-4 pt-6 pb-16 lg:px-8 lg:pt-10">
      <header className="flex flex-wrap items-center gap-4">
        <span
          className="grid size-16 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#e8553d,#ffc93c)] text-2xl font-black text-white shadow-cta"
          aria-hidden="true"
        >
          {displayName.slice(0, 1)}
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-extrabold tracking-tight lg:text-display-sm">我的</h1>
          <p className="mt-1 max-w-[36em] text-meta leading-relaxed text-muted max-sm:hidden">本机和云端的记录合在一起显示。换设备时用恢复码接着用。</p>
        </div>
        <Button variant="primary" className="max-sm:w-full" onClick={() => onNewBook({})}>
          <Plus /> 新建路书
        </Button>
      </header>
      {error && (
        <p className="mt-4 rounded-tile bg-lemon-soft px-4 py-3 text-sm font-semibold text-lemon-ink" role="status" aria-live="polite" aria-atomic="true">
          云端记录暂时读不到，先显示本机数据。（{error}）
        </p>
      )}

      <Tabs.Root value={activeTab} onValueChange={setActiveTab} className="mt-6">
        <Tabs.List aria-label="我的资产分类" className="grid grid-cols-4 gap-1.5 sm:flex sm:gap-2">
          {tabs.map(({ id, icon: Icon, label, count }) => (
            <Tabs.Trigger
              key={id}
              value={id}
              className="inline-flex h-10 shrink-0 items-center justify-center gap-1 rounded-full whitespace-nowrap border border-line bg-white px-2 text-sm sm:gap-1.5 sm:px-4 font-bold text-ink-2 transition-colors hover:border-line-strong data-[state=active]:border-ink data-[state=active]:bg-ink data-[state=active]:text-white"
            >
              <Icon className="size-4 max-sm:hidden" aria-hidden="true" />
              {label}
              {Number.isFinite(count) && <span className="num rounded-full bg-black/10 px-1.5 text-xs">{count}</span>}
            </Tabs.Trigger>
          ))}
        </Tabs.List>

        <Tabs.Content value="routebooks" className="mt-5 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-labelledby="my-books">
            <h2 id="my-books" className="mb-2 text-title-xs font-extrabold tracking-tight">
              我的路书 <span className="num text-muted">{books.length}</span>
            </h2>
            <p className="mb-3 text-sm text-muted">
              {profile.accountUserId
                ? '登录后生成和保存的路书都存在账号里，换手机、换电脑登录也能看到。'
                : '现在存在这台设备上。登录后，路书会存进账号，换设备也能看到。'}
            </p>
            {books.length ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  {visibleRows('books', books, 8).map((book) => {
                    const bookKey = book.publicId ?? book.id ?? `${book.city}-${book.title}`;
                    return (
                      <RouteCard
                        key={bookKey}
                        routebook={book}
                        meta={routebookCardMeta(book, {
                          extra: [
                            book.city || '城市待补充',
                            publishStatusLabel(book.publishStatus),
                            book.routingWarning?.unverifiedLegs ? `${book.routingWarning.unverifiedLegs} 段路线还没查` : ''
                          ]
                            .filter(Boolean)
                            .join(' · ')
                        })}
                        onOpen={() => onOpenBook(book)}
                        actions={
                          <>
                            <Button size="sm" variant="dark" onClick={() => onOpenBook(book)}>
                              <Route /> 打开
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted hover:text-danger"
                              aria-label={`删除路书 ${book.title || book.city || ''}`}
                              title={profile.accountUserId ? '从账号里删除' : '删除本机存档'}
                              onClick={() => handleDeleteBook(book)}
                            >
                              <Trash2 /> 删除
                            </Button>
                          </>
                        }
                      />
                    );
                  })}
                </div>
                <ShowAllToggle total={books.length} collapsedCount={8} expanded={expandedSections.has('books')} onToggle={() => toggleExpanded('books')} />
              </>
            ) : (
              <Empty
                icon={Route}
                art
                text="还没有路书。贴一段攻略，或者直接选个城市，先排一条路线。"
                action={
                  <Button variant="primary" size="sm" onClick={() => onNewBook({})}>
                    <Plus /> 排一条路线
                  </Button>
                }
              />
            )}
          </section>

          <div className="grid content-start gap-4">
            {(books.length > 0 || creatorBooks.length > 0) && (
              <SidePanel title="我的公开路线" count={creatorBooks.length}>
                {creatorBooks.length ? (
                  <ul className="divide-y divide-line">
                    {visibleRows('creatorBooks', creatorBooks, 8).map((book) => (
                      <li key={`creator-${book.publicId || book.title}`} className="py-2.5">
                        <strong className="line-clamp-1 text-sm font-bold">{book.title || '未命名路书'}</strong>
                        <p className="mt-0.5 text-xs text-muted">
                          {book.city || '城市待补充'} · {publishStatusLabel(book.publishStatus)} · {getRouteTrustBadgeState(book).compactText}
                          {book.routingWarning?.unverifiedLegs ? ` · ${book.routingWarning.unverifiedLegs} 段路线还没查` : ''}
                        </p>
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                          <Copy className="size-3" aria-hidden="true" /> 被复制 {book.copyCount ?? 0} 次 ·{' '}
                          {sourceAuthorizationLabel(book.creator?.sourceAuthorization || book.sourceAuthorization)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <ShowAllToggle
                  total={creatorBooks.length}
                  collapsedCount={8}
                  expanded={expandedSections.has('creatorBooks')}
                  onToggle={() => toggleExpanded('creatorBooks')}
                />
                {creatorBooks.length ? null : <p className="text-sm text-muted">你公开分享的路线会出现在这里。</p>}
              </SidePanel>
            )}
            {/* V-U29: with no routebooks yet, one empty state is enough — 0-count panels fold away. */}
            {(books.length > 0 || sharedBooks.length > 0) && (
              <SidePanel title="我的分享" count={sharedBooks.length}>
                {sharedBooks.length ? (
                  <ul className="divide-y divide-line">
                    {visibleRows('sharedBooks', sharedBooks, 8).map((book) => {
                      const url = book.shareUrl || `/share/${book.publicId}`;
                      return (
                        <li key={`${book.publicId}-${book.title}`} className="flex items-center justify-between gap-2 py-2.5">
                          <span className="min-w-0">
                            <strong className="line-clamp-1 text-sm font-bold">{book.title || '未命名路书'}</strong>
                            <span className="text-xs text-muted">
                              {book.city || '城市待补充'} · {getRouteTrustBadgeState(book).compactText}
                            </span>
                          </span>
                          <a
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-bold text-sky-ink hover:bg-sky-soft"
                          >
                            <ExternalLink className="size-3.5" aria-hidden="true" /> 打开
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <ShowAllToggle
                  total={sharedBooks.length}
                  collapsedCount={8}
                  expanded={expandedSections.has('sharedBooks')}
                  onToggle={() => toggleExpanded('sharedBooks')}
                />
                {sharedBooks.length ? null : <p className="text-sm text-muted">发布或被精选的路书会出现在这里。</p>}
              </SidePanel>
            )}
          </div>
        </Tabs.Content>

        <Tabs.Content value="favorites" className="mt-5">
          <p role="status" aria-live="polite" aria-atomic="true" className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mb-3">
            {favoriteNotice}
          </p>
          {favorites.length ? (
            <>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visibleRows('favorites', favorites, 12).map((item) => (
                  <li key={item.id ?? favoriteKeyOf(item)} className="flex flex-col gap-2 rounded-card border border-line bg-white p-4 shadow-card">
                    <span className="flex items-start gap-2">
                      <Heart className="mt-0.5 size-4 shrink-0 fill-primary text-primary" aria-hidden="true" />
                      <strong className="line-clamp-2 text-copy font-extrabold">{item.routeTitle || item.routeId || '未命名收藏路线'}</strong>
                    </span>
                    <span className="text-xs text-muted">
                      {item.city || '城市待补充'} · 收藏于 {formatHistoryDate(item.createdAt)}
                    </span>
                    <div className="mt-auto flex gap-2 pt-1">
                      <Button
                        size="sm"
                        variant="dark"
                        disabled={!item.routeId}
                        onClick={() =>
                          onOpenBook(books.find((book) => (book.publicId || book.id) === item.routeId) || { id: item.routeId, publicId: item.routeId })
                        }
                      >
                        打开路线
                      </Button>
                      <Button size="sm" variant="ghost" className="text-muted" onClick={() => handleRemoveFavorite(item)}>
                        <Trash2 /> 取消收藏
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
              <ShowAllToggle
                total={favorites.length}
                collapsedCount={12}
                expanded={expandedSections.has('favorites')}
                onToggle={() => toggleExpanded('favorites')}
              />
            </>
          ) : (
            <Empty icon={Heart} text="在路书页点“收藏”，喜欢的路线就会出现在这里。" />
          )}
        </Tabs.Content>

        <Tabs.Content value="checkins" className="mt-5 grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="my-checkins">
            <h2 id="my-checkins" className="mb-3 text-lg font-extrabold">
              我的打卡 <span className="num text-muted">{checkins.length}</span>
            </h2>
            {checkins.length ? (
              <>
                <ul className="grid gap-2.5">
                  {visibleRows('checkins', checkins, 12).map((item, index) => (
                    <li key={`${item.id ?? item.stopName}-${index}`} className="flex gap-3 rounded-card border border-line bg-white p-3.5">
                      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-success-soft text-success-ink">
                        <MapPin className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0">
                        <strong className="text-sm font-bold">{item.stopName || '未命名地点'}</strong>
                        <span className="block text-xs text-muted">
                          {[item.city || '城市待补充', item.worth || '体验未填', item.queue ? `排队 ${item.queue}` : ''].filter(Boolean).join(' · ')}
                        </span>
                        {(item.comment || item.pitfall) && <span className="mt-1 block text-sm text-ink-2">{item.comment || item.pitfall}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
                <ShowAllToggle
                  total={checkins.length}
                  collapsedCount={12}
                  expanded={expandedSections.has('checkins')}
                  onToggle={() => toggleExpanded('checkins')}
                />
              </>
            ) : (
              <Empty icon={Camera} text="出行时在路书里点“我到了”，GPS 和体验反馈会记在这里。" />
            )}
          </section>
          <section aria-labelledby="my-clicks">
            <h2 id="my-clicks" className="mb-3 text-lg font-extrabold">
              最近看过的门票/商品 <span className="num text-muted">{clicks.length}</span>
            </h2>
            {clicks.length ? (
              <>
                <ul className="grid gap-2.5">
                  {visibleRows('clicks', clicks, 12).map((item, index) => (
                    <li key={`${item.productTitle ?? item.title}-${index}`} className="flex items-start gap-3 rounded-card border border-line bg-white p-3.5">
                      <span className="shrink-0 rounded-full bg-sky-soft px-2 py-0.5 text-xs font-bold text-sky-ink">{item.type || '商品'}</span>
                      <span className="min-w-0">
                        <strong className="text-sm font-bold">{item.productTitle || item.title || '未命名商品'}</strong>
                        <span className="block text-xs text-muted">
                          {item.poi || '关联地点待补充'} · {item.provider || '本地记录'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <ShowAllToggle total={clicks.length} collapsedCount={12} expanded={expandedSections.has('clicks')} onToggle={() => toggleExpanded('clicks')} />
              </>
            ) : (
              <Empty icon={Ticket} text="在路书里点过的门票或商品会记在这里。" />
            )}
          </section>
        </Tabs.Content>

        <Tabs.Content value="account" className="mt-5">
          <MyAccountPanel
            profile={profile}
            setProfile={setProfile}
            syncCode={syncCode}
            recoveryCode={recoveryCode}
            setRecoveryCode={setRecoveryCode}
            syncBusy={syncBusy}
            profileMessage={profileMessage}
            onSave={handleProfileSave}
            onPrepareSyncCode={prepareSyncCode}
            onRecover={recoverProfile}
            onExport={exportAccount}
            onLogout={() => endAccount('logout')}
            onDelete={() => endAccount('delete')}
            onOpenCreator={onOpenCreator}
          />
        </Tabs.Content>
      </Tabs.Root>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.error ? '删除失败' : deleteTarget?.inAccount ? '删除路书' : '删除本机存档'}
        description={
          deleteTarget?.error
            ? `没能从账号里删除：${deleteTarget.error}`
            : deleteTarget?.inAccount
              ? `确定删除「${deleteTarget.label}」吗？会从你的账号里删掉，所有设备都看不到了，不能撤销。`
              : `确定删除「${deleteTarget?.label || ''}」的本机存档吗？云端已保存的副本不受影响。`
        }
        confirmLabel={deleteTarget?.error ? '知道了' : '删除'}
        cancelLabel={deleteTarget?.error ? '关闭' : '取消'}
        danger={!deleteTarget?.error}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => (deleteTarget?.error ? setDeleteTarget(null) : confirmDeleteBook())}
      />
    </div>
  );
}

/** @param {Record<string, any>} props */

/** @param {Record<string, any>} props */
function SidePanel({ title, count, children }) {
  return (
    <section className="rounded-panel border border-line bg-white p-4">
      <h2 className="mb-1 flex items-center justify-between text-copy font-extrabold">
        {title} <span className="num rounded-full bg-canvas px-2 text-xs text-muted">{count}</span>
      </h2>
      {children}
    </section>
  );
}

/** @param {Record<string, any>} props */
function Empty({ icon: Icon, text, action, art = false }) {
  const bubble = (
    <span className="grid size-12 place-items-center rounded-full bg-canvas text-muted">
      <Icon className="size-6" aria-hidden="true" />
    </span>
  );
  return (
    <div className="flex flex-col items-center gap-3 rounded-panel border border-dashed border-line-strong bg-white p-8 text-center">
      {art ? <EmptyArt fallback={bubble} /> : bubble}
      <p className="max-w-sm text-sm text-muted">{text}</p>
      {action}
    </div>
  );
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
  return Math.max(0, ...[book?.provider?.editedAt, book?.updatedAt, book?.provider?.generatedAt, book?.createdAt].map((value) => Date.parse(value ?? '') || 0));
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
  return [...map.values()].sort((a, b) => String(b.createdAt ?? b.time ?? b.clickedAt ?? '').localeCompare(String(a.createdAt ?? a.time ?? a.clickedAt ?? '')));
}

function belongsToProfile(item, profileId) {
  if (!profileId) return false;
  return item?.profileId === profileId || item?.creator?.id === profileId;
}

/**
 * F14: lists are no longer capped at the latest 8/12; this toggles the full list.
 * @param {{ total: number, collapsedCount: number, expanded: boolean, onToggle: () => void }} props
 */
function ShowAllToggle({ total, collapsedCount, expanded, onToggle }) {
  if (total <= collapsedCount) return null;
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted">
      {expanded ? `已显示全部 ${total} 条` : `显示最近 ${collapsedCount} 条，共 ${total} 条`}
      <Button size="sm" variant="ghost" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? '收起' : '查看全部'}
      </Button>
    </p>
  );
}
