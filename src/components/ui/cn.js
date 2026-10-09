import { clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Named font sizes from src/styles/tailwind.css (--text-*). Without this,
// tailwind-merge treats e.g. `text-meta` as a text colour and drops it when a
// colour such as `text-muted` appears in the same cn() call.
export const TYPE_SCALE = [
  'tag',
  'meta',
  'copy',
  'lead',
  'title-xs',
  'title-sm',
  'title',
  'display-sm',
  'display',
  'display-md',
  'display-lg',
  'display-xl',
  'watermark',
  'watermark-lg'
];

const twMerge = extendTailwindMerge({ extend: { theme: { text: TYPE_SCALE } } });

/** Merge conditional class names and resolve Tailwind conflicts. */
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
