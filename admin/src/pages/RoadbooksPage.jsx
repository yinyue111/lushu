import { ENRICH_JOB, GENERATION, MODE, term } from '../terms';
import { useState } from 'react';
import { adminGet, adminPost, query } from '../api';
import { Button, Card, Field, Notice, Page, ReasonAction, Table, formatTime, inputClass, useLoad } from '../ui';

const STATUS = { public: '公开', 'friend-link': '好友链接', private: '私密', draft: '草稿', 'taken-down': '已下架' };

export default function RoadbooksPage() {
  const [form, setForm] = useState({ q: '', city: '', profileId: '' });
  const [filters, setFilters] = useState(form);
  const { data, error, loading, reload } = useLoad(() => adminGet(`/roadbooks${query(filters)}`), [filters.q, filters.city, filters.profileId]);
  const failures = useLoad(() => adminGet(`/failures${query({ profileId: filters.profileId })}`), [filters.profileId]);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));
  return (
    <Page title="路书" description="按路书 ID、城市或用户 ID 查。可下架分享链接、重跑联网核对。">
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters(form);
          }}
        >
          <Field label="路书 ID 或标题">{(id) => <input id={id} className={inputClass} value={form.q} onChange={set('q')} />}</Field>
          <Field label="城市">{(id) => <input id={id} className={inputClass} value={form.city} onChange={set('city')} />}</Field>
          <Field label="用户 ID">{(id) => <input id={id} className={inputClass} value={form.profileId} onChange={set('profileId')} />}</Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" disabled={loading}>
              查找
            </Button>
          </div>
        </form>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <ul className="space-y-3" aria-label="路书列表">
        {(data?.items ?? []).filter(Boolean).map((rb) => (
          <li key={rb.publicId}>
            <RoadbookCard rb={rb} onDone={reload} />
          </li>
        ))}
      </ul>
      {data && (data.items ?? []).filter(Boolean).length === 0 && <Notice>没找到路书。</Notice>}
      <Card title="最近生成失败">
        <Table
          caption="最近生成失败"
          rows={failures.data?.items ?? []}
          columns={[
            { key: 'createdAt', label: '时间', render: (r) => formatTime(r.createdAt) },
            { key: 'city', label: '城市' },
            { key: 'mode', label: '模式', render: (r) => term(MODE, r.mode) },
            { key: 'code', label: '错误码' },
            { key: 'failureReason', label: '原因' },
            { key: 'requestId', label: '请求 ID', render: (r) => <span className="font-mono text-xs">{r.requestId}</span> }
          ]}
        />
      </Card>
    </Page>
  );
}

function enrichmentText(e) {
  if (e.status === 'queued' || e.status === 'running') return `${term(ENRICH_JOB, e.status)}（还没出结果）`;
  if (e.status === 'failed') return `失败${e.lastError ? `：${e.lastError}` : ''}`;
  if (e.status === 'done') return `已查完：核对到 ${e.filled} 项，留待确认 ${e.kept} 项`;
  return term(ENRICH_JOB, e.status);
}

function RoadbookCard({ rb, onDone }) {
  const act = (action) => async (reason) => {
    await adminPost(`/roadbooks/${encodeURIComponent(rb.publicId)}`, { action, reason });
    onDone();
    return action === 'take-down' ? '已下架：分享页不再可见，路书本身保留' : '已排队重跑';
  };
  return (
    <Card title={`${rb.title || '未命名路书'} · ${rb.city || '—'} · ${STATUS[rb.status] ?? rb.status}`}>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">路书 ID：</dt>
          <dd className="inline font-mono">{rb.publicId}</dd>
        </div>
        <div>
          <dt className="inline text-muted">站点数：</dt>
          <dd className="inline">{rb.stops}</dd>
        </div>
        <div>
          <dt className="inline text-muted">生成：</dt>
          <dd className="inline">
            {rb.generation
              ? `${term(MODE, rb.generation.mode)} · ${rb.generation.model || '—'} · ${term(GENERATION, rb.generation.status)}${rb.generation.fellBackFrom ? `（${term(MODE, rb.generation.fellBackFrom)}失败，由备用模型生成）` : ''}`
              : '无记录'}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">联网核对：</dt>
          <dd className="inline">{rb.enrichment ? enrichmentText(rb.enrichment) : '未运行'}</dd>
        </div>
        <div>
          <dt className="inline text-muted">更新：</dt>
          <dd className="inline">{formatTime(rb.updatedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-muted">账号：</dt>
          <dd className="inline font-mono">
            {rb.accountId ? (
              <a
                href={`/admin/users?q=${encodeURIComponent(rb.accountId)}`}
                className="text-sky-ink underline"
                onClick={(event) => {
                  event.preventDefault();
                  window.history.pushState({}, '', `/admin/users?q=${encodeURIComponent(rb.accountId)}`);
                  window.dispatchEvent(new PopStateEvent('popstate'));
                }}
              >
                {rb.accountId}
              </a>
            ) : (
              '—'
            )}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">详情：</dt>
          <dd className="inline font-mono text-muted">{rb.profileId || '—'}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <ReasonAction label="重跑联网核对" onSubmit={act('rerun-enrichment')} />
        {(rb.status === 'public' || rb.status === 'friend-link') && <ReasonAction label="下架分享链接" variant="danger" onSubmit={act('take-down')} />}
      </div>
    </Card>
  );
}
