import { useMemo, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Filter, MessageSquareText, RotateCcw, X } from 'lucide-react';
import { adminHeaders, getJson, updatePoiCorrectionStatus } from '../lib/legacyApi';
import { EmptyState, ResourceNotice, formatApiError, formatOpsDate, textValue, useOpsResource } from './OpsShared';

const PAGE_SIZE = 50;

export default function ReviewQueuePanel() {
  const [filters, setFilters] = useState({ city: '', status: 'pending' });
  const [cursorStack, setCursorStack] = useState(['']);
  const [notes, setNotes] = useState({});
  const [rowStates, setRowStates] = useState({});
  const [panelNotice, setPanelNotice] = useState('');
  const pageCursor = cursorStack.at(-1) || '';
  const correctionsResource = useOpsResource((signal) => getReviewQueue({ ...filters, cursor: pageCursor }, signal), {
    dependencies: [filters.city, filters.status, pageCursor],
    isEmpty: (data) => normalizeCorrections(data).length === 0
  });
  const queue = correctionsResource.data ?? {};
  const corrections = normalizeCorrections(correctionsResource.data);
  const cities = useMemo(
    () => (Array.isArray(queue.cities) ? queue.cities : [...new Set(corrections.map((item) => item.city).filter(Boolean))]).sort(),
    [corrections, queue.cities]
  );
  const visibleRows = corrections;

  function updateFilter(name, value) {
    setFilters((previous) => ({ ...previous, [name]: value }));
    setCursorStack(['']);
  }

  function goNextPage() {
    if (!queue.nextCursor) return;
    setCursorStack((previous) => [...previous, queue.nextCursor]);
  }

  function goPreviousPage() {
    setCursorStack((previous) => (previous.length > 1 ? previous.slice(0, -1) : previous));
  }

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
      await updatePoiCorrectionStatus(id, action, reviewerNote);
      setRowStates((previous) => ({ ...previous, [id]: { status: 'ready', error: null } }));
      setPanelNotice(`「${item.stopName || id}」纠错${action === 'approved' ? '已通过' : '已驳回'}；队列正在刷新。`);
      correctionsResource.retry();
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
          <span className="badge badge-orange">
            {correctionsResource.data ? `${Number.isFinite(Number(queue.total)) ? queue.total : visibleRows.length} 条` : '—'}
          </span>
        </div>
        <div className="ops-filter-bar" aria-label="审核队列筛选">
          <Filter size={15} aria-hidden="true" />
          <label>
            <span>城市</span>
            <select className="input-field" value={filters.city} onChange={(event) => updateFilter('city', event.target.value)}>
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
            <select className="input-field" value={filters.status} onChange={(event) => updateFilter('status', event.target.value)}>
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
        {correctionsResource.data && (
          <div className="ops-inline-actions mt-3 justify-between">
            <span className="text-caption">
              第 {cursorStack.length} 页 · 当前 {visibleRows.length} 条 / 共 {Number.isFinite(Number(queue.total)) ? queue.total : '—'} 条
            </span>
            <div className="ops-inline-actions">
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={goPreviousPage}
                disabled={cursorStack.length <= 1 || correctionsResource.status === 'refreshing'}
              >
                <ChevronLeft size={13} /> 上一页
              </button>
              <button
                className="btn btn-secondary btn-sm"
                type="button"
                onClick={goNextPage}
                disabled={!queue.nextCursor || correctionsResource.status === 'refreshing'}
              >
                下一页 <ChevronRight size={13} />
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function normalizeCorrections(data) {
  const rows = data?.corrections ?? data?.items ?? [];
  return Array.isArray(rows) ? rows.map((item) => ({ ...item, status: item.status || item.reviewStatus || 'pending' })) : [];
}

function getReviewQueue({ city = '', status = '', cursor = '' } = {}, signal) {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (city) params.set('city', city);
  if (status) params.set('status', status);
  if (cursor) params.set('cursor', cursor);
  return getJson(`/ops/review-queue?${params.toString()}`, signal, adminHeaders());
}

function ReviewStatus({ value }) {
  const presentation = {
    pending: ['待审核', 'badge-orange'],
    approved: ['已通过', 'badge-green'],
    rejected: ['已驳回', 'badge-red']
  }[value] ?? ['未知', 'badge-blue'];
  return <span className={`badge ${presentation[1]}`}>{presentation[0]}</span>;
}
