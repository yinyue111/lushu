import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui/button';
import { inputClass } from '../ui/field';
import { Notice } from '../ui/notice';
import { cn } from '../ui/cn';
import { login, register, resetPassword, resetPasswordWithEmail, sendRegisterCode, sendResetCode } from '../../lib/accountApi';
import { deviceProfileProof } from '../../lib/account';
import { authErrorCopy, isEmail, isMainlandMobile, PASSWORD_HINT } from '../../lib/accountCopy';

const TITLES = { login: '登录', register: '注册账号', forgot: '重设密码', codes: '存好你的恢复码' };

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
  emailVerificationRequired = true,
  onAuthenticated,
  onCodesConfirmed,
  onClose
}) {
  const [view, setView] = useState(initialView);
  const description =
    view === 'codes'
      ? '忘了密码时，用其中一个就能重设。每个只能用一次。'
      : reason ||
        (view === 'forgot' ? '用邮箱收验证码，或者用注册时拿到的恢复码，再设一个新密码。' : '浏览路线不用登录。导入攻略、生成路书要用到 AI，所以需要账号。');
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
        {view === 'register' && (
          <RegisterForm registration={registration} emailVerificationRequired={emailVerificationRequired} onAuthenticated={onAuthenticated} />
        )}
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

function PhoneField({ value, onChange, error, autoFocus = false, optional = false }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        手机号{optional && <span className="ml-1 font-normal text-muted">（选填，也能用来登录）</span>}
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

function TextField({ label, value, onChange, error = '', hint = '', autoFocus = false, ...inputProps }) {
  const id = useId();
  const describedBy = [error ? `${id}-error` : '', hint ? `${id}-hint` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        {label}
      </label>
      <input
        id={id}
        className={cn(inputClass, error && 'border-danger')}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        {...inputProps}
      />
      {hint && (
        <span id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className="text-sm font-semibold text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

function EmailField(props) {
  return <TextField label="邮箱" type="email" inputMode="email" autoComplete="email" maxLength={254} placeholder="name@example.com" {...props} />;
}

/**
 * Seconds left before another code can be requested.
 * @returns {[number, (value: number | ((current: number) => number)) => void]}
 */
function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return undefined;
    const timer = window.setTimeout(() => setLeft((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [left]);
  return [left, setLeft];
}

/**
 * Code input with a "send code" button next to it.
 * @param {{ value: string, onChange: (v: string) => void, onSend: () => Promise<any>, canSend: boolean, sentTo: string, label?: string }} props
 */
export function EmailCodeField({ value, onChange, onSend, canSend, sentTo, label = '邮箱验证码' }) {
  const id = useId();
  const [left, setLeft] = useCountdown();
  const [state, setState] = useState({ busy: false, error: '' });
  const send = async () => {
    setState({ busy: true, error: '' });
    try {
      await onSend();
      setLeft(60);
      setState({ busy: false, error: '' });
    } catch (error) {
      const retry = Number(error?.retryAfterSeconds ?? error?.data?.retryAfterSeconds);
      if (error?.code === 'EMAIL_CODE_TOO_SOON' && retry > 0) setLeft(Math.min(retry, 3600));
      setState({ busy: false, error: authErrorCopy(error) });
    }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-bold text-ink-2">
        {label}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          className={cn(inputClass, 'min-w-0 flex-1 font-mono tracking-[0.3em]')}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="6 位数字"
          value={value}
          onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 6))}
          aria-describedby={`${id}-status`}
        />
        <Button
          type="button"
          variant="outline"
          className="h-auto shrink-0 px-3"
          disabled={!canSend || state.busy || left > 0}
          onClick={send}
          aria-busy={state.busy || undefined}
        >
          {state.busy ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {left > 0 ? `${left} 秒后重发` : sentTo ? '重新发送' : '发验证码'}
        </Button>
      </div>
      <span id={`${id}-status`} role="status" aria-live="polite" className={cn('text-xs', state.error ? 'font-semibold text-danger' : 'text-muted')}>
        {state.error || (sentTo ? `验证码已发到 ${sentTo}，15 分钟内有效。没收到？看看垃圾邮件。` : '')}
      </span>
    </div>
  );
}

function LoginForm({ onAuthenticated, onForgot }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [identifierError, setIdentifierError] = useState('');
  const [state, run] = useSubmit();
  const submit = (event) => {
    event.preventDefault();
    const text = identifier.trim();
    if (text.includes('@') || text.includes('＠') ? !isEmail(text) : !isMainlandMobile(text)) {
      return setIdentifierError('请输入邮箱，或 11 位大陆手机号');
    }
    setIdentifierError('');
    run(async () => {
      const data = await login({ identifier: text, password });
      await onAuthenticated(data.account);
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        label="邮箱或手机号"
        value={identifier}
        onChange={setIdentifier}
        error={identifierError}
        autoFocus
        type="text"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
        placeholder="邮箱，或 11 位手机号"
      />
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

function RegisterForm({ registration, emailVerificationRequired, onAuthenticated }) {
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [errors, setErrors] = useState({ email: '', phone: '', code: '' });
  const [state, run] = useSubmit();
  if (registration === 'closed') return <Notice tone="info">暂时不开放注册。已有账号可以直接登录。</Notice>;
  const emailOk = isEmail(email);
  const sendCode = async () => {
    if (!emailOk) {
      setErrors((current) => ({ ...current, email: '邮箱格式不对，检查一下' }));
      throw Object.assign(new Error('先填好邮箱'), { status: 400 });
    }
    setErrors((current) => ({ ...current, email: '' }));
    const data = await sendRegisterCode(email.trim());
    setSentTo(data.emailMasked || email.trim());
  };
  const submit = (event) => {
    event.preventDefault();
    const next = {
      email: emailOk ? '' : '邮箱格式不对，检查一下',
      phone: phone.trim() && !isMainlandMobile(phone) ? '请输入 11 位大陆手机号，或者留空' : '',
      code: emailVerificationRequired && emailCode.length !== 6 ? '请填邮箱收到的 6 位验证码' : ''
    };
    setErrors(next);
    if (next.email || next.phone || next.code) return;
    run(async () => {
      const data = await register({
        email: email.trim(),
        emailCode,
        phone: phone.trim(),
        password,
        inviteCode,
        acceptPrivacy: accepted,
        deviceProfile: deviceProfileProof()
      });
      await onAuthenticated(data.account, { recoveryCodes: data.recoveryCodes });
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <EmailField value={email} onChange={setEmail} error={errors.email} autoFocus hint="用来登录、收验证码和找回密码" />
      <EmailCodeField value={emailCode} onChange={setEmailCode} onSend={sendCode} canSend={Boolean(email.trim())} sentTo={sentTo} />
      {errors.code && <span className="-mt-3 text-sm font-semibold text-danger">{errors.code}</span>}
      <PasswordField value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
      <PhoneField value={phone} onChange={setPhone} error={errors.phone} optional />
      {registration === 'invite' && (
        <TextField label="邀请码" value={inviteCode} onChange={setInviteCode} autoComplete="off" hint="现在是内测，注册要填邀请码" />
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
          ：邮箱用来登录、收验证码和找回账号，手机号只当登录名。
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
  const [method, setMethod] = useState('email');
  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="重设方式" className="grid grid-cols-2 rounded-full bg-canvas p-1">
        {[
          ['email', '用邮箱验证码'],
          ['recovery', '用恢复码']
        ].map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={method === id}
            onClick={() => setMethod(id)}
            className={cn('h-10 rounded-full text-copy font-bold', method === id ? 'bg-white text-ink shadow-card' : 'text-muted')}
          >
            {label}
          </button>
        ))}
      </div>
      {method === 'email' ? <ForgotByEmail onAuthenticated={onAuthenticated} /> : <ForgotByRecovery onAuthenticated={onAuthenticated} />}
      <button type="button" onClick={onBack} className="self-center py-2 text-sm font-semibold text-ink-2 underline underline-offset-4">
        返回登录
      </button>
    </div>
  );
}

function ForgotByEmail({ onAuthenticated }) {
  const [email, setEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState('');
  const [state, run] = useSubmit();
  const sendCode = async () => {
    if (!isEmail(email)) {
      setEmailError('邮箱格式不对，检查一下');
      throw Object.assign(new Error('先填好邮箱'), { status: 400 });
    }
    setEmailError('');
    const data = await sendResetCode(email.trim());
    setSentTo(data.emailMasked || email.trim());
  };
  const submit = (event) => {
    event.preventDefault();
    if (!isEmail(email)) return setEmailError('邮箱格式不对，检查一下');
    setEmailError('');
    run(async () => {
      if (!/^\d{6}$/.test(emailCode)) throw Object.assign(new Error('请填邮箱收到的 6 位验证码'), { status: 400 });
      const data = await resetPasswordWithEmail({ email: email.trim(), emailCode, password });
      await onAuthenticated(data.account);
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <EmailField value={email} onChange={setEmail} error={emailError} autoFocus hint="填账号绑定的邮箱。没绑定邮箱的账号，请用恢复码" />
      <EmailCodeField value={emailCode} onChange={setEmailCode} onSend={sendCode} canSend={Boolean(email.trim())} sentTo={sentTo} />
      <PasswordField label="新密码" value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
      <FormError text={state.error} />
      <SubmitButton busy={state.busy} busyLabel="正在重设">
        重设密码并登录
      </SubmitButton>
      <p className="text-sm text-muted">重设后，其他设备上的登录会退出。</p>
    </form>
  );
}

function ForgotByRecovery({ onAuthenticated }) {
  const [identifier, setIdentifier] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [password, setPassword] = useState('');
  const [identifierError, setIdentifierError] = useState('');
  const [state, run] = useSubmit();
  const submit = (event) => {
    event.preventDefault();
    const text = identifier.trim();
    if (text.includes('@') || text.includes('＠') ? !isEmail(text) : !isMainlandMobile(text)) return setIdentifierError('请输入邮箱，或 11 位大陆手机号');
    setIdentifierError('');
    run(async () => {
      const data = await resetPassword({ identifier: text, recoveryCode, password });
      await onAuthenticated(data.account);
    });
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <TextField
        label="邮箱或手机号"
        value={identifier}
        onChange={setIdentifier}
        error={identifierError}
        autoFocus
        type="text"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={254}
      />
      <TextField
        label="恢复码"
        value={recoveryCode}
        onChange={setRecoveryCode}
        className={cn(inputClass, 'font-mono tracking-wider uppercase')}
        autoComplete="off"
        placeholder="XXXX-XXXX-XXXX"
      />
      <PasswordField label="新密码" value={password} onChange={setPassword} autoComplete="new-password" hint={PASSWORD_HINT} />
      <FormError text={state.error} />
      <SubmitButton busy={state.busy} busyLabel="正在重设">
        重设密码并登录
      </SubmitButton>
      <p className="text-sm text-muted">没有恢复码，也没绑定邮箱？联系我们，核实是你本人后，会给你一个一次性恢复码。</p>
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
