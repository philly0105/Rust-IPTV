/**
 * Every cross-feature import of the multi-view slice that tests replace goes through this
 * file or one of the two adapters (`stream.ts` for source lookup, `engine.ts` for the media
 * engines), so the slice has few seams to the shell (C16), the primitives (C11) and the
 * player (read only).
 */

export {
  Badge,
  Button,
  buttonClass,
  cn,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  isTypingTarget,
  Kbd,
  SearchInput,
  SegmentedControl,
  Select,
  Skeleton,
  SkeletonList,
  Tooltip,
  toast,
  useImageChain,
} from '@/ui';
export type { MenuAction } from '@/ui';
export { useShellHeader, useShortcut } from '@/shell';
export { usePlayerStore } from '@/features/player';
export { ensureUnlocked, requestPin } from './parentalGate';
