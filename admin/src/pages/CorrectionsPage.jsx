import { CLAIM, METHOD, term } from '../terms';
import { useState } from 'react';
import { can } from '../../../server/admin/permissions.mjs';
import { adminGet, adminPost, query } from '../api';
import { Button, Card, Field, Notice, Page, ReasonAction, formatTime, inputClass, useLoad } from '../ui';

const STATUS = { open: '待处理', resolved: '已处理', rejected: '已驳回', '': '全部' };
const FIELD = { price: '门票', hours: '开放时间' };
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

export default function CorrectionsPage({ admin }) {
  const [filters, setFilters] = useState({ status: 'open', city: '', field: '' });
  const { data, error, loading, reload } = useLoad(() => adminGet(`/corrections${query(filters)}`), [filters.status, filters.city, filters.field]);
  const set = (key) => (event) => setFilters((f) => ({ ...f, [key]: event.target.value }));
  const items = data?.items ?? [];
  return (
    <Page title="纠错队列" description="用户报错和联网核对结果。设为人工核实必须附来源链接和查询日期；不确定就改回「待确认」。">
      <Card title="筛选">
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="状态">
            {(id) => (
              <select id={id} className={inputClass} value={filters.status} onChange={set('status')}>
                {Object.entries(STATUS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="城市">{(id) => <input id={id} className={inputClass} value={filters.city} onChange={set('city')} placeholder="如 杭州" />}</Field>
          <Field label="字段">
            {(id) => (
              <select id={id} className={inputClass} value={filters.field} onChange={set('field')}>
                <option value="">全部</option>
                <option value="price">门票</option>
                <option value="hours">开放时间</option>
              </select>
            )}
          </Field>
          <div className="flex items-end">
            <Button onClick={reload} disabled={loading}>
              刷新
            </Button>
          </div>
        </div>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {!loading && !error && items.length === 0 && <Notice>队列是空的。</Notice>}
      <ul className="space-y-3" aria-label="纠错条目">
        {items.map((item) => (
          <li key={item.id}>
            <CorrectionItem item={item} admin={admin} onDone={reload} />
          </li>
        ))}
      </ul>
    </Page>
  );
}

function CorrectionItem({ item, admin, onDone }) {
  const [verify, setVerify] = useState({ value: '', url: '', title: '', retrievedAt: today() });
  const set = (key) => (event) => setVerify((v) => ({ ...v, [key]: event.target.value }));
  const act =
    (action, extra = {}) =>
    async (reason) => {
      const result = await adminPost('/corrections', {
        reportId: item.id,
        routebookId: item.routebookId,
        stopKey: item.stopKey,
        field: item.field,
        action,
        reason,
        ...extra
      });
      onDone();
      return action === 'reset' && result.routebooks ? `已改回待确认（${result.routebooks.length} 本路书）` : '已完成';
    };
  return (
    <Card title={`${item.city || '城市未记录'} · ${item.stopName || item.stopKey} · ${FIELD[item.field] ?? item.field}`}>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">当前值：</dt>
          <dd className="inline">{item.value || '（空）'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline text-muted">状态：</dt>
          <dd className="inline">
            {STATUS[item.status] ?? item.status} · 用户看到：{term(CLAIM, item.claimStatus)}
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline text-muted">来源：</dt>
          <dd className="inline">
            {item.source === 'user' ? '用户报错' : item.source}
            {item.method ? ` · ${term(METHOD, item.method)}` : ''}
            {Array.isArray(item.sources) && item.sources.length ? `（${item.sources.length} 个）` : ''}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">提交时间：</dt>
          <dd className="inline">{formatTime(item.createdAt)}</dd>
        </div>
        {item.note && (
          <div className="sm:col-span-2">
            <dt className="inline text-muted">用户说明：</dt>
            <dd className="inline">{item.note}</dd>
          </div>
        )}
        <div className="sm:col-span-2">
          <dt className="inline text-muted">同一地点影响：</dt>
          <dd className="inline">
            {item.cacheKey ? `${item.affectedRoutebooks} 本路书` : '没有地点标识'} · 路书 {item.routebookId}
          </dd>
        </div>
      </dl>
      <h3 className="mt-3 text-sm font-semibold">依据（链接 · 原文摘录 · 查询日期）</h3>
      {item.sources.length === 0 ? (
        <p className="text-sm text-muted">没有来源。</p>
      ) : (
        <ul className="mt-1 space-y-1 text-sm">
          {item.sources.map((s, i) => (
            <li key={i} className="rounded bg-canvas p-2">
              <a href={s.url} target="_blank" rel="noreferrer noopener" className="text-sky-ink underline">
                {s.title || s.domain || s.url}
              </a>
              {s.quote && <blockquote className="mt-1 border-l-2 border-line-strong pl-2 text-ink-2">“{s.quote}”</blockquote>}
              <p className="text-xs text-muted">查询于 {s.retrievedAt ? String(s.retrievedAt).slice(0, 10) : '未记录'}</p>
            </li>
          ))}
        </ul>
      )}
      {item.status === 'open' && (
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <ReasonAction
            label="设为人工核实"
            variant="primary"
            onSubmit={act('verify', { value: verify.value, sources: [{ url: verify.url, title: verify.title, retrievedAt: verify.retrievedAt }] })}
            extra={
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="核实后的值（照来源原文写）">
                  {(id) => <input id={id} className={inputClass} value={verify.value} onChange={set('value')} required />}
                </Field>
                <Field label="来源链接（必填）">
                  {(id) => <input id={id} type="url" className={inputClass} value={verify.url} onChange={set('url')} required placeholder="https://" />}
                </Field>
                <Field label="来源标题">{(id) => <input id={id} className={inputClass} value={verify.title} onChange={set('title')} />}</Field>
                <Field label="查询日期">
                  {(id) => <input id={id} type="date" className={inputClass} value={verify.retrievedAt} onChange={set('retrievedAt')} required />}
                </Field>
              </div>
            }
          />
          <ReasonAction label="改回待确认" onSubmit={act('reset')} />
          <ReasonAction label="驳回报错" onSubmit={act('reject')} />
          <details className="w-full rounded-md border border-line bg-canvas p-2 text-sm">
            <summary className="cursor-pointer font-medium text-ink-2">更多</summary>
            <div className="mt-2 flex flex-wrap gap-2">
              {can(admin.role, 'corrections.batch') && item.cacheKey && (
                <ReasonAction label={`按地点批量改回（${item.affectedRoutebooks} 本）`} variant="danger" onSubmit={act('reset', { batch: true })} />
              )}
              <ReasonAction label="重跑联网核对" onSubmit={act('rerun')} />
            </div>
          </details>
        </div>
      )}
      {item.resolvedBy && (
        <p className="mt-2 text-xs text-muted">
          {item.resolvedBy} 处理于 {formatTime(item.resolvedAt)}
        </p>
      )}
    </Card>
  );
}
