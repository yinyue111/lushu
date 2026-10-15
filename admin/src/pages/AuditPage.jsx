import { useState } from 'react';
import { adminGet, query } from '../api';
import { Button, Card, Field, Notice, Page, Table, formatTime, inputClass, useLoad } from '../ui';
import { actionLabel } from '../terms';

const short = (value) => (value == null ? '' : JSON.stringify(value).slice(0, 160));

export default function AuditPage() {
  const [form, setForm] = useState({ action: '', actor: '', target: '' });
  const [filters, setFilters] = useState(form);
  const { data, error, loading } = useLoad(() => adminGet(`/audit${query(filters)}`), [filters.action, filters.actor, filters.target]);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));
  return (
    <Page title="审计" description={data?.scope === 'own' ? '运营只能看自己的操作记录。审计表只增不改。' : '全部后台操作，只增不改。'}>
      <Card>
        <form
          className="grid gap-3 sm:grid-cols-4"
          onSubmit={(event) => {
            event.preventDefault();
            setFilters(form);
          }}
        >
          <Field label="动作前缀">
            {(id) => <input id={id} className={inputClass} value={form.action} onChange={set('action')} placeholder="如 config." />}
          </Field>
          <Field label="操作人">{(id) => <input id={id} className={inputClass} value={form.actor} onChange={set('actor')} />}</Field>
          <Field label="对象包含">{(id) => <input id={id} className={inputClass} value={form.target} onChange={set('target')} />}</Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" disabled={loading}>
              筛选
            </Button>
          </div>
        </form>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card>
        <Table
          caption="审计记录"
          rows={data?.items ?? []}
          columns={[
            { key: 'createdAt', label: '时间（北京时间）', render: (e) => formatTime(e.createdAt, { zoneLabel: false }) },
            { key: 'actor', label: '操作人', render: (e) => `${e.actor}（${e.role}）` },
            {
              key: 'action',
              label: '动作',
              render: (e) => (
                <span title={e.action}>
                  {actionLabel(e.action)}
                  {actionLabel(e.action) !== e.action ? <span className="ml-1 text-xs text-muted">{e.action}</span> : null}
                </span>
              )
            },
            { key: 'target', label: '对象', render: (e) => <span className="break-all">{e.target}</span> },
            {
              key: 'detail',
              label: '原因 / 改前 → 改后',
              render: (e) => (
                <span className="break-all text-xs">
                  {[e.detail?.reason, e.detail?.before != null && `${short(e.detail.before)} → ${short(e.detail.after)}`].filter(Boolean).join(' · ') || '—'}
                </span>
              )
            },
            { key: 'ip', label: 'IP' }
          ]}
        />
      </Card>
    </Page>
  );
}
