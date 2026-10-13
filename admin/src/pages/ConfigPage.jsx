import { useMemo, useState } from 'react';
import { can } from '../../../server/admin/permissions.mjs';
import { adminGet, adminPost } from '../api';
import { Button, Card, Field, Notice, Page, ReasonAction, Table, formatTime, inputClass, useLoad } from '../ui';

const GROUPS = { model: '模型', registration: '注册', cities: '开放区域与首页城市', quota: '额度与花费', enrich: '联网核对', admin: '后台安全' };
const SOURCE = { db: '后台设置', env: '环境变量' };
const SECRET_STATE = { db: '已设置（后台）', env: '已设置（环境变量）', unset: '未设置' };
const show = (value, max = 0) => {
  const text = value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return max && text.length > max ? `${text.slice(0, max)}…` : text;
};

export default function ConfigPage({ admin }) {
  const config = useLoad(() => adminGet('/config'));
  const versions = useLoad(() => adminGet('/config/versions'));
  const canWrite = can(admin.role, 'config.write');
  const reloadAll = () => {
    config.reload();
    versions.reload();
  };
  return (
    <Page title="配置" description="后台设置优先，没设的回落到环境变量；数据库连不上时沿用最后一次的配置。改动几秒内生效，每次保存生成一个版本，可一键恢复。">
      {config.error && <Notice tone="error">{config.error}</Notice>}
      {config.data && (
        <>
          <Notice tone={config.data.stale ? 'warn' : 'info'}>
            当前版本 v{config.data.version} · 来源 {config.data.source === 'db' ? '数据库' : '仅环境变量'}
            {config.data.stale ? ` · 数据库暂时不可用，沿用上次配置（${config.data.error}），现在不能保存` : ''}
          </Notice>
          <ConfigEditor data={config.data} canWrite={canWrite} admin={admin} onSaved={reloadAll} />
        </>
      )}
      <VersionsCard versions={versions} admin={admin} onRestored={reloadAll} />
      {can(admin.role, 'invites.manage') && <InvitesCard />}
    </Page>
  );
}

function SettingInput({ setting, value, onChange, disabled }) {
  const t = setting.type;
  if (t === 'bool')
    return (id) => (
      <select id={id} className={inputClass} disabled={disabled} value={value ? 'true' : 'false'} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">开</option>
        <option value="false">关</option>
      </select>
    );
  if (t === 'enum')
    return (id) => (
      <select id={id} className={inputClass} disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {setting.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  if (t === 'int' || t === 'number')
    return (id) => (
      <input
        id={id}
        type="number"
        step={t === 'int' ? 1 : 'any'}
        min={setting.min}
        max={setting.max}
        className={inputClass}
        disabled={disabled}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
      />
    );
  if (t === 'string[]')
    return (id) => (
      <input
        id={id}
        className={inputClass}
        disabled={disabled}
        value={(value ?? []).join('、')}
        onChange={(e) => onChange(e.target.value.split(/[、,，\s]+/).filter(Boolean))}
      />
    );
  if (t === 'modelTier' || t === 'pricing') return (id) => <JsonInput id={id} disabled={disabled} value={value} onChange={onChange} />;
  return (id) => <input id={id} className={inputClass} disabled={disabled} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
}

function JsonInput({ id, value, onChange, disabled }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [bad, setBad] = useState(false);
  return (
    <>
      <textarea
        id={id}
        rows={6}
        className={`${inputClass} font-mono text-xs`}
        disabled={disabled}
        value={text}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad && <span className="text-xs text-danger">JSON 格式不对</span>}
    </>
  );
}

function ConfigEditor({ data, canWrite, admin, onSaved }) {
  const [draft, setDraft] = useState({});
  const [secrets, setSecrets] = useState({});
  const [changes, setChanges] = useState(null);
  const [testRuns, setTestRuns] = useState({});
  const [force, setForce] = useState(false);
  const [confirmTwoSourceOff, setConfirmTwoSourceOff] = useState(false);
  const [message, setMessage] = useState(null);
  const groups = useMemo(() => {
    const out = {};
    for (const s of data.settings) (out[s.group] ??= []).push(s);
    return out;
  }, [data.settings]);
  const valueOf = (s) => (s.key in draft ? draft[s.key] : s.value);
  const secretPatch = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
  const dirty = Object.keys(draft).length > 0 || Object.keys(secretPatch).length > 0;
  const changedTiers = ['fast', 'deep'].filter((tier) => `model.${tier}` in draft || secretPatch[`provider.${tier}.apiKey`]);
  const failedTiers = changedTiers.filter((tier) => !testRuns[tier]?.ok);
  const twoSourceOff = draft['enrich.requireTwoSources'] === false;

  const preview = async () => {
    setMessage(null);
    try {
      setChanges((await adminPost('/config/preview', { values: draft, secrets: secretPatch })).changes);
    } catch (error) {
      setMessage({ tone: 'error', text: error.message });
    }
  };
  const testRun = async (tier) => {
    const tierSetting = data.settings.find((s) => s.key === `model.${tier}`);
    try {
      const result = await adminPost('/config/test-run', { tier, draft: valueOf(tierSetting), apiKey: secretPatch[`provider.${tier}.apiKey`] || '' });
      setTestRuns((t) => ({ ...t, [tier]: result }));
    } catch (error) {
      setTestRuns((t) => ({ ...t, [tier]: { ok: false, error: error.message } }));
    }
  };

  return (
    <>
      {Object.entries(groups).map(([group, settings]) => (
        <Card key={group} title={GROUPS[group] ?? group}>
          <div className="grid gap-4 md:grid-cols-2">
            {settings.map((s) => (
              <div key={s.key} className="space-y-1">
                <Field
                  label={`${s.label}（${s.key}）`}
                  hint={`来源：${SOURCE[s.source]} · 环境变量值：${show(s.envValue, 80)}${s.items ? ` · 可选：${s.items.length > 12 ? `${s.items.slice(0, 12).join('、')} 等 ${s.items.length} 项` : s.items.join('、')}` : ''}`}
                >
                  {SettingInput({ setting: s, value: valueOf(s), disabled: !canWrite, onChange: (v) => setDraft((d) => ({ ...d, [s.key]: v })) })}
                </Field>
                {canWrite && s.source === 'db' && (
                  <button type="button" className="text-xs text-sky-ink underline" onClick={() => setDraft((d) => ({ ...d, [s.key]: null }))}>
                    恢复成环境变量值
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      ))}
      <Card title="密钥（只写）">
        <p className="mb-3 text-sm text-muted">密钥只能替换，不能查看。保存后只显示状态。</p>
        <div className="grid gap-4 md:grid-cols-3">
          {data.secrets.map((s) => (
            <Field
              key={s.key}
              label={s.label}
              hint={`${SECRET_STATE[s.state] ?? s.state}${s.updatedAt ? ` · ${s.updatedBy} 于 ${formatTime(s.updatedAt)}` : ''}`}
            >
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  className={inputClass}
                  disabled={!canWrite}
                  value={secrets[s.key] ?? ''}
                  placeholder="输入新值以替换"
                  onChange={(e) => setSecrets((x) => ({ ...x, [s.key]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </div>
      </Card>
      {canWrite && (
        <Card title="保存改动">
          {!dirty && <p className="text-sm text-muted">还没有改动。</p>}
          {dirty && (
            <div className="space-y-3">
              <Button onClick={preview}>预览改动（改前 → 改后）</Button>
              {changes && (
                <Table
                  caption="改动预览"
                  rows={changes.map((c) => ({ ...c, id: c.key }))}
                  columns={[
                    { key: 'key', label: '设置项' },
                    { key: 'before', label: '改前', render: (c) => <code className="text-xs">{show(c.before)}</code> },
                    { key: 'after', label: '改后', render: (c) => <code className="text-xs">{show(c.after)}</code> }
                  ]}
                  empty="没有实际改动"
                />
              )}
              {changedTiers.map((tier) => (
                <div key={tier} className="flex flex-wrap items-center gap-2 text-sm">
                  <Button onClick={() => testRun(tier)}>试跑{tier === 'fast' ? '轻快' : '细品'}档</Button>
                  {testRuns[tier] && (
                    <span role="status" className={testRuns[tier].ok ? 'text-success-ink' : 'text-danger'}>
                      {testRuns[tier].ok
                        ? `通过，用时 ${testRuns[tier].durationMs}ms，花费 ${testRuns[tier].cost ? `$${testRuns[tier].cost.amount}` : '未知（模型没填单价）'}，本小时还能试 ${testRuns[tier].remainingThisHour} 次`
                        : `失败：${testRuns[tier].error}`}
                    </span>
                  )}
                </div>
              ))}
              {failedTiers.length > 0 && admin.role === 'admin' && (
                <label className="flex items-center gap-2 text-sm text-warn-ink">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  试跑没通过也要保存（只有管理员能这样做，会记入审计）
                </label>
              )}
              {twoSourceOff && (
                <label className="flex items-center gap-2 text-sm text-warn-ink">
                  <input type="checkbox" checked={confirmTwoSourceOff} onChange={(e) => setConfirmTwoSourceOff(e.target.checked)} />
                  我确认关闭「两来源一致」：只有一个来源的值也会显示给用户
                </label>
              )}
              <ReasonAction
                label="保存为新版本"
                disabled={failedTiers.length > 0 && !force}
                onSubmit={async (reason) => {
                  const result = await adminPost('/config', {
                    values: draft,
                    secrets: secretPatch,
                    reason,
                    testRunIds: Object.values(testRuns)
                      .map((r) => r.testRunId)
                      .filter(Boolean),
                    force,
                    confirmTwoSourceOff
                  });
                  setDraft({});
                  setSecrets({});
                  setChanges(null);
                  setTestRuns({});
                  setForce(false);
                  onSaved();
                  const text = `已保存为 v${result.version}，几秒内各进程生效`;
                  setMessage({ tone: 'ok', text });
                  return text;
                }}
              />
              {failedTiers.length > 0 && !force && <p className="text-sm text-muted">改了模型或模型密钥，需要先试跑通过才能保存。</p>}
            </div>
          )}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </Card>
      )}
    </>
  );
}

function VersionsCard({ versions, admin, onRestored }) {
  const canRestore = can(admin.role, 'config.restore');
  const canExport = can(admin.role, 'config.export');
  return (
    <Card title="版本历史">
      {versions.error && <Notice tone="error">{versions.error}</Notice>}
      <Table
        caption="配置版本历史"
        rows={(versions.data?.versions ?? []).map((v) => ({ ...v, id: v.version }))}
        empty="还没有后台保存过的版本（全部来自环境变量）"
        columns={[
          { key: 'version', label: '版本', render: (v) => `v${v.version}` },
          { key: 'createdAt', label: '时间', render: (v) => formatTime(v.createdAt) },
          { key: 'actor', label: '操作人' },
          { key: 'note', label: '原因', render: (v) => `${v.note}${v.restoredFrom ? `（恢复自 v${v.restoredFrom}）` : ''}` },
          { key: 'changes', label: '改动', render: (v) => (v.changes ?? []).map((c) => c.key).join('、') || '—' },
          {
            key: 'actions',
            label: '操作',
            render: (v) => (
              <div className="flex flex-wrap gap-2">
                {canExport && (
                  <a className="text-sm text-sky-ink underline" href={`/api/admin/config/versions/${v.version}/export`} download>
                    导出 JSON
                  </a>
                )}
                {canRestore && (
                  <ReasonAction
                    label={`恢复到 v${v.version}`}
                    onSubmit={async (reason) => {
                      const result = await adminPost(`/config/versions/${v.version}/restore`, { reason });
                      onRestored();
                      return `已恢复，生成新版本 v${result.version}`;
                    }}
                  />
                )}
              </div>
            )
          }
        ]}
      />
    </Card>
  );
}

function InvitesCard() {
  const invites = useLoad(() => adminGet('/invites'));
  const [form, setForm] = useState({ label: '', maxUses: '1', expiresAt: '' });
  const [created, setCreated] = useState(null);
  const [error, setError] = useState('');
  return (
    <Card title="邀请码">
      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setError('');
          try {
            const result = await adminPost('/invites', {
              label: form.label,
              maxUses: Number(form.maxUses),
              expiresAt: form.expiresAt ? new Date(`${form.expiresAt}T23:59:59+08:00`).toISOString() : null
            });
            setCreated(result.code);
            invites.reload();
          } catch (err) {
            setError(err.message);
          }
        }}
      >
        <Field label="备注">
          {(id) => <input id={id} className={inputClass} value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />}
        </Field>
        <Field label="可用次数">
          {(id) => (
            <input
              id={id}
              type="number"
              min="1"
              max="10000"
              className={inputClass}
              value={form.maxUses}
              onChange={(e) => setForm((f) => ({ ...f, maxUses: e.target.value }))}
            />
          )}
        </Field>
        <Field label="过期日期（北京时间，可空）">
          {(id) => (
            <input id={id} type="date" className={inputClass} value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
          )}
        </Field>
        <div className="flex items-end">
          <Button type="submit" variant="primary">
            生成邀请码
          </Button>
        </div>
      </form>
      {created && (
        <Notice tone="ok">
          新邀请码：<strong className="font-mono">{created}</strong>（只显示这一次，请现在复制）
        </Notice>
      )}
      {error && <Notice tone="error">{error}</Notice>}
      <Table
        caption="邀请码列表"
        rows={invites.data?.invites ?? []}
        columns={[
          { key: 'label', label: '备注' },
          { key: 'used', label: '已用 / 上限', render: (i) => `${i.used} / ${i.maxUses}` },
          { key: 'expiresAt', label: '过期', render: (i) => (i.expiresAt ? formatTime(i.expiresAt) : '不过期') },
          { key: 'createdBy', label: '创建人' },
          {
            key: 'state',
            label: '状态',
            render: (i) =>
              i.revokedAt ? (
                '已作废'
              ) : (
                <ReasonAction
                  label="作废"
                  onSubmit={async (reason) => {
                    await adminPost(`/invites/${i.id}/revoke`, { reason });
                    invites.reload();
                    return '已作废';
                  }}
                />
              )
          }
        ]}
      />
    </Card>
  );
}
