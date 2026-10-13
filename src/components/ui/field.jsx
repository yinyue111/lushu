import { cn } from './cn';

export const inputClass =
  'block w-full rounded-tile border border-line-strong bg-white px-3.5 py-2.5 text-base text-ink placeholder:text-muted-2 focus:border-sky focus:ring-3 focus:ring-sky/20 focus:outline-none';

/** Form label + control + optional hint. Label uses the meta role for a calm Operate hierarchy. */
export function Field({ label, hint = undefined, className = undefined, children }) {
  return (
    <label className={cn('flex flex-col gap-1.5', className)}>
      <span className="text-meta font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-meta leading-snug text-muted">{hint}</span>}
    </label>
  );
}
