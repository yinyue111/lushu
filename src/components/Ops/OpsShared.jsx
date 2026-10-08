import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';

export function useOpsResource(loader, { enabled = true, isEmpty = defaultIsEmpty, dependencies = [] } = {}) {
  const loaderRef = useRef(loader);
  const emptyRef = useRef(isEmpty);
  const [retryKey, setRetryKey] = useState(0);
  const [resource, setResource] = useState({
    status: enabled ? 'loading' : 'idle',
    data: null,
    error: null,
    updatedAt: null
  });

  loaderRef.current = loader;
  emptyRef.current = isEmpty;
  const dependencyKey = JSON.stringify(dependencies);

  useEffect(() => {
    if (!enabled) {
      setResource((previous) => ({ ...previous, status: 'idle', error: null }));
      return undefined;
    }
    const controller = new AbortController();
    setResource((previous) => ({
      ...previous,
      status: previous.data == null ? 'loading' : 'refreshing',
      error: null
    }));
    Promise.resolve(loaderRef.current(controller.signal))
      .then((data) => {
        if (controller.signal.aborted) return;
        setResource({
          status: emptyRef.current(data) ? 'empty' : 'ready',
          data,
          error: null,
          updatedAt: new Date().toISOString()
        });
      })
      .catch((error) => {
        if (controller.signal.aborted || error?.name === 'AbortError') return;
        setResource((previous) => ({ ...previous, status: 'error', error, updatedAt: previous.updatedAt }));
      });
    return () => controller.abort();
  }, [dependencyKey, enabled, retryKey]);

  const retry = useCallback(() => setRetryKey((value) => value + 1), []);
  const replaceData = useCallback((updater) => {
    setResource((previous) => {
      const data = typeof updater === 'function' ? updater(previous.data) : updater;
      return {
        status: emptyRef.current(data) ? 'empty' : 'ready',
        data,
        error: null,
        updatedAt: new Date().toISOString()
      };
    });
  }, []);

  return { ...resource, retry, replaceData };
}

export function ResourceNotice({ resource, label, loadingLabel = '正在读取数据' }) {
  if (resource.status === 'loading') {
    return (
      <div className="ops-resource-state" role="status">
        <LoaderCircle className="ops-spin" size={16} />
        <span>{loadingLabel}</span>
      </div>
    );
  }
  if (resource.status === 'refreshing') {
    return (
      <div className="ops-resource-state is-refreshing" role="status">
        <LoaderCircle className="ops-spin" size={14} />
        <span>{label}刷新中，仍显示上次数据</span>
      </div>
    );
  }
  if (resource.status !== 'error') return null;
  return (
    <div className="ops-resource-state is-error" role="alert">
      <AlertCircle size={16} />
      <span>{label}读取失败：{formatApiError(resource.error)}</span>
      <button className="btn btn-secondary btn-sm" type="button" onClick={resource.retry}>
        <RefreshCw size={13} /> 重试
      </button>
    </div>
  );
}

export function EmptyState({ children }) {
  return <div className="ops-empty-state">{children}</div>;
}

export function formatApiError(error) {
  const message = error?.message || '请求失败';
  return error?.requestId ? `${message}（请求 ${error.requestId}）` : message;
}

export function formatOpsDate(value, fallback = '—') {
  const timestamp = Date.parse(value ?? '');
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : fallback;
}

export function numberValue(value, suffix = '') {
  return hasValue(value) && Number.isFinite(Number(value)) ? `${Number(value)}${suffix}` : '—';
}

export function textValue(value) {
  return hasValue(value) ? String(value) : '—';
}

export function firstValue(...values) {
  return values.find(hasValue);
}

export function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function defaultIsEmpty(data) {
  return Array.isArray(data) && data.length === 0;
}
