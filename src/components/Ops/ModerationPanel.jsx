import { useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';
import { Dialog, DialogContent } from '../ui/dialog';
import { getOpsModeration, saveOpsModerationDecision } from '../../lib/opsApi';
import { EmptyState, ResourceNotice, formatApiError, formatOpsDate, useOpsResource } from './OpsShared';

const STATUS_FILTERS = [
  ['open', '待处理'],
  ['approved', '已放行'],
  ['rejected', '已驳回'],
  ['all', '全部']
];
const STATUS_LABELS = { pending: '待复核', blocked: '预拦截', approved: '已放行', rejected: '已驳回', passed: '复检通过' };
const ENTITY_LABELS = { checkin: '打卡文字', routebook: '发布路书' };
const CATEGORY_LABELS = { 'contact-phone': '手机号', 'contact-im': '站外联系方式', 'external-link': '外链', keyword: '关键词' };

// 内容审核队列：预过滤或境内内容安全服务标记的公开内容，在人工放行前不公开展示。
export default function ModerationPanel() {
  const [status, setStatus] = useState('open');
  const [selected, setSelected] = useState(null);
  const resource = useOpsResource((signal) => getOpsModeration(status, signal), {
    dependencies: [status],
    isEmpty: (data) => !data?.items?.length
  });
  const items = resource.data?.items ?? [];
  const listReady = ['ready', 'empty', 'refreshing'].includes(resource.status);

  return (
    <div className="ops-workspace-stack">
      <section className="ops-panel" aria-labelledby="moderation-title">
        <div className="ops-panel-head">
          <div>
            <h2 id="moderation-title">内容审核</h2>
            <p className="text-caption">
              当前审核方式：
              {resource.data?.provider === 'domestic'
                ? `境内内容安全服务${resource.data.domesticConfigured ? '' : '（未配置，全部转人工）'}`
                : '本地关键词预过滤'}
              。被标记的打卡文字与路书在放行前不公开。
            </p>
          </div>
          <span className="badge badge-orange">
            <ShieldAlert size={12} /> {resource.data ? `${items.length} 条` : '—'}
          </span>
        </div>
        <div className="ops-filter-bar" aria-label="审核筛选">
          <label>
            <span>状态</span>
            <select className="input-field" value={status} onChange={(event) => setStatus(event.target.value)}>
              {STATUS_FILTERS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" type="button" onClick={resource.retry} disabled={resource.status === 'loading'}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
        <ResourceNotice resource={resource} label="审核队列" />
        {items.length ? (
          <div className="ops-table-scroll" tabIndex={0} role="region" aria-label="审核队列，可横向滚动">
            <table className="ops-data-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>对象</th>
                  <th>命中</th>
                  <th>内容摘录</th>
                  <th>状态</th>
                  <th>处置</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={`${item.entityType}:${item.entityId}`}>
                    <td>{formatOpsDate(item.createdAt)}</td>
                    <td>
                      <strong>{ENTITY_LABELS[item.entityType] ?? item.entityType}</strong>
                      <small>{item.entityId}</small>
                    </td>
                    <td>
                      {[...new Set((item.hits ?? []).map((hit) => CATEGORY_LABELS[hit.category] ?? hit.category))].join('、') ||
                        (item.labels ?? []).join('、') ||
                        '—'}
                    </td>
                    <td className="max-w-[320px]">
                      {Object.entries(item.excerpt ?? {})
                        .filter(([, value]) => value)
                        .map(([key, value]) => `${key}: ${value}`)
                        .join(' / ')
                        .slice(0, 160) || '—'}
                    </td>
                    <td>
                      <span className={`badge ${item.status === 'approved' ? 'badge-green' : 'badge-orange'}`}>
                        {STATUS_LABELS[item.status] ?? item.status}
                      </span>
                    </td>
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelected(item)}>
                        处置
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : listReady ? (
          <EmptyState>当前筛选下没有审核记录。</EmptyState>
        ) : null}
      </section>
      {selected && <ModerationDialog item={selected} onClose={() => setSelected(null)} onSaved={resource.retry} />}
    </div>
  );
}

function ModerationDialog({ item, onClose, onSaved }) {
  const [action, setAction] = useState('approve');
  const [reason, setReason] = useState('');
  const [state, setState] = useState({ saving: false, error: null });
  async function save(event) {
    event.preventDefault();
    setState({ saving: true, error: null });
    try {
      await saveOpsModerationDecision(item.entityType, item.entityId, { action, reason: reason.trim() });
      onSaved();
      onClose();
    } catch (error) {
      setState({ saving: false, error });
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.saving) onClose();
      }}
    >
      <DialogContent title="内容审核处置" description={`${ENTITY_LABELS[item.entityType] ?? item.entityType} · ${item.entityId}`} hideClose={state.saving}>
        <form className="space-y-4" onSubmit={save}>
          <label className="block">
            <span className="input-label">处置</span>
            <select className="input-field" value={action} disabled={state.saving} onChange={(event) => setAction(event.target.value)}>
              <option value="approve">放行（公开展示）</option>
              <option value="reject">驳回（不公开）</option>
            </select>
          </label>
          <label className="block">
            <span className="input-label">原因（至少 8 个字符）</span>
            <textarea
              className="input-field"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
              minLength={8}
              maxLength={500}
              disabled={state.saving}
            />
          </label>
          {state.error && (
            <p role="alert" className="ops-error-text">
              {formatApiError(state.error)}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={state.saving}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={state.saving || reason.trim().length < 8}>
              {state.saving ? '提交中…' : '记录处置'}
            </button>
          </div>
        </form>
        {item.history?.length > 1 && (
          <section className="mt-5 border-t border-line pt-4" aria-label="审核历史">
            <h3 className="font-bold">审核历史</h3>
            <ol className="mt-2 space-y-2 text-sm">
              {item.history.map((row) => (
                <li key={row.id}>
                  {row.type === 'moderation-item' ? `标记为${STATUS_LABELS[row.status] ?? row.status}` : row.action === 'approve' ? '放行' : '驳回'} ·{' '}
                  {formatOpsDate(row.createdAt)}
                  {row.reason ? ` · ${row.reason} · ${row.actor}` : ''}
                </li>
              ))}
            </ol>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}
