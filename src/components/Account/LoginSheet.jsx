import { useId, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui/button';
import { inputClass } from '../ui/field';
import { Notice } from '../ui/notice';
import { cn } from '../ui/cn';
import { login, register, resetPassword } from '../../lib/accountApi';
import { deviceProfileProof } from '../../lib/account';
import { authErrorCopy, isMainlandMobile, PASSWORD_HINT } from '../../lib/accountCopy';

const TITLES = { login: '登录', register: '注册账号', forgot: '用恢复码重设密码', codes: '存好你的恢复码' };

/**
 * Phone + password sign-in sheet: bottom sheet on phones, dialog from md up.
 * @param {Record<string, any>} props
 */
export default function LoginSheet({
  initialView = 'login',
  reason = '',
  codes = [],
  afterRegister = false,
  registration = 'invite',
  onAuthenticated,
  onCodesConfirmed,
  onClose
}) {
  const [view, setView] = useState(initialView);
  const description =
    view === 'codes'
      ? '忘了密码时，用其中一个就能重设。每个只能用一次。'
      : reason || (view === 'forgot' ? '输入注册时拿到的恢复码，再设一个新密码。' : '浏览路线不用登录。导入攻略、生成路书要用到 AI，所以需要账号。');
  return (
    <Sheet title={TITLES[view]} description={description} onClose={onClose}>
      <div className="px-1 pb-2">
        {view !== 'codes' && view !== 'forgot' && (
          <div role="tablist" aria-label="登录或注册" className="mb-4 grid grid-cols-2 rounded-full bg-canvas p-1">
            {[
              ['login', '登录'],
              ['register', '注册']
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
                className={cn('h-10 rounded-full text-copy font-bold', view === id ? 'bg-white text-ink shadow-card' : 'text-muted')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {view === 'login' && <LoginForm onAuthenticated={onAuthenticated} onForgot={() => setView('forgot')} />}
        {view === 'register' && <RegisterForm registration={registration} onAuthenticated={onAuthenticated} />}
        {view === 'forgot' && <ForgotForm onAuthenticated={onAuthenticated} onBack={() => setView('login')} />}
        {view === 'codes' && <RecoveryCodes codes={codes} afterRegister={afterRegister} onConfirmed={onCodesConfirmed} />}
      </div>
    </Sheet>
  );
}

/** @returns {[{ busy: boolean, error: string, code: string }, (task: () => Promise<void>) => Promise<void>]} */
function useSubmit() {
  const [state, setState] = useState({ busy: false, error: '', code: '' });
  const run = async (task) => {
    setState({ busy: true, error: '', code: '' });
    try {
      await task();
      setState({ busy: false, error: '', code: '' });
    } catch (error) {
      setState({ busy: false, error: authErrorCopy(error), code: error?.code || '' });
    }
  };
  return [state, run];
}

function PhoneField({ value, onChange, error, autoFocus = false }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        手机号
      </label>
      <div
        className={cn(
          'flex items-stretch overflow-hidden rounded-tile border border-line-strong bg-white focus-within:border-sky focus-within:ring-3 focus-within:ring-sky/20',
          error && 'border-danger'
        )}
      >
        <span className="grid place-items-center border-r border-line bg-canvas px-3 text-base font-semibold text-ink-2" aria-hidden="true">
          +86
        </span>
        <input
          id={id}
          className="min-w-0 flex-1 bg-white px-3.5 py-2.5 text-base text-ink placeholder:text-muted-2 focus:outline-none"
          type="tel"
          inputMode="numeric"
          autoComplete="tel-national"
          maxLength={16}
          placeholder="11 位手机号"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          autoFocus={autoFocus}
        />
      </div>
      {error && (
        <span id={`${id}-error`} className="text-sm font-semibold text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function PasswordField({ label = '密码', value, onChange, autoComplete, hint = '' }) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          className={cn(inputClass, 'pr-12')}
          type={shown ? 'text' : 'password'}
          autoComplete={autoComplete}
          maxLength={72}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
        />
        <button
          type="button"
          className="absolute inset-y-0 right-0 grid w-12 place-items-center text-muted hover:text-ink"
          onClick={() => setShown((current) => !current)}
          aria-pressed={shown}
          aria-label={shown ? '隐藏密码' : '显示密码'}
        >
          {shown ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
        </button>
      </div>
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      )}
    </div>
  );
}

function FormError({ text }) {
  return (
    <div aria-live="assertive" className="min-h-0">
      {text && (
        <Notice tone="danger" boxed role="alert">
          {text}
        </Notice>
      )}
    </div>
  );
}

function SubmitButton({ busy, busyLabel, children }) {
  return (
    <Button type="submit" variant="primary" size="lg" className="w-full" disabled={busy} aria-busy={busy || undefined}>
      {busy ? (
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" /> {busyLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

function LoginForm({ onAuthenticated, onForgot }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [state, run] = useSubmit();
  const submit = (event) => {
    event.preventDefault();
    if (!isMainlandMobile(phone)) return setPhoneError('请输入 11 位大陆手机号');
    setPhoneError('');
    run(async () => {
      const data = await login({ phone, password });
      await onAuthenticated(data.account);
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <PhoneField value={phone} onChange={setPhone} error={phoneError} autoFocus />
      <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
      <FormError text={state.error} />
      <SubmitButton busy={state.busy} busyLabel="正在登录">
        登录
      </SubmitButton>
      <button type="button" onClick={onForgot} className="self-center py-2 text-sm font-semibold text-ink-2 underline underline-offset-4">
        忘了密码？
      </button>
    </form>
  );
}

function RegisterForm({ registration, onAuthenticated }) {
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [phoneError, setPhoneError] = useState('');
  const [state, run] = useSubmit();
  const inviteId = useId();
  if (registration === 'closed') return <Notice tone="info">暂时不开放注册。已有账号可以直接登录。</Notice>;
  const submit = (event) => {
    event.preventDefault();
    if (!isMainlandMobile(phone)) return setPhoneError('请输入 11 位大陆手机号');
    setPhoneError('');
    run(async () => {
      const data = await register({ phone, password, inviteCode, acceptPrivacy: accepted, deviceProfile: deviceProfileProof() });
      await onAuthenticated(data.account, { recoveryCodes: data.recoveryCodes });
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <Notice tone="info">现在不发短信验证，手机号只当登录名。请记好密码，注册后还会给你一组恢复码。</Notice>
      <PhoneField value={phone} onChange={setPhone} error={phoneError} autoFocus />
      <PasswordField value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
      {registration === 'invite' && (
        <div className="flex flex-col gap-1.5">
          <label htmlFor={inviteId} className="text-sm font-bold text-ink-2">
            邀请码
          </label>
          <input
            id={inviteId}
            className={inputClass}
            autoComplete="off"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
            aria-describedby={`${inviteId}-hint`}
          />
          <span id={`${inviteId}-hint`} className="text-xs text-muted">
            现在是内测，注册要填邀请码
          </span>
        </div>
      )}
      <label className="flex items-start gap-2.5 text-sm text-ink-2">
        <input
          type="checkbox"
          className="mt-0.5 size-5 shrink-0 accent-primary-strong"
          checked={accepted}
          onChange={(event) => setAccepted(event.target.checked)}
        />
        <span>
          我已读过并同意
          <a href="/privacy" target="_blank" rel="noreferrer" className="mx-0.5 font-bold underline underline-offset-2">
            隐私说明
          </a>
          ：手机号只用来登录和找回账号。
        </span>
      </label>
      <FormError text={state.error} />
      <SubmitButton busy={state.busy} busyLabel="正在注册">
        注册并登录
      </SubmitButton>
    </form>
  );
}

function ForgotForm({ onAuthenticated, onBack }) {
  const [phone, setPhone] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [password, setPassword] = useState('');
  const [phoneError, setPhoneError] = useState('');
  const [state, run] = useSubmit();
  const codeId = useId();
  const submit = (event) => {
    event.preventDefault();
    if (!isMainlandMobile(phone)) return setPhoneError('请输入 11 位大陆手机号');
    setPhoneError('');
    run(async () => {
      const data = await resetPassword({ phone, recoveryCode, password });
      await onAuthenticated(data.account);
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <PhoneField value={phone} onChange={setPhone} error={phoneError} autoFocus />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={codeId} className="text-sm font-bold text-ink-2">
          恢复码
        </label>
        <input
          id={codeId}
          className={cn(inputClass, 'font-mono tracking-wider uppercase')}
          autoComplete="one-time-code"
          placeholder="XXXX-XXXX-XXXX"
          value={recoveryCode}
          onChange={(event) => setRecoveryCode(event.target.value)}
        />
      </div>
      <PasswordField label="新密码" value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
      <FormError text={state.error} />
      <SubmitButton busy={state.busy} busyLabel="正在重设">
        重设密码并登录
      </SubmitButton>
      <p className="text-sm text-muted">没有恢复码？联系我们，核实是你本人后，会给你一个一次性恢复码。</p>
      <button type="button" onClick={onBack} className="self-center py-2 text-sm font-semibold text-ink-2 underline underline-offset-4">
        返回登录
      </button>
    </form>
  );
}

export function RecoveryCodes({ codes = [], afterRegister = false, onConfirmed }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const listRef = useRef(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join('\n'));
      setCopied(true);
    } catch {
      // Clipboard can be blocked; the codes stay selectable on screen.
      const range = document.createRange();
      if (listRef.current) {
        range.selectNodeContents(listRef.current);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
    }
  };
  return (
    <div className="flex flex-col gap-4">
      {afterRegister && (
        <Notice tone="info" icon={Check}>
          注册好了。下面的恢复码只显示这一次，先存好再继续。
        </Notice>
      )}
      <ol ref={listRef} className="grid grid-cols-2 gap-2 rounded-card bg-canvas p-3" aria-label="恢复码">
        {codes.map((code) => (
          <li
            key={code}
            className="rounded-tile bg-white px-1.5 py-2 text-center font-mono text-sm font-semibold tracking-wide whitespace-nowrap text-ink sm:text-base sm:tracking-wider"
          >
            {code}
          </li>
        ))}
      </ol>
      <Button variant="outline" onClick={copy}>
        {copied ? <Check /> : <Copy />} {copied ? '已复制' : '复制全部'}
      </Button>
      <p className="text-sm text-muted">可以存进密码管理器、记事本或截图。别发给别人：拿到恢复码的人能重设你的密码。</p>
      <label className="flex items-start gap-2.5 text-sm font-semibold text-ink-2">
        <input type="checkbox" className="mt-0.5 size-5 shrink-0 accent-primary-strong" checked={saved} onChange={(event) => setSaved(event.target.checked)} />
        我已经存好了
      </label>
      <Button variant="primary" size="lg" className="w-full" disabled={!saved} onClick={onConfirmed}>
        继续
      </Button>
    </div>
  );
}
