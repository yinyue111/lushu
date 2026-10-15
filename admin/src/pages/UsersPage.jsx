import { useState } from 'react';
import { adminGet, adminPost, query } from '../api';
import { Button, Card, Field, Notice, Page, ReasonAction, formatTime, inputClass, useLoad } from '../ui';

const STATUS = { active: '正常', disabled: '已封禁' };

export default function UsersPage({ admin }) {
  const initialQ = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('q') || '' : '';
  const [draft, setDraft] = useState(initialQ);
  const [q, setQ] = useState(initialQ);
  const { data, error, loading, reload } = useLoad(() => adminGet(`/users${query({ q })}`), [q]);
  return (
    <Page title="用户" description="按完整邮箱、完整手机号或手机号后 4 位查找。联系方式只显示打码后的。">
      <Card>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setQ(draft.trim());
          }}
        >
          <div className="min-w-64 flex-1">
            <Field label="查找用户">
              {(id) => <input id={id} className={inputClass} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="邮箱 / 手机号 / 账号 ID / 后 4 位" />}
            </Field>
          </div>
          <Button type="submit" variant="primary" disabled={loading}>
            查找
          </Button>
        </form>
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      {data && !data.enabled && <Notice>账号系统没开（AUTH_ENABLED=false），没有用户可查。</Notice>}
      {data?.enabled && data.users.length === 0 && <Notice>没找到。</Notice>}
      <ul className="space-y-3" aria-label="用户列表">
        {(data?.users ?? []).map((user) => (
          <li key={user.id}>
            <UserCard user={user} admin={admin} onDone={reload} />
          </li>
        ))}
      </ul>
    </Page>
  );
}

function UserCard({ user, admin, onDone }) {
  const [quota, setQuota] = useState(user.generationQuota ?? '');
  const act =
    (action, extra = {}) =>
    async (reason) => {
      const result = await adminPost(`/users/${encodeURIComponent(user.id)}`, { action, reason, ...extra });
      onDone();
      return result.sentTo ? `恢复码已发到 ${result.sentTo}（你看不到恢复码本身）` : '已完成';
    };
  return (
    <Card title={`${user.emailMasked || user.phoneMasked || user.id} · ${STATUS[user.status] ?? user.status}`}>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="inline text-muted">账号：</dt>
          <dd className="inline font-mono">{user.id}</dd>
        </div>
        <div>
          <dt className="inline text-muted">邮箱：</dt>
          <dd className="inline">
            {user.emailMasked || '—'} {user.emailVerified ? '（已验证）' : ''}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">注册 / 最近登录：</dt>
          <dd className="inline">
            {formatTime(user.createdAt)} / {formatTime(user.lastLoginAt)}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted">额度：</dt>
          <dd className="inline">
            近 {user.windowHours} 小时已用 {user.usedInWindow} 次 · 单人额度 {user.generationQuota ?? '默认'}
          </dd>
        </div>
      </dl>
      <div className="mt-3 flex flex-wrap items-start gap-2">
        {user.status === 'active' ? (
          <ReasonAction label="封禁" variant="danger" onSubmit={act('ban')} />
        ) : (
          <ReasonAction label="解封" onSubmit={act('unban')} />
        )}
        <ReasonAction label="清零已用次数（从现在重新计）" onSubmit={act('reset-quota')} />
        <ReasonAction
          label="改单人额度"
          onSubmit={act('set-quota', { quota: quota === '' ? null : Number(quota) })}
          extra={
            <Field label="新的单人额度" hint={admin.role === 'admin' ? '留空恢复默认' : '运营最多改到配置里的上限'}>
              {(id) => <input id={id} type="number" min="0" className={inputClass} value={quota} onChange={(e) => setQuota(e.target.value)} />}
            </Field>
          }
        />
        <ReasonAction label="发恢复码到已验证邮箱" disabled={!user.emailVerified} onSubmit={act('send-recovery')} />
      </div>
    </Card>
  );
}
