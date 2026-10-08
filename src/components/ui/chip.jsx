import { cva } from 'class-variance-authority';
import { cn } from './cn';

export const chipVariants = cva('inline-flex items-center gap-1.5 rounded-chip font-semibold whitespace-nowrap [&_svg]:shrink-0', {
  variants: {
    tone: {
      neutral: 'bg-canvas text-ink-2',
      ok: 'bg-success-soft text-success-ink',
      warn: 'bg-lemon-soft text-lemon-ink',
      sky: 'bg-sky-soft text-sky-ink',
      primary: 'bg-primary-soft text-primary-strong',
      dark: 'bg-ink text-white',
      glass: 'border border-white/30 bg-white/20 text-white backdrop-blur-md',
      lemon: 'bg-lemon text-ink'
    },
    size: {
      sm: 'h-6 px-2.5 text-[12.5px] [&_svg]:size-3.5',
      md: 'h-7 px-3 text-sm [&_svg]:size-[15px]'
    }
  },
  defaultVariants: { tone: 'neutral', size: 'md' }
});

/** @param {Record<string, any>} props */
export function Chip({ className, tone, size, ...props }) {
  return <span className={cn(chipVariants({ tone, size }), className)} {...props} />;
}
