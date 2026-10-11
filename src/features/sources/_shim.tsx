/**
 * Adapter over U1's `@/ui` (C11) and `@/shell` (C16). Everything is a straight
 * re-export except `Select` (this slice calls `onChange(value)`; U1 uses
 * `onValueChange`) and `ProgressBar` (an undefined value means indeterminate).
 * The integration agent can inline these two and point imports at `@/ui` /
 * `@/shell`, then delete this file.
 */

import type { ComponentProps } from 'react';

import { ProgressBar as UiProgressBar, Select as UiSelect, type SelectProps } from '@/ui';

export {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Kbd,
  Skeleton,
  SkeletonList,
  Tabs,
  Textarea,
  Toggle,
  Tooltip,
  comboKeys,
  useToast,
} from '@/ui';
export type { ToastOptions } from '@/ui';
export { shortcutRegistry, useShell, useShortcut, useShortcutList } from '@/shell';
export type { HeaderState as HeaderSpec, ShortcutInfo } from '@/shell';

export function Select({
  onChange,
  ...rest
}: Omit<SelectProps, 'onChange' | 'onValueChange'> & { onChange: (value: string) => void }) {
  return <UiSelect {...rest} onValueChange={onChange} />;
}

export function ProgressBar({
  value,
  ...rest
}: Omit<ComponentProps<typeof UiProgressBar>, 'value' | 'indeterminate'> & { value?: number }) {
  return <UiProgressBar {...rest} value={value ?? 0} indeterminate={value === undefined} />;
}
