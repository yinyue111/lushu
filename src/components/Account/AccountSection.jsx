import { useId, useState } from 'react';
import { Download, KeyRound, LogOut, MonitorSmartphone, ShieldCheck, Trash2 } from 'lucide-react';
import { Button } from '../ui/button';
import { inputClass } from '../ui/field';
import { Notice } from '../ui/notice';
import { cn } from '../ui/cn';
import { useAccount } from './AccountProvider';
import { changePassword, deleteAccount, exportAccount, regenerateRecoveryCodes } from '../../lib/accountApi';
import { authErrorCopy, PASSWORD_HINT } from '../../lib/accountCopy';

/** Account block on the My page: login entry for guests, account controls once signed in. */
export function AccountSection() {
  const { account, openLogin, required, registration } = useAccount();
  if (!account) {
    return (
      <section className="rounded-panel border border-line bg-white p-5" aria-labelledby="account-guest-title">
        <h2 id="account-guest-title" className="text-lg font-extrabold">
          账号
        </h2>
        <p className="mt-1 text-sm text-muted">
          {required
            ? '现在没登录：看路线、在本机走行程都可以。导入攻略、生成路书、打卡和跨设备同步需要登录。'
            : '登录后，路书和行程跟着账号走，换手机也能接着用。'}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => openLogin('login')}>
            登录
          </Button>
          {registration !== 'closed' && (
            <Button variant="outline" size="sm" onClick={() => openLogin('register')}>
              注册账号
            </Button>
          )}
        </div>
      </section>
    );
  }
  return <SignedIn account={account} />;
}

function SignedIn({ account }) {
  const { logout, showRecoveryCodes, setAccount } = useAccount();
  const [panel, setPanel] = useState('');
  const [message, setMessage] = useState('');
  const toggle = (name) => {
    setMessage('');
    setPanel((current) => (current === name ? '' : name));
  };
  const download = async () => {
    setMessage('');
    try {
      const data = await exportAccount();
      const blob = new Blob([JSON.stringify(data.export, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement('a'), { href: url, download: `lushu-account-export-${new Date().toISOString().slice(0, 10)}.json` });
      link.click();
      URL.revokeObjectURL(url);
      setMessage('已导出。文件里没有密码和恢复码。');
    } catch (error) {
      setMessage(authErrorCopy(error));
    }
  };
  return (
    <section className="rounded-panel border border-line bg-white p-5" aria-labelledby="account-title">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="account-title" className="text-lg font-extrabold">
            账号
          </h2>
          <p className="num mt-1 text-copy font-semibold text-ink">{account.phoneMasked}</p>
          <p className="mt-0.5 text-sm text-muted">
            还剩 {account.recoveryCodesLeft} 个恢复码
            {Number.isFinite(account.activeSessions) ? ` · ${account.activeSessions} 台设备在登录` : ''}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-2.5 py-1 text-xs font-bold text-success-ink">
          <ShieldCheck className="size-3.5" aria-hidden="true" /> 已登录
        </span>
      </div>
      {account.recoveryCodesLeft <= 2 && (
        <Notice className="mt-3" tone="warn">
          恢复码快用完了。重新生成一组，忘了密码时才找得回来。
        </Notice>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" aria-expanded={panel === 'password'} onClick={() => toggle('password')}>
          <KeyRound /> 改密码
        </Button>
        <Button size="sm" variant="outline" aria-expanded={panel === 'codes'} onClick={() => toggle('codes')}>
          <ShieldCheck /> 重新生成恢复码
        </Button>
        <Button size="sm" variant="outline" onClick={download}>
          <Download /> 导出资料
        </Button>
        <Button size="sm" variant="outline" onClick={() => logout()}>
          <LogOut /> 退出登录
        </Button>
        <Button size="sm" variant="outline" onClick={() => logout({ everywhere: true })}>
          <MonitorSmartphone /> 所有设备退出
        </Button>
        <Button size="sm" variant="danger" aria-expanded={panel === 'delete'} onClick={() => toggle('delete')}>
          <Trash2 /> 注销账号
        </Button>
      </div>
      {panel === 'password' && (
        <PasswordPanel
          submitLabel="改密码"
          withNew
          note="改好后，其他设备会退出登录。"
          onSubmit={async (current, next) => {
            const data = await changePassword(current, next);
            setAccount(data.account);
            setPanel('');
            setMessage('密码改好了。其他设备已经退出登录。');
          }}
        />
      )}
      {panel === 'codes' && (
        <PasswordPanel
          submitLabel="生成新的恢复码"
          note="旧的恢复码会全部作废。"
          onSubmit={async (current) => {
            const data = await regenerateRecoveryCodes(current);
            setAccount(data.account);
            setPanel('');
            showRecoveryCodes(data.recoveryCodes);
          }}
        />
      )}
      {panel === 'delete' && (
        <PasswordPanel
          submitLabel="注销并删除"
          danger
          note="会删除账号、路书、行程、打卡和照片，不能撤销。已经分享出去、被别人保存的副本不在删除范围内。"
          onSubmit={async (current) => {
            await deleteAccount(current);
            setPanel('');
            await logout().catch(() => {});
          }}
        />
      )}
      <p role="status" aria-live="polite" className="text-sm font-semibold text-ink-2 [&:not(:empty)]:mt-3">
        {message}
      </p>
    </section>
  );
}

function PasswordPanel({ submitLabel, note, withNew = false, danger = false, onSubmit }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [state, setState] = useState({ busy: false, error: '' });
  const currentId = useId();
  const nextId = useId();
  const submit = async (event) => {
    event.preventDefault();
    setState({ busy: true, error: '' });
    try {
      await onSubmit(current, next);
      setState({ busy: false, error: '' });
    } catch (error) {
      setState({ busy: false, error: authErrorCopy(error) });
    }
  };
  return (
    <form className="mt-4 grid gap-3 rounded-card bg-canvas p-4" onSubmit={submit}>
      <p className="text-sm text-ink-2">{note}</p>
      <label htmlFor={currentId} className="text-sm font-bold text-ink-2">
        当前密码
      </label>
      <input
        id={currentId}
        className={inputClass}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
      />
      {withNew && (
        <>
          <label htmlFor={nextId} className="text-sm font-bold text-ink-2">
            新密码
          </label>
          <input
            id={nextId}
            className={inputClass}
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            aria-describedby={`${nextId}-hint`}
          />
          <span id={`${nextId}-hint`} className="text-xs text-muted">
            {PASSWORD_HINT}
          </span>
        </>
      )}
      {state.error && (
        <Notice tone="danger" role="alert">
          {state.error}
        </Notice>
      )}
      <Button type="submit" size="sm" variant={danger ? 'danger' : 'dark'} className={cn('justify-self-start')} disabled={state.busy || !current}>
        {submitLabel}
      </Button>
    </form>
  );
}
