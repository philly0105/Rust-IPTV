/**
 * Single import point for `@/ui` (C11) and `@/shell` (C16) inside the VOD
 * feature. U1 has published both barrels, so this is plain re-exports; it
 * can be inlined (imports pointed at `@/ui` / `@/shell`) at any time.
 */

export {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Poster,
  ProgressBar,
  SearchInput,
  Select,
  Skeleton,
  SkeletonGrid,
  Tabs,
  VirtualGrid,
  VirtualList,
  buttonClass,
  cn,
  useToast,
} from '@/ui';
export { useShell } from '@/shell';
export type { HeaderSearch } from '@/shell';
