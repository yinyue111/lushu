import React, { Suspense, useState, useEffect, useCallback, useRef } from 'react';
import { ErrorBoundary, PageLoadingFallback, RouteLoadFallback, StorageNoticeBanner, TripReminderBanner } from './components/Layout/AppFallbacks';
import TopNav from './components/Layout/TopNav';
import HomePage from './components/HomePage';
import { checkHealth, copyRoutebookRemote, getRoutebookRemote, saveProfile, saveRoutebookRemote } from './lib/api';
import { flushAllCheckinQueues } from './lib/checkinQueue';
import { createRouteEditToken, getProfile, profileRoutebookFields } from './lib/profile';
import { adoptServerProfile } from './lib/profileSync';
import { dismissTripReminder, dueTripReminders } from './lib/reminders';
import { getStoredRoutebookById, getStoredRoutebooks, saveRoutebook as persistRoutebook } from './lib/storage';
import { preserveRoutebookConflictDraft } from './lib/routebookConflict';
import { routebookRefreshConflictKey, routebookRefreshDecision, selectLatestLocalRoutebook } from './components/Route/routebookModel';

const VIEWS = {
  home: 'home',
  destination: 'destination',
  builder: 'builder',
  route: 'route',
  trip: 'trip',
  review: 'review',
  ops: 'ops',
  logs: 'logs',
  my: 'my',
  share: 'share',
  creator: 'creator',
  publicReview: 'publicReview',
  privacy: 'privacy'
};
const PUBLIC_VIEWS = new Set([VIEWS.share, VIEWS.publicReview]);
// Crowd data aggregated from other travellers' check-ins: a local snapshot is never
// authoritative for these, so remote always wins. validations/metrics stay out of the
// list on purpose — they are pure functions of stops and must follow the winning stops.
const SERVER_DERIVED_FIELDS = ['feedbackSummary', 'poiTrust', 'trustMeta', 'trustScore', 'copyCount'];
const BuilderFlow = React.lazy(() => import('./components/Builder/BuilderFlow'));
const DestinationPage = React.lazy(() => import('./components/Destination/DestinationPage'));
const RouteView = React.lazy(() => import('./components/Route/RouteView'));
const PublicSharePage = React.lazy(() => import('./components/Route/PublicSharePage'));
const TripView = React.lazy(() => import('./components/Trip/TripView'));
const ReviewPage = React.lazy(() => import('./components/Trip/ReviewPage'));
const PublicReviewPage = React.lazy(() => import('./components/Trip/PublicReviewPage'));
const OpsPage = React.lazy(() => import('./components/Ops/OpsPage'));
const LogsPage = React.lazy(() => import('./components/Ops/LogsPage'));
const MyPage = React.lazy(() => import('./components/My/MyPage'));
const CreatorPage = React.lazy(() => import('./components/Creator/CreatorPage'));
const PrivacyPage = React.lazy(() => import('./components/Legal/PrivacyPage'));

function initialRouteState() {
  const decodePathParam = (value) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return '';
    }
  };
  const shareMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (shareMatch) return { view: VIEWS.share, publicId: decodePathParam(shareMatch[1]) };
  const reviewMatch = window.location.pathname.match(/^\/review\/([^/]+)\/?$/);
  if (reviewMatch) return { view: VIEWS.publicReview, publicId: decodePathParam(reviewMatch[1]) };
  const creatorMatch = window.location.pathname.match(/^\/creator\/([^/]+)\/?$/);
  if (creatorMatch) return { view: VIEWS.creator, publicId: decodePathParam(creatorMatch[1]) };
  const destinationMatch = window.location.pathname.match(/^\/destination\/([^/]+)\/?$/);
  if (destinationMatch) return { view: VIEWS.destination, publicId: '', city: decodePathParam(destinationMatch[1]) || '杭州' };
  const routeMatch = window.location.pathname.match(/^\/route\/([^/]+)\/?$/);
  if (routeMatch) return { view: VIEWS.route, publicId: decodePathParam(routeMatch[1]) };
  const routeReviewMatch = window.location.pathname.match(/^\/route\/([^/]+)\/review\/?$/);
  if (routeReviewMatch) return { view: VIEWS.review, publicId: decodePathParam(routeReviewMatch[1]) };
  const tripMatch = window.location.pathname.match(/^\/trip\/([^/]+)\/?$/);
  if (tripMatch) return { view: VIEWS.trip, publicId: decodePathParam(tripMatch[1]) };
  const directView = window.location.pathname.replace(/^\/+|\/+$/g, '');
  if ([VIEWS.ops, VIEWS.logs, VIEWS.my, VIEWS.builder, VIEWS.privacy].includes(directView)) {
    return { view: directView, publicId: '' };
  }
  return { view: VIEWS.home, publicId: '', city: '' };
}

export default function App() {
  const initial = initialRouteState();
  const [view, setView] = useState(initial.view);
  const [sharePublicId, setSharePublicId] = useState(initial.publicId);
  const [modelHealth, setModelHealth] = useState(null);
  const [routebook, setRoutebook] = useState(null);
  const [routeLoadState, setRouteLoadState] = useState({ loading: false, error: '' });
  const [routeRetryNonce, setRouteRetryNonce] = useState(0);
  const [profile, setProfile] = useState(() => getProfile());
  const [savedBooks, setSavedBooks] = useState(() => getStoredRoutebooks(profile.id));
  const [builderDefaults, setBuilderDefaults] = useState({});
  const [destinationCity, setDestinationCity] = useState(initial.city || '杭州');
  const [creatorId, setCreatorId] = useState(initial.view === VIEWS.creator ? initial.publicId : '');
  const [dueReminder, setDueReminder] = useState(null);
  const [storageNotice, setStorageNotice] = useState('');
  const [routebookRefreshNotice, setRoutebookRefreshNotice] = useState('');
  const routebookRef = useRef(null);
  const profileRef = useRef(profile);
  const routebookRefreshConflictsRef = useRef(new Set());

  useEffect(() => {
    routebookRef.current = routebook;
  }, [routebook]);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    const ctrl = new AbortController();
    checkHealth(ctrl.signal)
      .then(setModelHealth)
      .catch(() => setModelHealth({ ok: false, ready: false }));
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    // rank7①：挂载与网络恢复时补传离线打卡队列；flush 幂等、离线自动跳过，失败保持静默。
    const flushQueues = () => {
      try {
        if (typeof flushAllCheckinQueues !== 'function') return;
        Promise.resolve(flushAllCheckinQueues({ profile: getProfile() }))
          .then(() => {
            // flush 内可能触发后台注册迁移（profile id 换新）：与当前状态不一致时
            // 刷新 profile 与本机存档，避免首页存档暂时清空。
            const latest = getProfile();
            if (latest?.id && latest.id !== profileRef.current?.id) handleProfileChanged(latest);
          })
          .catch(() => {});
      } catch {
        // 补传失败保持静默，队列会在下一次上线或打开打卡页时重试。
      }
    };
    flushQueues();
    window.addEventListener('online', flushQueues);
    return () => window.removeEventListener('online', flushQueues);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- register the online listener once; profile changes are read through profileRef.
  }, []);

  useEffect(() => {
    // rank25④：仅在切回首页/我的页时全量重读本机路书，编辑过程中走轻量就地替换。
    if (view === VIEWS.home || view === VIEWS.my) setSavedBooks(getStoredRoutebooks(profile.id));
  }, [profile.id, view]);

  useEffect(() => {
    if (PUBLIC_VIEWS.has(view)) return;
    const due = dueTripReminders(savedBooks)[0];
    setDueReminder(due ?? null);
  }, [savedBooks, view]);

  const replaceSavedBook = useCallback(
    (book) => {
      // rank25④：已有存档就地替换，避免每次保存都全量重读 localStorage；
      // 新增的自有路书才触发一次全量重读，浏览他人路线不进「我的路书」。
      if (!book?.city || !Array.isArray(book.stops) || !book.stops.length) return;
      const bookId = book.publicId || book.id;
      if (!bookId) return;
      setSavedBooks((prev) => {
        const index = prev.findIndex((item) => (item.publicId || item.id) === bookId);
        if (index >= 0) {
          const next = [...prev];
          next[index] = book;
          return next;
        }
        const owned = book.profileId === profile.id || book.creator?.id === profile.id;
        return owned ? getStoredRoutebooks(profile.id) : prev;
      });
    },
    [profile.id]
  );

  useEffect(() => {
    const routeId = sharePublicId;
    if (![VIEWS.route, VIEWS.trip, VIEWS.review].includes(view) || !routeId) return undefined;
    const cached = getStoredRoutebookById(routeId);
    // rank6：浏览他人路线时不落库，路书只存在内存里；只要 id 匹配就继续展示，别清成 null。
    const inMemory = routebookRef.current && (routebookRef.current.publicId || routebookRef.current.id) === routeId ? routebookRef.current : null;
    const fallbackBook = cached ?? inMemory;
    setRoutebook(fallbackBook ?? null);
    if (fallbackBook) {
      setRouteLoadState({ loading: false, error: '' });
    }
    setRoutebookRefreshNotice('');
    const ctrl = new AbortController();
    setRouteLoadState({ loading: !fallbackBook, error: '' });
    getRoutebookRemote(routeId, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        // 不使用请求发起时的 cached：用户可能在 GET 等待期间已经保存了编辑。
        // localStorage 失败时再用 routebookRef 兜底，避免回调拿旧快照覆盖内存状态。
        const latestCached = getStoredRoutebookById(routeId);
        const latestInMemory = routebookRef.current && (routebookRef.current.publicId || routebookRef.current.id) === routeId ? routebookRef.current : null;
        const latestLocal = selectLatestLocalRoutebook([latestCached, latestInMemory, cached], profile.id, routeId);
        const refreshDecision = routebookRefreshDecision(data.routebook, latestLocal, profile.id);
        if (refreshDecision.preserveLocal) {
          const conflictKey = routebookRefreshConflictKey(data.routebook, latestLocal);
          const firstSeen = !routebookRefreshConflictsRef.current.has(conflictKey);
          if (firstSeen) {
            routebookRefreshConflictsRef.current.add(conflictKey);
            const localSnapshot = preserveRoutebookConflictDraft(latestLocal, '自动刷新发现本机编辑分叉');
            const remoteSnapshot = preserveRoutebookConflictDraft(
              { ...data.routebook, ...profileRoutebookFields(profile) },
              `自动刷新发现云端版本${refreshDecision.remoteVersion ?? '更新'}`
            );
            if (localSnapshot.saved && localSnapshot.draft) replaceSavedBook(localSnapshot.draft);
            if (remoteSnapshot.saved && remoteSnapshot.draft) replaceSavedBook(remoteSnapshot.draft);
          }
          // 当前页面继续显示本机编辑；原路书不写回远端响应，两个副本在「我的」可恢复。
          setRoutebook(latestLocal);
          replaceSavedBook(latestLocal);
          setRoutebookRefreshNotice(
            '检测到云端版本与本机未同步编辑分叉，当前仍保留本机编辑；本机副本和云端快照已保存到「我的路书」，请选择要继续的版本后再保存。'
          );
          setRouteLoadState({ loading: false, error: '' });
          return;
        }
        const next = mergeRemoteRoutebook(data.routebook, latestLocal ?? latestCached ?? cached, profile.id);
        setRoutebook(next);
        // rank6：浏览他人路线只展示不落库（内存路书兜底展示）；与 handleOpenBook 同一守卫：
        // 本人的书或本地已有同 id 存档的才写回本机缓存。
        const ownedByProfile = next?.profileId === profile.id || next?.creator?.id === profile.id;
        if (ownedByProfile || Boolean(latestCached ?? cached)) {
          persistRoutebook(next);
          replaceSavedBook(next);
        }
        setRouteLoadState({ loading: false, error: '' });
      })
      .catch((error) => {
        if (ctrl.signal.aborted) return;
        if (fallbackBook) {
          setRouteLoadState({
            loading: false,
            error: cached && [403, 404].includes(error.status) ? '服务端暂无这份草稿，已保留本地版本；重新保存或发布后会同步。' : ''
          });
          return;
        }
        setRoutebook(null);
        setRouteLoadState({ loading: false, error: routeLoadErrorMessage(error) });
      });
    return () => ctrl.abort();
  }, [profile, replaceSavedBook, routeRetryNonce, sharePublicId, view]);

  const retryRouteLoad = useCallback(() => setRouteRetryNonce((value) => value + 1), []);

  const navigate = useCallback((nextView, options = {}) => {
    setView(nextView);
    if (!PUBLIC_VIEWS.has(nextView)) setSharePublicId('');
    if (options.city) setDestinationCity(options.city);
    if (options.creatorId) setCreatorId(options.creatorId);
    if (options.routeId) setSharePublicId(options.routeId);
    if (options.replacePath !== false && !PUBLIC_VIEWS.has(nextView)) {
      const nextPath = publicPathForView(nextView, options);
      if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
    }
    // F21: in-app navigation starts the next page at the top (back/forward keeps the browser's restoration).
    if (options.preserveScroll !== true && typeof window.scrollTo === 'function') window.scrollTo(0, 0);
  }, []);

  const handleGenerated = useCallback(
    (book) => {
      setRoutebook(book);
      const saved = persistRoutebook(book, { claimOwnership: true });
      setStorageNotice(saved ? '' : '本地存储已满：这份路书暂未写入本机存档，已尝试清理最旧路书仍失败，请删除不需要的路书后重新保存。');
      setSavedBooks(getStoredRoutebooks(profile.id));
      navigate(VIEWS.route, { routeId: book.publicId || book.id });
    },
    [navigate, profile.id]
  );

  const handleOpenBook = useCallback(
    (book) => {
      const routeId = book?.publicId || book?.id;
      if (!routeId) return;
      const completeBook = Array.isArray(book?.stops) && book.stops.length > 0 ? book : null;
      setRoutebook(completeBook);
      if (completeBook) {
        // rank6：浏览他人路线只展示不落库，避免污染「我的路书」；本地已有同 id 存档的照旧更新。
        const ownedByProfile = completeBook.profileId === profile.id || completeBook.creator?.id === profile.id;
        const storedLocally = Boolean(getStoredRoutebookById(routeId));
        if (ownedByProfile || storedLocally) {
          persistRoutebook(completeBook);
          replaceSavedBook(completeBook);
        }
      }
      navigate(VIEWS.route, { routeId });
    },
    [navigate, profile.id, replaceSavedBook]
  );

  const handleNewBook = useCallback(
    (defaults = {}) => {
      setBuilderDefaults(defaults);
      navigate(VIEWS.builder);
    },
    [navigate]
  );

  const handleOpenDestination = useCallback(
    (city) => {
      navigate(VIEWS.destination, { city: city || '杭州' });
    },
    [navigate]
  );

  const handleProfileChanged = useCallback((nextProfile) => {
    const next = nextProfile ?? getProfile();
    setProfile(next);
    setSavedBooks(getStoredRoutebooks(next.id));
  }, []);

  const handleLocalBooksChanged = useCallback(
    (removedBook) => {
      // My 页删除本机存档后就地移除该书，让 TripReminderBanner 等派生状态立即失效；
      // 拿不到 id 时兜底全量重读。
      const removedId = removedBook?.publicId || removedBook?.id;
      if (!removedId) {
        setSavedBooks(getStoredRoutebooks(profile.id));
        return;
      }
      setSavedBooks((prev) => prev.filter((item) => (item.publicId || item.id) !== removedId));
    },
    [profile.id]
  );

  const handleCustomize = useCallback(
    async (book, meta = {}) => {
      const sourceBook = book;
      const routeId = book?.publicId || book?.id;
      if (routeId && meta.recordCopy !== false) {
        try {
          const profile = getProfile();
          await copyRoutebookRemote(routeId, {
            profileId: profile.id,
            surface: meta.surface || 'customize',
            routeTitle: book?.title,
            city: book?.city,
            creatorId: book?.creator?.id
          });
        } catch {
          /* customization remains available when attribution sync fails */
        }
      }
      setBuilderDefaults({
        city: sourceBook?.city,
        duration: sourceBook?.days?.length ? `${sourceBook.days.length} 天` : '2 天 1 晚',
        theme: sourceBook?.assets?.map((asset) => asset.label).slice(0, 3) ?? [],
        guide: [sourceBook?.title, sourceBook?.summary, ...(sourceBook?.stops ?? []).map((stop) => `${stop.time} ${stop.name} ${stop.verify ?? ''}`)]
          .filter(Boolean)
          .join('\n')
      });
      navigate(VIEWS.builder);
    },
    [navigate]
  );

  const handleSaveSharedRoutebook = useCallback(
    async (book, meta = {}) => {
      let activeProfile = getProfile();
      let draft = createPrivateRoutebookDraft(book, activeProfile);
      if (!persistRoutebook(draft, { claimOwnership: true })) {
        throw new Error('浏览器本地存储已满或不可用，暂时无法保存这份路书');
      }

      setRoutebook(draft);
      setSavedBooks(getStoredRoutebooks(activeProfile.id));
      if (meta.startTrip) {
        navigate(VIEWS.trip, { routeId: draft.id });
      }

      let profileSyncError = null;
      try {
        const profileData = await saveProfile(activeProfile);
        activeProfile = adoptServerProfile(profileData.profile, activeProfile).profile;
        draft = { ...draft, ...profileRoutebookFields(activeProfile) };
        persistRoutebook(draft, { claimOwnership: true });
        setProfile(activeProfile);
        setRoutebook(draft);
        setSavedBooks(getStoredRoutebooks(activeProfile.id));
      } catch (error) {
        profileSyncError = error;
      }

      const attributionPromise = recordSharedRoutebookCopy(book, activeProfile, meta.surface)
        .then(() => null)
        .catch((error) => error);
      let savedDraft = draft;
      let syncError = null;
      if (activeProfile.profileAccessToken || !profileSyncError) {
        try {
          const data = await saveRoutebookRemote(draft);
          savedDraft = normalizeSavedPrivateDraft(data.routebook, draft, activeProfile);
          persistRoutebook(savedDraft, { claimOwnership: true });
          setRoutebook(savedDraft);
          setSavedBooks(getStoredRoutebooks(activeProfile.id));
        } catch (error) {
          syncError = error;
        }
      } else {
        syncError = profileSyncError;
      }
      const attributionError = await attributionPromise;
      return {
        routebook: savedDraft,
        synced: !syncError,
        syncError: syncError?.message || '',
        attributionSynced: !attributionError
      };
    },
    [navigate]
  );

  const handleUseSharedRoutebook = useCallback(
    (book, meta = {}) => {
      const savedDraft = meta.savedRoutebook;
      if (savedDraft?.id || savedDraft?.publicId) {
        const activeProfile = getProfile();
        setRoutebook(savedDraft);
        persistRoutebook(savedDraft, { claimOwnership: true });
        setSavedBooks(getStoredRoutebooks(activeProfile.id));
        navigate(VIEWS.trip, { routeId: savedDraft.publicId || savedDraft.id });
        return Promise.resolve({ routebook: savedDraft, synced: meta.synced !== false });
      }
      return handleSaveSharedRoutebook(book, { ...meta, startTrip: true });
    },
    [handleSaveSharedRoutebook, navigate]
  );

  const handleRouteViewSaved = useCallback(
    (book) => {
      // RouteView 保存回调携带最新 book 时就地替换，仅在拿不到 book 时才全量重读。
      if (book && (book.publicId || book.id)) replaceSavedBook(book);
      else setSavedBooks(getStoredRoutebooks(profile.id));
    },
    [profile.id, replaceSavedBook]
  );

  const handleStartTrip = useCallback(
    () => navigate(VIEWS.trip, { routeId: routebook?.publicId || routebook?.id }),
    [navigate, routebook?.id, routebook?.publicId]
  );
  const handleShowReview = useCallback(
    () => navigate(VIEWS.review, { routeId: routebook?.publicId || routebook?.id }),
    [navigate, routebook?.id, routebook?.publicId]
  );
  const handleBack = useCallback(() => {
    navigate(VIEWS.home);
  }, [navigate]);

  useEffect(() => {
    const onPopState = () => {
      const next = initialRouteState();
      setSharePublicId(next.publicId);
      setCreatorId(next.view === VIEWS.creator ? next.publicId : '');
      if (next.city) setDestinationCity(next.city);
      setView(next.view);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const activeRouteId = routebook?.publicId || routebook?.id || '';
  const routebookMatchesLocation = Boolean(routebook && sharePublicId && activeRouteId === sharePublicId);

  const navHidden = PUBLIC_VIEWS.has(view) || view === VIEWS.trip;
  const showTabBar = !navHidden && view !== VIEWS.route;

  return (
    <div className={`app-root view-${view}`}>
      <TopNav view={view} onNavigate={navigate} modelHealth={modelHealth} hidden={navHidden} />
      <main className={`app-main ${showTabBar ? 'max-md:pb-[calc(56px+env(safe-area-inset-bottom))]' : ''}`}>
        {dueReminder && !PUBLIC_VIEWS.has(view) && (
          <TripReminderBanner
            reminder={dueReminder}
            onOpen={() => {
              const book = dueReminder.routebook || getStoredRoutebookById(dueReminder.routeId);
              if (book) {
                setRoutebook(book);
                navigate(VIEWS.trip, { routeId: book.publicId || book.id });
              }
              dismissTripReminder(dueReminder.routeId);
              setDueReminder(null);
            }}
            onDismiss={() => {
              dismissTripReminder(dueReminder.routeId);
              setDueReminder(null);
            }}
          />
        )}
        {storageNotice && !PUBLIC_VIEWS.has(view) && <StorageNoticeBanner text={storageNotice} onDismiss={() => setStorageNotice('')} />}
        {routebookRefreshNotice && !PUBLIC_VIEWS.has(view) && (
          <StorageNoticeBanner text={routebookRefreshNotice} onDismiss={() => setRoutebookRefreshNotice('')} />
        )}
        <ErrorBoundary onReset={() => navigate(VIEWS.home)}>
          <Suspense fallback={<PageLoadingFallback />}>
            {view === VIEWS.home && (
              <HomePage
                books={savedBooks}
                onNewBook={handleNewBook}
                onOpenBook={handleOpenBook}
                onOpenDestination={handleOpenDestination}
                onRefresh={() => setSavedBooks(getStoredRoutebooks(profile.id))}
              />
            )}
            {view === VIEWS.destination && (
              <DestinationPage
                city={destinationCity}
                onBack={handleBack}
                onOpenBook={handleOpenBook}
                onNewBook={handleNewBook}
                onOpenDestination={handleOpenDestination}
              />
            )}
            {view === VIEWS.builder && (
              <BuilderFlow
                modelHealth={modelHealth}
                defaults={builderDefaults}
                onGenerated={handleGenerated}
                onProfileChanged={handleProfileChanged}
                onModelHealth={setModelHealth}
                onBack={handleBack}
              />
            )}
            {view === VIEWS.route && routebookMatchesLocation && (
              <RouteView
                routebook={routebook}
                setRoutebook={setRoutebook}
                onSaved={handleRouteViewSaved}
                onCustomize={handleCustomize}
                onStartTrip={handleStartTrip}
                onBack={handleBack}
              />
            )}
            {view === VIEWS.route && !routebookMatchesLocation && <RouteLoadFallback state={routeLoadState} onBack={handleBack} onRetry={retryRouteLoad} />}
            {view === VIEWS.share && sharePublicId && (
              <PublicSharePage
                publicId={sharePublicId}
                onBack={handleBack}
                onSave={handleSaveSharedRoutebook}
                onUse={handleUseSharedRoutebook}
                onCustomize={handleCustomize}
                onOpenCreator={(id) => navigate(VIEWS.creator, { creatorId: id })}
              />
            )}
            {view === VIEWS.publicReview && sharePublicId && <PublicReviewPage publicId={sharePublicId} onBack={handleBack} />}
            {view === VIEWS.trip && routebookMatchesLocation && (
              <TripView
                key={activeRouteId}
                routebook={routebook}
                onBack={() => navigate(VIEWS.route, { routeId: routebook.publicId || routebook.id })}
                onReview={handleShowReview}
              />
            )}
            {view === VIEWS.trip && !routebookMatchesLocation && <RouteLoadFallback state={routeLoadState} onBack={handleBack} onRetry={retryRouteLoad} />}
            {view === VIEWS.review && routebookMatchesLocation && (
              <ReviewPage routebook={routebook} onBack={() => navigate(VIEWS.route, { routeId: routebook.publicId || routebook.id })} />
            )}
            {view === VIEWS.review && !routebookMatchesLocation && <RouteLoadFallback state={routeLoadState} onBack={handleBack} onRetry={retryRouteLoad} />}
            {view === VIEWS.ops && <OpsPage />}
            {view === VIEWS.my && (
              <MyPage
                onOpenBook={handleOpenBook}
                onNewBook={handleNewBook}
                onOpenCreator={(id) => navigate(VIEWS.creator, { creatorId: id })}
                onProfileChanged={handleProfileChanged}
                onLocalBooksChanged={handleLocalBooksChanged}
              />
            )}
            {view === VIEWS.creator && creatorId && (
              <CreatorPage
                creatorId={creatorId}
                onBack={handleBack}
                onOpenBook={handleOpenBook}
                onCustomize={(book) => handleCustomize(book, { surface: 'creator-profile' })}
              />
            )}
            {view === VIEWS.logs && <LogsPage routebook={routebook} modelHealth={modelHealth} />}
            {view === VIEWS.privacy && <PrivacyPage onBack={() => navigate(VIEWS.home)} />}
          </Suspense>
        </ErrorBoundary>
      </main>
    </div>
  );
}

function mergeRemoteRoutebook(remote, local, profileId) {
  if (!remote || !local) return remote;
  const remoteId = remote.publicId || remote.id;
  const localId = local.publicId || local.id;
  const localOwned = local.profileId === profileId || local.creator?.id === profileId;
  const localEditToken = validEditToken(local.editToken);
  if (remoteId !== localId || !localOwned) return remote;
  const remoteVersion = routebookVersion(remote);
  const localVersion = routebookVersion(local);
  const localIsNewer =
    remoteVersion != null
      ? localVersion != null && (localVersion > remoteVersion || (localVersion === remoteVersion && routebookTimestamp(local) > routebookTimestamp(remote)))
      : localVersion != null || routebookTimestamp(local) > routebookTimestamp(remote);
  const merged = localIsNewer ? mergeLocalRoutebookEdits(remote, local) : remote;
  return validEditToken(merged.editToken) || !localEditToken ? merged : { ...merged, editToken: localEditToken };
}

function mergeLocalRoutebookEdits(remote, local) {
  const stops = Array.isArray(local.stops) ? local.stops : remote.stops;
  const variants = Array.isArray(local.variants) ? local.variants : remote.variants;
  return {
    ...remote,
    ...local,
    ...serverDerivedRoutebookFields(remote),
    stops: applyRemoteStopTrust(stops, remote.stops),
    variants: applyRemoteVariantTrust(variants, remote.variants),
    provider: { ...(remote.provider ?? {}), ...(local.provider ?? {}) }
  };
}

function serverDerivedRoutebookFields(remote) {
  return Object.fromEntries(SERVER_DERIVED_FIELDS.map((field) => [field, remote?.[field]]));
}

function applyRemoteStopTrust(stops, remoteStops) {
  if (!Array.isArray(stops) || !Array.isArray(remoteStops)) return stops;
  const byId = new Map();
  const byName = new Map();
  for (const stop of remoteStops) {
    const id = stopMatchKey(stop?.id);
    const name = stopMatchKey(stop?.name);
    if (id && !byId.has(id)) byId.set(id, stop);
    if (name && !byName.has(name)) byName.set(name, stop);
  }
  return stops.map((stop) => {
    const matched = byId.get(stopMatchKey(stop?.id)) ?? byName.get(stopMatchKey(stop?.name));
    return matched ? { ...stop, poiTrust: matched.poiTrust } : stop;
  });
}

function applyRemoteVariantTrust(variants, remoteVariants) {
  if (!Array.isArray(variants) || !Array.isArray(remoteVariants)) return variants;
  return variants.map((variant) => {
    const variantId = stopMatchKey(variant?.id);
    const matched = variantId ? remoteVariants.find((item) => stopMatchKey(item?.id) === variantId) : null;
    return matched ? { ...variant, stops: applyRemoteStopTrust(variant.stops, matched.stops) } : variant;
  });
}

function stopMatchKey(value) {
  return String(value ?? '').trim();
}

function createPrivateRoutebookDraft(source, profile) {
  const {
    id: _sourceId,
    publicId: _sourcePublicId,
    shareUrl: _sourceShareUrl,
    editToken: _sourceEditToken,
    profileId: _sourceProfileId,
    creator: _sourceCreator,
    publishStatus: _sourcePublishStatus,
    schemaVersion: _sourceSchemaVersion,
    version: _sourceVersion,
    parentVersion: _sourceParentVersion,
    changeReason: _sourceChangeReason,
    actorType: _sourceActorType,
    publishedAt: _sourcePublishedAt,
    archivedAt: _sourceArchivedAt,
    copyCount: _sourceCopyCount,
    feedbackSummary: _sourceFeedbackSummary,
    trustMeta: _sourceTrustMeta,
    ...routebook
  } = source ?? {};
  const now = new Date().toISOString();
  return {
    ...routebook,
    id: createPrivateRoutebookId(),
    stops: stripLivePoiTrust(routebook.stops),
    variants: Array.isArray(routebook.variants) ? routebook.variants.map((variant) => ({ ...variant, stops: stripLivePoiTrust(variant?.stops) })) : [],
    ...profileRoutebookFields(profile),
    editToken: createRouteEditToken(),
    schemaVersion: 2,
    version: 0,
    parentVersion: null,
    changeReason: '复制为个人草稿',
    actorType: 'user',
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0,
    provider: {
      ...(routebook.provider ?? {}),
      generatedAt: now,
      copiedAt: now
    },
    updatedAt: now
  };
}

function normalizeSavedPrivateDraft(remote, local, profile) {
  const { shareUrl: _shareUrl, ...saved } = remote ?? {};
  return {
    ...local,
    ...saved,
    ...profileRoutebookFields(profile),
    editToken: saved.editToken || local.editToken,
    publishStatus: 'draft',
    sourceAuthorization: 'user-generated',
    copyCount: 0
  };
}

function stripLivePoiTrust(stops) {
  if (!Array.isArray(stops)) return [];
  return stops.map(({ poiTrust: _poiTrust, ...stop }) => stop);
}

function createPrivateRoutebookId() {
  const uuid = globalThis.crypto?.randomUUID?.().replace(/-/g, '');
  return uuid ? `route_${uuid}` : `route_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

async function recordSharedRoutebookCopy(routebook, profile, surface = 'public-share-save') {
  const routeId = routebook?.publicId || routebook?.id;
  if (!routeId) return;
  await copyRoutebookRemote(routeId, {
    profileId: profile.id,
    surface: surface || 'public-share-save',
    routeTitle: routebook?.title,
    city: routebook?.city,
    creatorId: routebook?.creator?.id
  });
}

function validEditToken(value) {
  const token = String(value ?? '').trim();
  return token && token.length <= 96 && /^[A-Za-z0-9_-]+$/.test(token) ? token : '';
}

function routebookTimestamp(book) {
  return Math.max(0, ...[book?.provider?.editedAt, book?.updatedAt, book?.provider?.generatedAt, book?.createdAt].map((value) => Date.parse(value ?? '') || 0));
}

function routebookVersion(book) {
  const value = Number(book?.version ?? book?.currentVersion ?? book?.revision);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function publicPathForView(view, options = {}) {
  if ([VIEWS.ops, VIEWS.logs, VIEWS.my, VIEWS.builder, VIEWS.privacy].includes(view)) return `/${view}`;
  if (view === VIEWS.destination) return `/destination/${encodeURIComponent(options.city || '杭州')}`;
  if (view === VIEWS.creator) return `/creator/${encodeURIComponent(options.creatorId || '')}`;
  if (view === VIEWS.route && options.routeId) return `/route/${encodeURIComponent(options.routeId)}`;
  if (view === VIEWS.review && options.routeId) return `/route/${encodeURIComponent(options.routeId)}/review`;
  if (view === VIEWS.trip && options.routeId) return `/trip/${encodeURIComponent(options.routeId)}`;
  return '/';
}

function routeLoadErrorMessage(error) {
  const status = Number(error?.status) || 0;
  if (status === 404) return '路书不存在或已被删除，请确认链接是否正确。';
  if (status === 403) return '没有权限查看这份路书，可能作者尚未公开。';
  if (status) return `路书加载失败（HTTP ${status}）：${error?.message || '服务端暂时不可用'}`;
  return '网络连接失败，请检查网络后重试。';
}
