import { LoaderCircle } from 'lucide-react';
import type { ComponentPropsWithRef, ReactNode } from 'react';

import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon element, e.g. `<Play size={16} />`. */
  icon?: ReactNode;
  /** Trailing icon element. */
  iconRight?: ReactNode;
  /**
   * Shows a spinner, sets aria-busy, and ignores activation. Uses aria-disabled rather than
   * native `disabled` so keyboard focus stays on the button while it works.
   */
  loading?: boolean;
}

const base =
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium select-none ' +
  'disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 ' +
  'motion-safe:transition-[color,background-color,border-color,opacity,translate] motion-safe:duration-150 ' +
  // Pressed: a step darker than hover (per variant below) and, with motion allowed, a one-pixel push.
  'motion-safe:active:translate-y-px disabled:active:translate-y-0 aria-disabled:active:translate-y-0';

/** Exported for tests: each variant's rest, hover and pressed classes. */
export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:bg-accent-pressed active:shadow-none shadow-1',
  secondary: 'bg-surface-2 text-fg border border-border hover:bg-surface-3 active:bg-pressed',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 active:text-fg',
  danger: 'bg-danger text-bg hover:opacity-90 active:opacity-75',
};
const variants = BUTTON_VARIANTS;

const sizes: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-base',
};

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', className?: string): string {
  return cn(base, variants[variant], sizes[size], className);
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled,
  className,
  children,
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled}
      aria-disabled={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
      onClick={(e) => {
        // Blocks Enter/Space/click and implicit form submission while loading.
        if (loading) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
    >
      {loading ? <LoaderCircle aria-hidden size={16} className="motion-safe:animate-spin" /> : icon}
      {children}
      {iconRight}
    </button>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /** Accessible name; also shown as the native tooltip unless `title` is set. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** For toggle buttons. */
  pressed?: boolean;
}

const iconSizes: Record<ButtonSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-10 w-10',
  lg: 'h-12 w-12',
};

export function IconButton({
  label,
  icon,
  variant = 'ghost',
  size = 'md',
  pressed,
  className,
  title,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      className={cn(
        base,
        variants[variant],
        iconSizes[size],
        'px-0',
        pressed && 'bg-surface-3 text-fg',
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
}
