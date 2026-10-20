/**
 * Every cross-feature import of the library slice goes through this file, so
 * the slice has one seam to the shell (C16), the primitives (C11) and the
 * player (C8).
 */

export {
  Badge,
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  IconButton,
  Kbd,
  Page,
  Poster,
  ProgressBar,
  SearchInput,
  SectionHeader,
  Skeleton,
  SkeletonGrid,
  SkeletonList,
  Tabs,
  Toggle,
  errorDescription,
  useScaledPx,
  useToast,
} from '@/ui';
export { useShell, useShortcut } from '@/shell';
// From its own module, not the barrel: the shared settings query alone (tests stub the barrel).
export { useSettings } from '@/shell/useSettings';
export { useMediaQuery } from '@/features/live/hooks/useMediaQuery';
export { PlayerStage, playItem, playSource, usePlayerStore } from '@/features/player';
// recording:
export {
  clockDuration,
  clockRange,
  clockTime,
  dayHeading,
  dayLabel,
  elapsedSeconds,
  finishedRecordings,
  groupByDay,
  recordingFraction,
  recordingNow,
  recordingStartedAt,
  stoppedEarly,
  upcoming,
  useCancelPending,
  useRecordingCapabilities,
  useRecordingProgress,
  useRecordings,
  useReminders,
  useScheduleActions,
  // Run 2 C5: series recording rules, listed on the Scheduled page.
  RecordingRulesPanel,
  useRecordingRules,
  // Loop 1: confirm before stopping a running recording.
  StopRecordingDialog,
  type UpcomingEntry,
} from '@/features/recording';
// vod: the catalogue's detail hero and facts sheet, so an offline title looks like the same title
// in Movies or Series (My Videos detail).
export { DetailHero, DetailHeroSkeleton, HERO_BACK, HeroActionGroup } from '@/features/vod/components/detail/DetailHero';
export { AboutSection } from '@/features/vod/components/detail/AboutSection';
export { useHeroTitleInView } from '@/features/vod/hooks/useHeroTitleInView';
export type { DetailModel } from '@/features/vod/lib/merge';
