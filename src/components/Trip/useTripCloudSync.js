import { useCallback, useEffect, useRef, useState } from 'react';
import { getTripSessionRemote, saveTripSessionRemote } from '../../lib/tripApi.js';
import { readTripSession, restoreTripSession, tripRoutebookId } from '../../lib/tripSession.js';
import { tripSyncErrorMessage } from '../../lib/tripSyncMessages.js';

// Execution plans are private owner data. CAS prevents two devices from silently
// replacing each other's reordered/alternative stops; conflicts require a choice.
export function useTripCloudSync(routebook, profile, onRestore) {
  const routeId = tripRoutebookId(routebook);
  const contextRef = useRef({ routebook, profile, onRestore });
  contextRef.current = { routebook, profile, onRestore };
  const controllerRef = useRef(null);
  const readyRef = useRef(false);
  const conflictRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const [state, setState] = useState({ status: 'local', message: '行中计划保存在本机' });
  const [refresh, setRefresh] = useState(0);

  const sync = useCallback(() => {
    const controller = controllerRef.current;
    if (!readyRef.current || !controller || controller.signal.aborted || conflictRef.current || navigator.onLine === false) return;
    const context = contextRef.current;
    if (!context.profile.profileAccessToken) return;
    chainRef.current = chainRef.current
      .catch(() => {})
      .then(async () => {
        if (controller.signal.aborted || conflictRef.current) return;
        const local = readTripSession(context.routebook, context.profile.id);
        if (!local?.pendingSync) return;
        const sentVersion = local.localRevision;
        setState({ status: 'syncing', message: '正在同步行中计划' });
        try {
          const data = await saveTripSessionRemote(routeId, context.profile.id, { ...local, expectedRevision: local.cloudRevision || 0 }, controller.signal);
          if (controller.signal.aborted) return;
          const latest = readTripSession(context.routebook, context.profile.id);
          const unchanged = latest?.localRevision === sentVersion;
          restoreTripSession(context.routebook, context.profile.id, {
            ...latest,
            cloudRevision: data.session.revision,
            pendingSync: !unchanged,
            ...(unchanged ? { updatedAt: data.session.updatedAt } : {})
          });
          setState({ status: 'synced', message: '行中计划已同步，可在其他设备继续' });
        } catch (error) {
          if (controller.signal.aborted) return;
          if (error.code === 'TRIP_SESSION_CONFLICT') {
            conflictRef.current = { revision: error.currentVersion };
            setState({ status: 'conflict', message: '另一台设备更新了行中计划；本机修改已保留，请选择使用哪一份' });
          } else setState({ status: 'error', message: tripSyncErrorMessage(error) });
        }
      });
  }, [routeId]);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    readyRef.current = false;
    conflictRef.current = null;
    if (!profile.profileAccessToken) {
      setState({ status: 'local', message: '行中计划保存在本机；开启云端同步后可跨设备继续' });
      return () => controller.abort();
    }
    const context = contextRef.current;
    setState({ status: 'loading', message: '正在检查云端行中计划' });
    getTripSessionRemote(routeId, profile.id, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const remote = data.session;
        const local = readTripSession(context.routebook, profile.id);
        readyRef.current = true;
        if (remote && local?.pendingSync && (local.cloudRevision || 0) !== remote.revision) {
          conflictRef.current = remote;
          setState({ status: 'conflict', message: '云端与本机都有变更，请选择要继续的行中计划' });
          return;
        }
        if (remote && !local?.pendingSync) {
          const restored = { ...remote, cloudRevision: remote.revision, pendingSync: false };
          restoreTripSession(context.routebook, profile.id, restored);
          context.onRestore(restored);
          setState({ status: 'synced', message: '已恢复云端行中计划' });
        } else if (local?.pendingSync) sync();
        else setState({ status: 'synced', message: '继续行程后将自动同步执行计划' });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ status: 'error', message: tripSyncErrorMessage(error) });
      });
    const reconnect = () => setRefresh((value) => value + 1);
    window.addEventListener('online', reconnect);
    return () => {
      controller.abort();
      window.removeEventListener('online', reconnect);
    };
  }, [profile.id, profile.profileAccessToken, routeId, refresh, sync]);

  async function resolveConflict(useCloud) {
    const context = contextRef.current;
    const controller = controllerRef.current;
    if (!window.confirm(useCloud ? '加载云端行中计划会替换本机执行顺序，打卡记录不受影响。确认？' : '用本机执行顺序更新云端行中计划，确认？')) return;
    try {
      const data = await getTripSessionRemote(routeId, profile.id, controller.signal);
      const remote = data.session;
      if (useCloud && remote) {
        const restored = { ...remote, cloudRevision: remote.revision, pendingSync: false };
        restoreTripSession(context.routebook, profile.id, restored);
        context.onRestore(restored);
        conflictRef.current = null;
        setState({ status: 'synced', message: '已加载云端行中计划' });
      } else {
        const local = readTripSession(context.routebook, profile.id);
        if (!local) return;
        restoreTripSession(context.routebook, profile.id, { ...local, cloudRevision: remote?.revision || 0, pendingSync: true });
        conflictRef.current = null;
        readyRef.current = true;
        sync();
      }
    } catch (error) {
      if (!controller.signal.aborted) setState({ status: 'conflict', message: `暂时无法处理冲突：${error.message}` });
    }
  }

  return { state, sync, retry: () => setRefresh((value) => value + 1), resolveConflict };
}
