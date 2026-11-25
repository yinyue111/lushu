import { useState } from 'react';
import { adminGet, adminPost, query } from '../api';
import { Button, Card, Field, Notice, Page, Table, formatTime, inputClass, useLoad } from '../ui';

const FIELD_NAMES = { price: '门票/价格', hours: '开放时间' };
const STATE_NAMES = { fresh: '有效', expiring: '30天内到期', expired: '已过期' };

export default function VerifiedPlacesPage() {
  const [filters, setFilters] = useState({ city: '', status: '' });
  const [form, setForm] = useState({ city: '杭州', place: '', field: 'price', value: '', sourceUrl: '', reason: '' });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const { data, error, loading, reload } = useLoad(() => adminGet(`/verified-facts${query(filters)}`), [filters.city, filters.status]);

  async function submitFact(event) {
    event.preventDefault();
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      await adminPost('/verified-facts', form);
      setMsg(`已保存「${form.place}」的人工核实值（默认 90 天内优先于联网搜索生效）`);
      setForm((f) => ({ ...f, place: '', value: '', sourceUrl: '', reason: '' }));
      reload();
    } catch (e) {
      setErr(String(e?.message || '保存失败'));
    } finally {
      setBusy(false);
    }
  }

  async function renewFact(row) {
    setBusy(true);
    setErr('');
    try {
      await adminPost('/verified-facts', {
        city: row.city,
        place: row.place,
        field: row.field,
        value: row.value,
        sourceUrl: row.sources?.[0]?.url || '',
        reason: '人工复核续期 90 天'
      });
      setMsg(`已将「${row.place}」续期 90 天`);
      reload();
    } catch (e) {
      setErr(String(e?.message || '续期失败'));
    } finally {
      setBusy(false);
    }
  }

  async function removeFact(row) {
    setBusy(true);
    setErr('');
    try {
      await adminPost('/verified-facts/delete', { cacheKey: row.cacheKey, reason: '后台手动移除核实值' });
      setMsg(`已移除「${row.place}」的核实记录`);
      reload();
    } catch (e) {
      setErr(String(e?.message || '移除失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="地点核对库（二期）" description="按城市录入、浏览与续期人工核实过的门票和开放时间，有效期内优先于联网搜索直接展示。">
      <Card title="录入或更新人工核实地点">
        <form className="grid gap-3 sm:grid-cols-3" onSubmit={submitFact}>
          <Field label="城市">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={form.city}
                onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="如 杭州"
                required
              />
            )}
          </Field>
          <Field label="地点名称">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={form.place}
                onChange={(e) => setForm((f) => ({ ...f, place: e.target.value }))}
                placeholder="如 南京博物院"
                required
              />
            )}
          </Field>
          <Field label="核实字段">
            {(id) => (
              <select id={id} className={inputClass} value={form.field} onChange={(e) => setForm((f) => ({ ...f, field: e.target.value }))}>
                <option value="price">门票/价格</option>
                <option value="hours">开放时间</option>
              </select>
            )}
          </Field>
          <Field label="核实值">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={form.value}
                onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
                placeholder="如 免费（需提前7天预约） 或 09:00-17:00（周一闭馆）"
                required
              />
            )}
          </Field>
          <Field label="官方/权威来源链接（选填）">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={form.sourceUrl}
                onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
                placeholder="https://..."
              />
            )}
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary" disabled={busy}>
              保存核实值
            </Button>
          </div>
        </form>
        {msg && (
          <div className="mt-3">
            <Notice>{msg}</Notice>
          </div>
        )}
        {(err || error) && (
          <div className="mt-3">
            <Notice tone="error">{err || error}</Notice>
          </div>
        )}
      </Card>

      <Card title="已核实地点清单">
        <div className="mb-3 flex flex-wrap gap-3">
          <Field label="按城市筛选">
            {(id) => (
              <input
                id={id}
                className={inputClass}
                value={filters.city}
                onChange={(e) => setFilters((f) => ({ ...f, city: e.target.value.trim() }))}
                placeholder="全部城市"
              />
            )}
          </Field>
          <Field label="时效状态">
            {(id) => (
              <select id={id} className={inputClass} value={filters.status} onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value }))}>
                <option value="">全部状态</option>
                <option value="fresh">有效期内</option>
                <option value="expiring">30天内即将到期</option>
                <option value="expired">已过期</option>
              </select>
            )}
          </Field>
          <div className="flex items-end">
            <Button onClick={reload} disabled={loading}>
              刷新列表
            </Button>
          </div>
        </div>

        <Table
          caption="人工核实地点表"
          rows={data?.items ?? []}
          columns={[
            { key: 'city', label: '城市' },
            { key: 'place', label: '地点' },
            { key: 'field', label: '类型', render: (r) => FIELD_NAMES[r.field] ?? r.field },
            { key: 'value', label: '核实内容' },
            { key: 'state', label: '状态', render: (r) => STATE_NAMES[r.state] ?? r.state },
            { key: 'expiresAt', label: '到期时间', render: (r) => formatTime(r.expiresAt) },
            {
              key: 'actions',
              label: '操作',
              render: (r) => (
                <span className="flex flex-wrap gap-1.5">
                  <Button onClick={() => renewFact(r)} disabled={busy}>
                    续期90天
                  </Button>
                  <Button variant="danger" onClick={() => removeFact(r)} disabled={busy}>
                    移除
                  </Button>
                </span>
              )
            }
          ]}
        />
      </Card>
    </Page>
  );
}
