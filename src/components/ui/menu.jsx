import { DropdownMenu } from 'radix-ui';
import { cn } from './cn';

/** Non-modal so the rest of the page is not aria-hidden while a small menu is open. */
export function Menu(props) {
  return <DropdownMenu.Root modal={false} {...props} />;
}
export const MenuTrigger = DropdownMenu.Trigger;

/** @param {{ className?: string, children?: any, align?: 'start' | 'center' | 'end', [key: string]: any }} props */
export function MenuContent({ className, children, align = 'end', ...props }) {
  return (
    <>
      <DropdownMenu.Content
        align={align}
        sideOffset={8}
        className={cn('z-[2100] min-w-52 rounded-card border border-line bg-white p-1.5 shadow-pop', className)}
        {...props}
      >
        {children}
      </DropdownMenu.Content>
    </>
  );
}

/** @param {Record<string, any>} props */
export function MenuItem({ className, ...props }) {
  return (
    <DropdownMenu.Item
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-copy font-semibold text-ink outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-canvas [&_svg]:size-[18px] [&_svg]:text-muted',
        className
      )}
      {...props}
    />
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-line" />;
}
