import { Info, TriangleAlert } from 'lucide-react';
import { cn } from './cn';

const TONES = {
  warn: { icon: TriangleAlert, iconClass: 'text-warn', box: 'bg-warn-soft' },
  info: { icon: Info, iconClass: 'text-info', box: 'bg-info-soft' },
  danger: { icon: TriangleAlert, iconClass: 'text-danger', box: 'bg-primary-soft' }
};

/**
 * Calm reminder line (polish pass): neutral text, the coloured icon is the cue.
 * `boxed` adds a soft tinted background for standalone notices.
 * @param {{ tone?: 'warn' | 'info' | 'danger', boxed?: boolean, className?: string, children?: any, icon?: any } & Record<string, any>} props
 */
export function Notice({ tone = 'warn', boxed = false, className, children, icon, ...props }) {
  const config = TONES[tone] ?? TONES.warn;
  const Icon = icon ?? config.icon;
  return (
    <p className={cn('flex items-start gap-1.5 text-sm leading-relaxed text-ink-2', boxed && cn('rounded-tile px-3 py-2', config.box), className)} {...props}>
      <Icon className={cn('mt-[3px] size-4 shrink-0', config.iconClass)} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
