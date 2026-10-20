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
  Skeleton,
  SkeletonGrid,
  SkeletonList,
  Tabs,
  Toggle,
  errorDescription,
  useToast,
} from '@/ui';
export { useShell, useShortcut } from '@/shell';
export { useMediaQuery } from '@/features/live/hooks/useMediaQuery';
export { PlayerStage, playItem, playSource, usePlayerStore } from '@/features/player';
// recording:
export {
  clockDuration,
  clockTime,
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
