import { cn } from './cn';

export const inputClass =
  'block w-full rounded-tile border border-line-strong bg-white px-3.5 py-2.5 text-base text-ink placeholder:text-muted-2 focus:border-sky focus:ring-3 focus:ring-sky/20 focus:outline-none';

/** @param {Record<string, any>} props */
export function Field({ label, hint, className, children }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-sm font-bold text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </label>
  );
}
