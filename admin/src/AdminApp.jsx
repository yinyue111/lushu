import { useCallback, useEffect, useState } from 'react';
import { can } from '../../server/admin/permissions.mjs';
import { adminGet, adminPost, setCsrfToken, setSessionLostHandler } from './api';
import { Button, Card, Field, Notice, inputClass } from './ui';
import DashboardPage from './pages/DashboardPage';
import CorrectionsPage from './pages/CorrectionsPage';
import ConfigPage from './pages/ConfigPage';
import UsersPage from './pages/UsersPage';
import RoadbooksPage from './pages/RoadbooksPage';
import AuditPage from './pages/AuditPage';
import AdminsPage from './pages/AdminsPage';
import SystemPage from './pages/SystemPage';
import VerifiedPlacesPage from './pages/VerifiedPlacesPage';
import LegacyOpsPage from './pages/LegacyOpsPage';

/** @type {{ path: string, label: string, permission: any, Component: any }[]} */
/** @type {{ path: string, label: string, permission: string, Component: any, phase2?: boolean }[]} */
const NAV = [
  { path: 'dashboard', label: '概览', permission: 'dashboard.read', Component: DashboardPage },
  { path: 'corrections', label: '纠错队列', permission: 'corrections.read', Component: CorrectionsPage },
  { path: 'users', label: '用户', permission: 'users.read', Component: UsersPage },
  { path: 'roadbooks', label: '路书', permission: 'roadbooks.read', Component: RoadbooksPage },
  { path: 'config', label: '配置', permission: 'config.read', Component: ConfigPage },
  { path: 'audit', label: '审计', permission: 'audit.read.own', Component: AuditPage },
  { path: 'admins', label: '后台账号', permission: 'admins.manage', Component: AdminsPage },
  { path: 'system', label: '系统信息', permission: 'system.read', Component: SystemPage },
  { path: 'verified-places', label: '地点核对库（二期）', permission: 'corrections.read', Component: VerifiedPlacesPage, phase2: true },
  { path: 'legacy-ops', label: '旧运维工具', permission: 'admins.manage', Component: LegacyOpsPage }
];

const currentPath = () => window.location.pathname.replace(/^\/admin\/?/, '').split('/')[0] || 'dashboard';

export default function AdminApp() {
  const [session, setSession] = useState(null);
  const [checked, setChecked] = useState(false);
  const [path, setPath] = useState(currentPath);

  const lose = useCallback(() => {
    setCsrfToken('');
    setSession(null);
  }, []);
  useEffect(() => {
    setSessionLostHandler(lose);
    const onPop = () => setPath(currentPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [lose]);
  useEffect(() => {
    // The cookie may still be valid, but the CSRF token was only in memory: writes need a fresh login.
    adminGet('/me')
      .then(() => setChecked(true))
      .catch(() => setChecked(true));
  }, []);

  const go = (next) => {
    window.history.pushState({}, '', `/admin/${next}`);
    setPath(next);
  };

  if (!session) return <LoginScreen ready={checked} onSignedIn={setSession} />;
  const allowed = NAV.filter((item) => can(session.admin.role, item.permission));
  const active = allowed.find((item) => item.path === path) ?? allowed[0];
  const { Component } = active;
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <a href="#admin-main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:bg-paper focus:p-2">
        跳到正文
      </a>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-paper px-4 py-3">
        <p className="font-semibold">路书管理后台</p>
        <div className="flex items-center gap-3 text-sm text-muted">
          <span>
            {session.admin.username} · {session.admin.role === 'admin' ? '管理员' : '运营'} · 闲置 {session.idleMinutes} 分钟自动退出
          </span>
          <Button
            onClick={async () => {
              await adminPost('/logout').catch(() => {});
              lose();
            }}
          >
            退出
          </Button>
        </div>
      </header>
      <div className="flex flex-col md:flex-row">
        <nav aria-label="后台导航" className="border-b border-line bg-paper p-2 md:min-h-[calc(100vh-57px)] md:w-48 md:border-b-0 md:border-r">
          <ul className="flex flex-wrap gap-1 md:flex-col">
            {allowed.map((item) => (
              <li key={item.path}>
                <a
                  href={`/admin/${item.path}`}
                  aria-current={item.path === active.path ? 'page' : undefined}
                  onClick={(event) => {
                    event.preventDefault();
                    go(item.path);
                  }}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-2 text-sm ${
                    item.path === active.path ? 'bg-ink text-white' : item.phase2 ? 'text-[#6b7280] hover:bg-canvas' : 'text-ink-2 hover:bg-canvas'
                  }`}
                >
                  <span className="sr-only">{item.label}</span>
                  <span aria-hidden="true" className="flex items-center gap-1.5">
                    <span>{item.label.replace('（二期）', '')}</span>
                    {item.phase2 ? (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${item.path === active.path ? 'bg-white/20 text-white' : 'bg-canvas text-[#6b7280]'}`}
                      >
                        二期
                      </span>
                    ) : null}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main id="admin-main" className="min-w-0 flex-1 p-4">
          <Component admin={session.admin} />
        </main>
      </div>
    </div>
  );
}

function LoginScreen({ ready, onSignedIn }) {
  const [form, setForm] = useState({ username: '', password: '', totp: '', backupCode: '' });
  const [useBackup, setUseBackup] = useState(false);
  const [enroll, setEnroll] = useState(null);
  const [backupCodes, setBackupCodes] = useState(null);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (key) => (event) => setForm((f) => ({ ...f, [key]: event.target.value }));

  const finish = (data) => {
    setCsrfToken(data.csrfToken);
    return { admin: data.admin, idleMinutes: data.idleMinutes };
  };
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (enroll) {
        const data = await adminPost('/enroll', { token: enroll.token, totp: form.totp });
        setBackupCodes(data.backupCodes);
        setPending(finish(data));
      } else {
        const body = { username: form.username, password: form.password, ...(useBackup ? { backupCode: form.backupCode } : { totp: form.totp }) };
        const data = await adminPost('/login', body);
        if (data.enroll) {
          setEnroll(data.enroll);
          setForm((f) => ({ ...f, totp: '' }));
        } else onSignedIn(finish(data));
      }
    } catch (err) {
      const remaining = err?.remainingAttempts ?? err?.data?.remainingAttempts;
      setError(Number.isFinite(remaining) ? `用户名、密码或动态码不对。还能再试 ${remaining} 次。` : String(err.message || '').replace('验证码', '动态码'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas p-4 text-ink">
      <div className="w-full max-w-md space-y-4">
        <h1 className="text-xl font-semibold">路书管理后台</h1>
        {backupCodes ? (
          <Card title="请保存备用码">
            <p className="mb-2 text-sm text-ink-2">每个备用码只能用一次，丢了手机时代替动态码登录。这里只显示这一次。</p>
            <ul className="mb-3 grid grid-cols-2 gap-1 font-mono text-sm" aria-label="备用码">
              {backupCodes.map((code) => (
                <li key={code} className="rounded bg-canvas px-2 py-1">
                  {code}
                </li>
              ))}
            </ul>
            <Button variant="primary" onClick={() => onSignedIn(pending)}>
              我已保存，进入后台
            </Button>
          </Card>
        ) : (
          <Card title={enroll ? '绑定动态码（首次登录）' : '登录'}>
            {!ready && <Notice>正在检查登录状态…</Notice>}
            <form className="space-y-3" onSubmit={submit}>
              {enroll ? (
                <>
                  <p className="text-sm text-ink-2">在验证器 App（如 Google Authenticator、1Password）里添加账户，手动输入下面的密钥，然后填 6 位动态码。</p>
                  <p className="break-all rounded bg-canvas p-2 font-mono text-sm" aria-label="动态码密钥">
                    {enroll.secret}
                  </p>
                  <details className="text-xs text-muted">
                    <summary>otpauth 链接</summary>
                    <span className="break-all">{enroll.otpauthUrl}</span>
                  </details>
                </>
              ) : (
                <>
                  <Field label="用户名">
                    {(id) => <input id={id} className={inputClass} autoComplete="username" value={form.username} onChange={set('username')} required />}
                  </Field>
                  <Field label="密码">
                    {(id) => (
                      <input
                        id={id}
                        type="password"
                        className={inputClass}
                        autoComplete="current-password"
                        value={form.password}
                        onChange={set('password')}
                        required
                      />
                    )}
                  </Field>
                </>
              )}
              {useBackup && !enroll ? (
                <Field label="备用码">
                  {(id) => <input id={id} className={inputClass} autoComplete="off" value={form.backupCode} onChange={set('backupCode')} required />}
                </Field>
              ) : (
                <Field label="6 位动态码" hint={enroll ? undefined : '首次登录可留空，会进入绑定步骤'}>
                  {(id) => (
                    <input
                      id={id}
                      className={inputClass}
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]{6}"
                      value={form.totp}
                      onChange={set('totp')}
                      required={Boolean(enroll)}
                    />
                  )}
                </Field>
              )}
              {error && <Notice tone="error">{error}</Notice>}
              <div className="flex flex-col gap-3">
                <Button type="submit" variant="primary" className="min-h-11 w-full justify-center" disabled={busy}>
                  {busy ? '请稍候…' : enroll ? '绑定并登录' : '登录'}
                </Button>
                {!enroll && (
                  <button type="button" className="self-start text-sm text-sky-ink underline" onClick={() => setUseBackup((v) => !v)}>
                    {useBackup ? '改用动态码' : '手机不在身边？用备用码'}
                  </button>
                )}
              </div>
            </form>
          </Card>
        )}
        <p className="text-xs text-muted">连续输错 5 次会锁定 15 分钟。忘记密码或丢失验证器请联系管理员重置。</p>
      </div>
    </main>
  );
}
