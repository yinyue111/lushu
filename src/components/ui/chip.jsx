import { cva } from 'class-variance-authority';
import { cn } from './cn';

export const chipVariants = cva('inline-flex items-center gap-1.5 rounded-chip font-semibold whitespace-nowrap [&_svg]:shrink-0', {
  variants: {
    tone: {
      neutral: 'bg-canvas text-ink-2',
      ok: 'bg-success-soft text-success-ink',
      // Reminder: calm amber (was bright lemon).
      warn: 'bg-warn-soft text-warn-ink',
      // Explanation / pending: blue-grey. `sky` kept as an alias for existing callers.
      info: 'bg-info-soft text-info-ink',
      sky: 'bg-info-soft text-info-ink',
      brand: 'bg-primary-soft text-primary-strong',
      primary: 'bg-primary-soft text-primary-strong',
      dark: 'bg-ink text-white',
      glass: 'border border-white/30 bg-white/20 text-white backdrop-blur-md',
      // Over photos only (needs the saturated fill to stay readable).
      lemon: 'bg-lemon text-ink',
      // Quiet status: no fill, a coloured dot carries the cue and the text the meaning.
      quiet: "bg-transparent px-0 text-muted before:size-1.5 before:rounded-full before:bg-current before:content-['']"
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
  return <span className={cn(chipVariants({ tone, size }), tone === 'quiet' && 'h-auto px-0', className)} {...props} />;
}
