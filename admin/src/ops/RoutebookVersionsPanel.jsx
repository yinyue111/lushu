import React, { useEffect, useMemo, useState } from 'react';
import { BookOpenCheck, Code2, History, RefreshCw } from 'lucide-react';
import { curatedRoutes } from '../../../src/lib/content';
import { getRoutebookVersions, getRoutebooks, updateRoutebookStatus } from '../lib/legacyApi';
import { EmptyState, ResourceNotice, firstValue, formatApiError, formatOpsDate, hasValue, textValue, useOpsResource } from './OpsShared';
import { sourceAuthorizationLabel } from '../../../src/components/ui/labels';
import { askUnpublishNote, submitRoutebookStatusWithRoutingGate, unpublishNeedsNote } from './routebookPublication';
import { recheckRoutebookRouting } from '../lib/routingApi';
import OpsPager, { nextCursorStack, previousCursorStack } from './OpsPager';

const ROUTE_STATUSES = [
  ['draft', '草稿'],
  ['pending_review', '待审核'],
  ['published', '已发布'],
  ['featured', '精选'],
  ['archived', '已归档']
];

const PAGE_SIZE = 50;

export default function RoutebookVersionsPanel() {
  const [cursorStack, setCursorStack] = useState(['']);
  const pageCursor = cursorStack.at(-1) || '';
  // F17: server-side keyset paging instead of a fixed latest-120 window.
  const routebooksResource = useOpsResource((signal) => getRoutebooks(PAGE_SIZE, signal, pageCursor), { dependencies: [pageCursor] });
  const persistedRoutes = normalizeRoutebooks(routebooksResource.data);
  const builtInRoutes = useMemo(() => curatedRoutes.map((route) => ({ ...route, publishStatus: 'featured', builtIn: true })), []);
  const [selectedId, setSelectedId] = useState('');
  const [rowStates, setRowStates] = useState({});
  const selectedRoute = persistedRoutes.find((route) => routeId(route) === selectedId) ?? null;
  const versionsResource = useOpsResource((signal) => getRoutebookVersions(selectedId, signal), {
    enabled: Boolean(selectedId),
    dependencies: [selectedId],
    isEmpty: (data) => normalizeTimeline(data).length === 0
  });
  const versions = normalizeTimeline(versionsResource.data);

  useEffect(() => {
    if (selectedId && !persistedRoutes.some((route) => routeId(route) === selectedId)) setSelectedId('');
  }, [persistedRoutes, selectedId]);

  async function changeStatus(routebook, publishStatus) {
    const id = routeId(routebook);
    if (!id || routebook.builtIn || publishStatus === routebook.publishStatus) return;
    if (publishStatus === 'archived' && !window.confirm(`确认归档“${routebook.title || '这条路书'}”？归档后将从公开访问中移除。`)) {
      setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null, message: '已取消归档。' } }));
      return;
    }
    let opsNote = '';
    if (unpublishNeedsNote(routebook.publishStatus, publishStatus)) {
      const answer = askUnpublishNote(routebook);
      if (!('opsNote' in answer)) {
        const message = 'invalid' in answer ? '运营备注至少需要 4 个字，路书保持公开。' : '已取消下线，路书保持公开。';
        setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null, message } }));
        return;
      }
      opsNote = answer.opsNote;
    }
    setRowStates((previous) => ({ ...previous, [id]: { status: 'loading', error: null, message: '' } }));
    try {
      let version = firstValue(routebook.version, routebook.currentVersion, routebook.revision);
      if (!hasValue(version)) {
        const versionData = await getRoutebookVersions(id);
        version = versionData?.currentVersion;
      }
      const result = await submitRoutebookStatusWithRoutingGate({
        publicId: id,
        routebookTitle: routebook.title,
        request: updateRoutebookStatus,
        payload: {
          publishStatus,
          sourceAuthorization: routebook.sourceAuthorization || routebook.creator?.sourceAuthorization || 'user-generated',
          creator: routebook.creator,
          ...(opsNote ? { opsNote } : {}),
          ...(hasValue(version) ? { expectedVersion: Number(version) } : {})
        }
      });
      if (result.cancelled) {
        setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null, message: '已取消例外发布，路书状态保持不变。' } }));
        return;
      }
      const data = result.data;
      routebooksResource.replaceData((previous) => replaceRoutebook(previous, data.routebook));
      setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null, message: `已更新为${statusLabel(data.routebook?.publishStatus)}` } }));
      if (selectedId === id) versionsResource.retry();
    } catch (error) {
      if (error?.status === 409 && ['VERSION_CONFLICT', 'ROUTEBOOK_VERSION_CONFLICT', 'EXPECTED_VERSION_REQUIRED'].includes(error?.code)) {
        routebooksResource.retry();
        if (selectedId === id) versionsResource.retry();
      }
      setRowStates((previous) => ({
        ...previous,
        [id]: {
          status: 'error',
          error,
          message:
            error?.status === 409 && ['VERSION_CONFLICT', 'ROUTEBOOK_VERSION_CONFLICT', 'EXPECTED_VERSION_REQUIRED'].includes(error?.code)
              ? '版本已变化，已刷新后请重试。'
              : ''
        }
      }));
    }
  }

  async function recheckRouting(routebook) {
    const id = routeId(routebook);
    setRowStates((previous) => ({ ...previous, [id]: { status: 'loading', error: null, message: '' } }));
    try {
      const data = await recheckRoutebookRouting(id, routebook.version);
      routebooksResource.replaceData((previous) => replaceRoutebook(previous, data.routebook));
      const verified = data.routebook?.routeLegs?.filter((leg) => leg.status === 'verified').length ?? 0;
      const count = data.routebook?.routeLegs?.length ?? 0;
      setRowStates((previous) => ({
        ...previous,
        [id]: {
          status: 'ready',
          error: null,
          message: data.routebook?.routingWarning
            ? `道路核验完成：${verified}/${count} 段已核验。路书保持公开，已向作者和运营标记“道路待复核”；如需下线请手动改状态并填写备注。`
            : `道路核验完成：${verified}/${count} 段已核验；未核验段不会显示精确道路耗时。`
        }
      }));
      if (selectedId === id) versionsResource.retry();
    } catch (error) {
      setRowStates((previous) => ({ ...previous, [id]: { status: 'error', error, message: '' } }));
    }
  }

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="routebook-management-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="routebook-management-title">路书与发布状态</h2>
            <p className="text-caption">持久化路线可变更状态，代码内置路线保持只读</p>
          </div>
          <button className="btn btn-secondary btn-sm" type="button" onClick={routebooksResource.retry}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={routebooksResource} label="持久化路书" />
        <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="可横向滚动的数据表">
          <table className="ops-data-table ops-route-table">
            <thead>
              <tr>
                <th>城市</th>
                <th>路线</th>
                <th>版本</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>审计</th>
              </tr>
            </thead>
            <tbody>
              {persistedRoutes.map((routebook) => {
                const id = routeId(routebook);
                const state = rowStates[id] ?? { status: 'idle', error: null, message: '' };
                return (
                  <React.Fragment key={id}>
                    <tr className={selectedId === id ? 'is-selected' : ''}>
                      <td>{textValue(routebook.city)}</td>
                      <td>
                        <strong>{textValue(routebook.title)}</strong>
                        <small>
                          {routebook.creator?.name || '用户路书'} · {sourceAuthorizationLabel(routebook.sourceAuthorization)}
                        </small>
                      </td>
                      <td>{formatVersion(routebook, selectedId === id ? versionsResource.data?.currentVersion : null)}</td>
                      <td>
                        <label>
                          <select
                            aria-label={`${routebook.title} 发布状态`}
                            className="input-field ops-status-select"
                            value={routebook.publishStatus || 'draft'}
                            onChange={(event) => changeStatus(routebook, event.target.value)}
                            disabled={state.status === 'loading'}
                          >
                            {ROUTE_STATUSES.map(([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        {routebook.routingWarning?.unverifiedLegs > 0 && (
                          <span className="badge badge-orange ops-routing-warning" title={routebook.routingWarning.message}>
                            {routebook.routingWarning.unverifiedLegs}/{routebook.routingWarning.expectedLegs} 段道路待复核
                          </span>
                        )}
                      </td>
                      <td>{formatOpsDate(routebook.updatedAt)}</td>
                      <td>
                        <button className="btn btn-secondary btn-sm" type="button" onClick={() => setSelectedId(id)} aria-pressed={selectedId === id}>
                          <History size={13} /> 版本
                        </button>
                        <button
                          className="btn btn-secondary btn-sm"
                          type="button"
                          onClick={() => recheckRouting(routebook)}
                          disabled={state.status === 'loading'}
                        >
                          核验道路
                        </button>
                      </td>
                    </tr>
                    {(state.status === 'error' || state.message) && (
                      <tr className="ops-table-message-row">
                        <td colSpan={6} role="status" aria-live="polite">
                          {state.status === 'error' && (
                            <span className="ops-error-text">{state.message || `状态更新失败：${formatApiError(state.error)}`}</span>
                          )}
                          {state.status === 'ready' && state.message}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
              {builtInRoutes.map((routebook) => (
                <tr key={`built-in-${routebook.id}`}>
                  <td>{routebook.city}</td>
                  <td>
                    <strong>{routebook.title}</strong>
                    <small>
                      <Code2 size={11} /> 代码内置 · 只读
                    </small>
                  </td>
                  <td>内置</td>
                  <td>
                    <span className="badge badge-green">精选</span>
                  </td>
                  <td>—</td>
                  <td>
                    <span className="badge badge-blue">只读</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {routebooksResource.data && (cursorStack.length > 1 || routebooksResource.data.nextCursor) && (
          <OpsPager
            page={cursorStack.length}
            count={persistedRoutes.length}
            canPrevious={cursorStack.length > 1}
            canNext={Boolean(routebooksResource.data.nextCursor)}
            busy={routebooksResource.status === 'refreshing'}
            onPrevious={() => setCursorStack(previousCursorStack)}
            onNext={() => setCursorStack((stack) => nextCursorStack(stack, routebooksResource.data?.nextCursor))}
          />
        )}
        {!persistedRoutes.length && (routebooksResource.status === 'ready' || routebooksResource.status === 'empty') && (
          <p className="ops-definition-note">暂无持久化路书；上表仅展示代码内置路线，不提供会失败的状态操作。</p>
        )}
      </section>

      <section className="ops-panel" aria-labelledby="routebook-history-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="routebook-history-title">版本与审计时间线</h2>
            <p className="text-caption">{selectedRoute ? `${selectedRoute.city} · ${selectedRoute.title}` : '选择一条持久化路线查看历史'}</p>
          </div>
          {selectedRoute && (
            <span className="badge badge-blue">
              <BookOpenCheck size={12} /> {formatVersion(selectedRoute, versionsResource.data?.currentVersion)}
            </span>
          )}
        </div>
        {!selectedId ? (
          <EmptyState>从上方持久化路线中选择“版本”。</EmptyState>
        ) : (
          <>
            <ResourceNotice resource={versionsResource} label="路书版本" />
            {versions.length ? (
              <ol className="ops-version-timeline">
                {versions.map((version, index) => (
                  <li key={version.id || `${version.version}-${version.createdAt}-${index}`}>
                    <span className="ops-version-marker" aria-hidden="true" />
                    <div>
                      <div className="ops-version-heading">
                        <strong>{versionLabel(version, versions.length - index)}</strong>
                        <span className="badge badge-blue">
                          {eventLabel(version.eventType || version.event || version.action || version.type || version.publishStatus)}
                        </span>
                      </div>
                      <p>{changeSummary(version)}</p>
                      {version.routingPublication?.overridden && (
                        <p>
                          道路例外发布：{version.routingPublication.reason}（核验 {version.routingPublication.routing?.verifiedLegs ?? 0}/
                          {version.routingPublication.routing?.expectedLegs ?? 0} 段）
                        </p>
                      )}
                      <small>
                        {actorLabel(version.actor || version.createdBy || version.reviewer || version.actorType)} ·{' '}
                        {formatOpsDate(firstValue(version.eventAt, version.updatedAt, version.createdAt, version.recordedAt))}
                      </small>
                    </div>
                  </li>
                ))}
              </ol>
            ) : versionsResource.status === 'ready' || versionsResource.status === 'empty' ? (
              <EmptyState>这条路书暂无可展示的版本记录。</EmptyState>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

function normalizeRoutebooks(data) {
  const rows = data?.routebooks ?? data?.items ?? [];
  return Array.isArray(rows) ? rows.filter((item) => item && routeId(item)).map((item) => ({ ...item, builtIn: false })) : [];
}

function normalizeVersions(data) {
  const rows = data?.versions ?? data?.history ?? data?.items ?? [];
  return Array.isArray(rows) ? rows : [];
}

function normalizeTimeline(data) {
  const versions = normalizeVersions(data);
  const audits = Array.isArray(data?.audits) ? data.audits : [];
  const auditsByVersion = new Map();
  audits.forEach((audit) => {
    const version = firstValue(audit?.version, audit?.revision, audit?.sequence);
    if (!hasValue(version)) return;
    const matches = auditsByVersion.get(String(version)) ?? [];
    matches.push(audit);
    auditsByVersion.set(String(version), matches);
  });
  const usedAuditIds = new Set();
  const versionRows = versions.map((version) => {
    const versionValue = firstValue(version?.version, version?.revision, version?.sequence);
    const audit = hasValue(versionValue) ? auditsByVersion.get(String(versionValue))?.at(-1) : null;
    if (audit) usedAuditIds.add(audit.id || audit);
    return audit ? { ...version, eventType: audit.event, eventAt: audit.createdAt, auditId: audit.id } : version;
  });
  const unmatchedAudits = audits
    .filter((audit) => !usedAuditIds.has(audit.id || audit))
    .map((audit) => ({ ...audit, eventType: audit.event, eventAt: audit.createdAt }));
  return [...versionRows, ...unmatchedAudits].sort((left, right) => timelineTimestamp(right) - timelineTimestamp(left));
}

function timelineTimestamp(item) {
  const timestamp = Date.parse(firstValue(item?.eventAt, item?.updatedAt, item?.createdAt, item?.recordedAt) ?? '');
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function replaceRoutebook(data, routebook) {
  if (!routebook) return data;
  const rows = normalizeRoutebooks(data).map((item) => (routeId(item) === routeId(routebook) ? routebook : item));
  if (Array.isArray(data)) return rows;
  return { ...(data ?? {}), routebooks: rows };
}

function routeId(routebook) {
  return routebook?.publicId || routebook?.id || '';
}

function formatVersion(routebook, fallbackVersion = null) {
  const value = firstValue(routebook?.version, routebook?.currentVersion, routebook?.revision, fallbackVersion);
  return hasValue(value) ? `v${value}` : '—';
}

function versionLabel(version, fallback) {
  const value = firstValue(version?.version, version?.revision, version?.sequence);
  return hasValue(value) ? `版本 v${value}` : `历史记录 ${fallback}`;
}

function statusLabel(value) {
  return Object.fromEntries(ROUTE_STATUSES)[value] || value || '未知状态';
}

function eventLabel(value) {
  return (
    {
      create: '创建',
      created: '创建',
      save: '保存',
      update: '更新',
      status: '状态变更',
      'status-changed': '状态变更',
      status_changed: '状态变更',
      publish: '发布',
      archive: '归档',
      draft: '草稿',
      published: '已发布',
      featured: '精选',
      archived: '已归档'
    }[value] ||
    value ||
    '变更'
  );
}

function actorLabel(actor) {
  if (typeof actor === 'string') return actor || '系统';
  return actor?.name || actor?.id || actor?.type || '系统';
}

function changeSummary(version) {
  const summary = firstValue(version?.changeReason, version?.changeSummary, version?.summary, version?.reason, version?.opsNote);
  if (hasValue(summary)) return String(summary);
  if (Array.isArray(version?.changes))
    return (
      version.changes
        .map((item) => (typeof item === 'string' ? item : item.field || item.path))
        .filter(Boolean)
        .join('、') || '记录已更新'
    );
  if (version?.changes && typeof version.changes === 'object') return Object.keys(version.changes).join('、') || '记录已更新';
  return '记录已更新';
}
