import { cva } from 'class-variance-authority';
import { cn } from './cn';

// Primary (filled) buttons use primary-strong (#C7432D) behind white text so the
// label keeps >= 4.5:1 contrast; the brighter #E8553D is used for glow/shadow only.
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-bold transition-[transform,box-shadow,background-color] duration-300 ease-(--ease-spring) select-none active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'bg-primary-strong text-white shadow-cta hover:-translate-y-0.5 hover:bg-[#b93c27]',
        dark: 'bg-ink text-white shadow-pop hover:-translate-y-0.5',
        light: 'bg-white/95 text-ink shadow-card hover:-translate-y-0.5',
        soft: 'bg-canvas text-ink hover:bg-line',
        outline: 'border border-line-strong bg-white text-ink hover:border-ink/40',
        ghost: 'bg-transparent text-ink hover:bg-canvas',
        glass: 'border border-white/35 bg-white/15 text-white backdrop-blur hover:bg-white/25',
        danger: 'bg-white text-danger border border-danger/30 hover:bg-primary-soft'
      },
      size: {
        sm: 'h-9 rounded-chip px-3.5 text-sm [&_svg]:size-4',
        md: 'h-11 rounded-chip px-5 text-[15px] [&_svg]:size-[18px]',
        lg: 'h-14 rounded-chip px-6 text-lg [&_svg]:size-[22px]',
        icon: 'size-11 rounded-full [&_svg]:size-5',
        'icon-sm': 'size-9 rounded-full [&_svg]:size-4'
      }
    },
    defaultVariants: { variant: 'soft', size: 'md' }
  }
);

// React 19 passes `ref` as a regular prop, so no forwardRef is needed.
/** @param {Record<string, any>} props */
export function Button({ className, variant, size, type = 'button', ...props }) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
