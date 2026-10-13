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
    <Page title="路书" description="按路书 ID、城市或用户 profile 查。可下架分享链接、重跑联网补全。">
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
          <Field label="用户 profile">{(id) => <input id={id} className={inputClass} value={form.profileId} onChange={set('profileId')} />}</Field>
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
            { key: 'mode', label: '档位' },
            { key: 'code', label: '错误码' },
            { key: 'failureReason', label: '原因' },
            { key: 'requestId', label: '请求 ID', render: (r) => <span className="font-mono text-xs">{r.requestId}</span> }
          ]}
        />
      </Card>
    </Page>
  );
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
          <dd className="inline">{rb.generation ? `${rb.generation.mode || '—'} · ${rb.generation.model || '—'} · ${rb.generation.status}` : '无记录'}</dd>
        </div>
        <div>
          <dt className="inline text-muted">联网补全：</dt>
          <dd className="inline">
            {rb.enrichment
              ? `${rb.enrichment.status} · 补到 ${rb.enrichment.filled} 项 · 留待确认 ${rb.enrichment.kept} 项${rb.enrichment.lastError ? ` · ${rb.enrichment.lastError}` : ''}`
              : '未运行'}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">更新：</dt>
          <dd className="inline">{formatTime(rb.updatedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-muted">用户：</dt>
          <dd className="inline font-mono">{rb.profileId || '—'}</dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        <ReasonAction label="重跑联网补全" onSubmit={act('rerun-enrichment')} />
        {(rb.status === 'public' || rb.status === 'friend-link') && <ReasonAction label="下架分享链接" variant="danger" onSubmit={act('take-down')} />}
      </div>
    </Card>
  );
}
