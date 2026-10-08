import { useMemo, useState } from 'react';
import { Check, Filter, MessageSquareText, RotateCcw, X } from 'lucide-react';
import { getPoiCorrections, updatePoiCorrectionStatus } from '../../lib/api';
import { EmptyState, ResourceNotice, formatApiError, formatOpsDate, textValue, useOpsResource } from './OpsShared';

export default function ReviewQueuePanel() {
  const correctionsResource = useOpsResource((signal) => getPoiCorrections(200, signal));
  const [filters, setFilters] = useState({ city: '', status: 'pending' });
  const [notes, setNotes] = useState({});
  const [rowStates, setRowStates] = useState({});
  const [panelNotice, setPanelNotice] = useState('');
  const corrections = normalizeCorrections(correctionsResource.data);
  const cities = useMemo(() => [...new Set(corrections.map((item) => item.city).filter(Boolean))].sort(), [corrections]);
  const visibleRows = corrections.filter((item) => (!filters.city || item.city === filters.city) && (!filters.status || item.status === filters.status));

  async function review(item, action) {
    const id = item.id;
    if (!id || rowStates[id]?.status === 'loading') return;
    const reviewerNote = String(notes[id] ?? '').trim();
    if (action === 'rejected' && !reviewerNote) {
      setRowStates((previous) => ({ ...previous, [id]: { status: 'error', error: new Error('驳回时请填写审核备注') } }));
      return;
    }
    setRowStates((previous) => ({ ...previous, [id]: { status: 'loading', error: null } }));
    setPanelNotice('');
    try {
      const data = await updatePoiCorrectionStatus(id, action, reviewerNote);
      correctionsResource.replaceData((previous) => replaceCorrection(previous, data.correction));
      setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null } }));
      setPanelNotice(`「${item.stopName || id}」纠错${action === 'approved' ? '已通过' : '已驳回'}；若当前筛选未显示该记录，可切换“审核状态”筛选查看。`);
    } catch (error) {
      setRowStates((previous) => ({ ...previous, [id]: { status: 'error', error } }));
      setPanelNotice(`「${item.stopName || id}」审核操作失败：${formatApiError(error)}`);
    }
  }

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="review-queue-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="review-queue-title">用户纠错审核</h2>
            <p className="text-caption">逐条核对当前值、建议值与提交依据；通过后进入纠错知识记录，不等同于规范化 POI 内容核验</p>
          </div>
          <span className="badge badge-orange">{correctionsResource.data ? `${visibleRows.length} 条` : '—'}</span>
        </div>
        <div className="ops-filter-bar" aria-label="审核队列筛选">
          <Filter size={15} aria-hidden="true" />
          <label>
            <span>城市</span>
            <select className="input-field" value={filters.city} onChange={(event) => setFilters((previous) => ({ ...previous, city: event.target.value }))}>
              <option value="">全部城市</option>
              {cities.map((city) => (
                <option key={city} value={city}>
                  {city}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>审核状态</span>
            <select
              className="input-field"
              value={filters.status}
              onChange={(event) => setFilters((previous) => ({ ...previous, status: event.target.value }))}
            >
              <option value="">全部状态</option>
              <option value="pending">待审核</option>
              <option value="approved">已通过</option>
              <option value="rejected">已驳回</option>
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={correctionsResource.retry}>
            <RotateCcw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={correctionsResource} label="审核队列" />
        <p className="text-caption ops-live-message" role="status" aria-live="polite" aria-atomic="true">
          {panelNotice}
        </p>
        {visibleRows.length ? (
          <div className="ops-review-list">
            {visibleRows.map((item) => {
              const state = rowStates[item.id] ?? { status: 'idle', error: null };
              const isPending = item.status === 'pending';
              return (
                <article key={item.id} className="ops-review-row">
                  <div className="ops-review-heading">
                    <div>
                      <strong>{textValue(item.stopName)}</strong>
                      <span>
                        {textValue(item.city)} · {textValue(item.field)} · {formatOpsDate(item.createdAt)}
                      </span>
                    </div>
                    <ReviewStatus value={item.status} />
                  </div>
                  <div className="ops-review-comparison">
                    <div>
                      <span>当前值</span>
                      <p>{textValue(item.currentValue)}</p>
                    </div>
                    <div>
                      <span>建议值</span>
                      <p>{textValue(item.suggestedValue)}</p>
                    </div>
                    <div>
                      <span>提交依据</span>
                      <p>{textValue(item.reason)}</p>
                    </div>
                  </div>
                  <label className="ops-review-note">
                    <span className="input-label">
                      <MessageSquareText size={13} /> 审核备注
                    </span>
                    <input
                      className="input-field"
                      value={notes[item.id] ?? item.reviewerNote ?? ''}
                      onChange={(event) => setNotes((previous) => ({ ...previous, [item.id]: event.target.value }))}
                      placeholder={isPending ? '填写通过依据；驳回时必填' : '该记录已完成审核'}
                      disabled={!isPending || state.status === 'loading'}
                    />
                  </label>
                  {isPending && (
                    <div className="ops-inline-actions">
                      <button className="btn btn-secondary btn-sm" type="button" onClick={() => review(item, 'rejected')} disabled={state.status === 'loading'}>
                        <X size={13} /> 驳回
                      </button>
                      <button className="btn btn-primary btn-sm" type="button" onClick={() => review(item, 'approved')} disabled={state.status === 'loading'}>
                        <Check size={13} /> {state.status === 'loading' ? '提交中...' : '通过纠错'}
                      </button>
                    </div>
                  )}
                  {state.status === 'error' && (
                    <div className="ops-live-message">
                      <span className="ops-error-text">操作失败：{formatApiError(state.error)}</span>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : correctionsResource.status === 'ready' || correctionsResource.status === 'empty' ? (
          <EmptyState>当前筛选条件下没有审核记录。</EmptyState>
        ) : null}
      </section>
    </div>
  );
}

function normalizeCorrections(data) {
  const rows = data?.corrections ?? data?.items ?? [];
  return Array.isArray(rows) ? rows.map((item) => ({ ...item, status: item.status || item.reviewStatus || 'pending' })) : [];
}

function replaceCorrection(data, correction) {
  if (!correction) return data;
  const rows = normalizeCorrections(data).map((item) => (item.id === correction.id ? correction : item));
  if (Array.isArray(data)) return rows;
  return { ...(data ?? {}), corrections: rows };
}

function ReviewStatus({ value }) {
  const presentation = {
    pending: ['待审核', 'badge-orange'],
    approved: ['已通过', 'badge-green'],
    rejected: ['已驳回', 'badge-red']
  }[value] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}
