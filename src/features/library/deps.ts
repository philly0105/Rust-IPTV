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
  Poster,
  ProgressBar,
  SearchInput,
  Skeleton,
  SkeletonGrid,
  SkeletonList,
  Tabs,
  Toggle,
  useToast,
} from '@/ui';
export { useShell, useShortcut } from '@/shell';
export { PlayerStage, playItem, playSource, usePlayerStore } from '@/features/player';
// recording:
export {
  clockDuration,
  elapsedSeconds,
  finishedRecordings,
  groupByDay,
  recordingFraction,
  recordingNow,
  upcoming,
  useRecordingCapabilities,
  useRecordingProgress,
  useRecordings,
  useReminders,
  useScheduleActions,
  type UpcomingEntry,
} from '@/features/recording';
