import { useState } from 'react';
import { adminGet, adminPost } from '../api';
import { Button, Card, Field, Notice, Page, ReasonAction, Table, formatTime, inputClass, useLoad } from '../ui';

export default function AdminsPage({ admin }) {
  const { data, error, reload } = useLoad(() => adminGet('/admins'));
  const [form, setForm] = useState({ username: '', role: 'operator' });
  const [created, setCreated] = useState(null);
  const [createError, setCreateError] = useState('');
  const act =
    (target, action, extra = {}) =>
    async (reason) => {
      await adminPost(`/admins/${encodeURIComponent(target.id)}`, { action, reason, ...extra });
      reload();
      return action === 'reset-totp' ? '已重置，对方下次登录重新绑定动态码' : '已完成';
    };
  return (
    <Page title="后台账号" description="角色：运营（日常处理）和管理员（配置、批量、账号）。新账号首次登录时绑定动态码。">
      <Card title="新建账号">
        <form
          className="grid gap-3 sm:grid-cols-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setCreateError('');
            try {
              const result = await adminPost('/admins', form);
              setCreated(result);
              reload();
            } catch (err) {
              setCreateError(err.message);
            }
          }}
        >
          <Field label="用户名">
            {(id) => (
              <input id={id} className={inputClass} value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} required />
            )}
          </Field>
          <Field label="角色">
            {(id) => (
              <select id={id} className={inputClass} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
                <option value="operator">运营</option>
                <option value="admin">管理员</option>
              </select>
            )}
          </Field>
          <div className="flex items-end">
            <Button type="submit" variant="primary">
              创建
            </Button>
          </div>
        </form>
        {created && (
          <Notice tone="ok">
            已创建 {created.admin?.username}。初始密码：<strong className="font-mono">{created.initialPassword}</strong>
            （只显示这一次，请当面或用安全渠道交给对方）
          </Notice>
        )}
        {createError && <Notice tone="error">{createError}</Notice>}
      </Card>
      {error && <Notice tone="error">{error}</Notice>}
      <Card title="账号列表">
        <Table
          caption="后台账号"
          rows={data?.admins ?? []}
          columns={[
            { key: 'username', label: '用户名' },
            { key: 'role', label: '角色', render: (a) => (a.role === 'admin' ? '管理员' : '运营') },
            { key: 'status', label: '状态', render: (a) => (a.status === 'active' ? '正常' : '已停用') },
            { key: 'totpConfirmed', label: '动态码', render: (a) => (a.totpConfirmed ? '已绑定' : '待绑定') },
            { key: 'lastLoginAt', label: '最近登录', render: (a) => formatTime(a.lastLoginAt) },
            {
              key: 'actions',
              label: '操作',
              render: (a) =>
                a.id === admin.id ? (
                  <ReasonAction label="重置我的动态码" onSubmit={act(a, 'reset-totp')} />
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {a.status === 'active' ? (
                      <ReasonAction label="停用" variant="danger" onSubmit={act(a, 'disable')} />
                    ) : (
                      <ReasonAction label="启用" onSubmit={act(a, 'enable')} />
                    )}
                    <ReasonAction
                      label={a.role === 'admin' ? '降为运营' : '升为管理员'}
                      onSubmit={act(a, 'set-role', { role: a.role === 'admin' ? 'operator' : 'admin' })}
                    />
                    <ReasonAction label="重置动态码" onSubmit={act(a, 'reset-totp')} />
                  </div>
                )
            }
          ]}
        />
      </Card>
    </Page>
  );
}
