import { useCallback, useEffect, useId, useState } from 'react';

export function Page({ title, description = '', actions = null, children }) {
  return (
    <section aria-labelledby="page-title" className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 id="page-title" className="text-xl font-semibold text-ink">
            {title}
          </h1>
          {description && <p className="mt-1 text-sm text-muted">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Card({ title = '', children, className = '' }) {
  return (
    <section className={`rounded-lg border border-line bg-paper p-4 ${className}`} aria-label={typeof title === 'string' ? title : undefined}>
      {title && <h2 className="mb-3 text-base font-semibold text-ink">{title}</h2>}
      {children}
    </section>
  );
}

export function Button({ variant = 'default', className = '', ...props }) {
  const styles = {
    default: 'border border-line-strong bg-paper text-ink hover:bg-canvas',
    primary: 'bg-ink text-white hover:bg-ink-2',
    danger: 'bg-danger text-white hover:opacity-90'
  };
  return (
    <button
      type="button"
      className={`inline-flex min-h-9 items-center gap-1 rounded-md px-3 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

export function Field({ label, hint = '', children }) {
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export const inputClass = 'w-full rounded-md border border-line-strong bg-paper px-3 py-2 text-sm text-ink';

export function Notice({ tone = 'info', children }) {
  const styles = {
    info: 'border-line bg-canvas text-ink-2',
    error: 'border-danger bg-paper text-danger',
    ok: 'border-success bg-paper text-success-ink',
    warn: 'border-warn bg-paper text-warn-ink'
  };
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-3 py-2 text-sm ${styles[tone]}`}>
      {children}
    </p>
  );
}

/** Loads data on mount and on demand. */
export function useLoad(loader, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const load = useCallback(loader, deps);
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    try {
      setState({ loading: false, data: await load(), error: '' });
    } catch (error) {
      setState({ loading: false, data: null, error: error.message });
    }
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { ...state, reload };
}

/**
 * Every write asks for a reason (PRD: audit records who / what / why). Renders an inline form; resolves
 * to the action's result or shows the server's error.
 */
export function ReasonAction({ label, confirmLabel = '确认', variant = 'default', onSubmit, extra = null, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const id = useId();
  if (!open)
    return (
      <span className="inline-flex flex-col gap-1">
        <Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
          {label}
        </Button>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
      </span>
    );
  return (
    <form
      className="w-full space-y-2 rounded-md border border-line bg-canvas p-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const text = await onSubmit(reason.trim());
          setMessage({ tone: 'ok', text: typeof text === 'string' ? text : `${label}：已完成` });
          setOpen(false);
          setReason('');
        } catch (error) {
          setMessage({ tone: 'error', text: error.message });
        } finally {
          setBusy(false);
        }
      }}
    >
      {extra}
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}的原因（必填，至少 4 个字，会写进审计）
      </label>
      <input id={id} className={inputClass} value={reason} minLength={4} required onChange={(e) => setReason(e.target.value)} />
      {message?.tone === 'error' && <Notice tone="error">{message.text}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" variant={variant === 'default' ? 'primary' : variant} disabled={busy || reason.trim().length < 4}>
          {busy ? '处理中…' : confirmLabel}
        </Button>
        <Button onClick={() => setOpen(false)}>取消</Button>
      </div>
    </form>
  );
}

export function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${date.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）`;
}

export const percent = (value) => (value == null ? '暂无数据' : `${(value * 100).toFixed(1)}%`);
export const usd = (value) => (value == null ? '未知' : `$${Number(value).toFixed(4)}`);

export function Table({ caption, columns, rows, empty = '暂无数据' }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line text-muted">
            {columns.map((c) => (
              <th key={c.key} scope="col" className="px-2 py-2 font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-2 py-4 text-muted">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((row, i) => (
              <tr key={row.id ?? i} className="border-b border-line align-top">
                {columns.map((c) => (
                  <td key={c.key} className="px-2 py-2 text-ink-2">
                    {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
