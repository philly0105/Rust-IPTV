/**
 * Every cross-feature import of the sports page and its components goes through this file, so the
 * slice has one seam to the primitives, the shell, Live's channel and guide helpers, recording and
 * the player. The data and matching modules (lib/, hooks/) import the few Live, parental and shell
 * helpers they need from those modules directly, so they and their tests never load the UI kit.
 *
 * Shell hooks come from their own modules rather than the `@/shell` barrel: the barrel pulls in the
 * whole layout, and tests then drive the real shortcut registry and header store. The player is
 * never imported statically: Watch and Replay load it on the press (performance audit SH-2), so
 * the page's chunk carries none of the player's UI (tools/check-bundle.mjs).
 */

export {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LivePill,
  MetaLine,
  Page,
  SectionHeader,
  Skeleton,
  Tabs,
  buttonClass,
  cn,
  errorDescription,
  tabPanelProps,
  useToast,
} from '@/ui';
export { useShell } from '@/shell/store';
export { useSettingsValue } from '@/shell/useSettings';
export { useVisibleSources } from '@/shell/useVisibleSources';
export { useNow } from '@/features/live/hooks/useNow';
export { useDisplayPrefs } from '@/features/live/hooks/useDisplayPrefs';
export { displayChannelName } from '@/features/live/lib/channelName';
export { canCatchUp, formatClock, formatDay, formatTimeRange, ms } from '@/features/live/lib/epgTime';
export { ChannelLogo } from '@/features/live/components/ChannelLogo';
export { useRecordingCapabilities, useScheduleActions, useScheduleIndex } from '@/features/recording/hooks';
export { markFor } from '@/features/recording/lib/schedule';
export { openExternal } from '@/features/settings/lib/links';

/** Live's playChannel and playCatchup, which load the player: only ever behind a press. */
export const loadPlayback = () => import('@/features/live/lib/playback');
/** The player store, for the zap context after a Watch. */
export const loadPlayerStore = () => import('@/features/player/store');
