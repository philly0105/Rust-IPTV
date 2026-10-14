/**
 * Every cross-feature import of the lists slice goes through this file, so the
 * slice has one seam to the primitives, the shell, the dashboard rail kit, the
 * Live channel list and the player.
 *
 * Shell hooks come from their own modules rather than the `@/shell` barrel:
 * the barrel pulls in the whole layout, and tests then drive the real
 * shortcut registry and header store.
 */

export {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Input,
  Skeleton,
  Toggle,
  buttonClass,
  cn,
  toast,
  useRowHeight,
  useToast,
} from '@/ui';
export type { MenuAction } from '@/ui';
export { useShell } from '@/shell/store';
export { useShortcut } from '@/shell/shortcuts';
export { useVisibleSources } from '@/shell/useVisibleSources';
export { DashboardRail } from '@/shell/dashboard/DashboardRail';
export { ChannelCard } from '@/shell/dashboard/cards';
export { ChannelList } from '@/features/live/components/ChannelList';
export { ChannelLogo } from '@/features/live/components/ChannelLogo';
export { CHANNEL_ROW_HEIGHT, CHANNEL_ROW_SPACING, RowSkeleton } from '@/features/live/components/ChannelRow';
export { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
export { CHANNEL_PAGE_SIZE, type PagedChannels } from '@/features/live/hooks/usePagedChannels';
export { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
export { useMediaQuery } from '@/features/live/hooks/useMediaQuery';
export { useNow } from '@/features/live/hooks/useNow';
export { displayChannelName } from '@/features/live/lib/channelName';
export { playChannel } from '@/features/live/lib/playback';
export { PlayerStage, usePlayerStore } from '@/features/player';
export { sourceKindOf } from '@/features/player/store';
