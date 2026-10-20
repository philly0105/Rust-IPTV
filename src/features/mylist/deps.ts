/**
 * Every cross-feature import of the My List slice goes through this file, so
 * the slice has one seam to the primitives (C11), the shell (C16), the
 * dashboard rail kit and the library's list and watched helpers.
 *
 * Shell hooks come from their own modules rather than the `@/shell` barrel:
 * the barrel pulls in the whole layout, and tests then drive the real
 * shortcut registry and header store.
 */

export { Button, EmptyState, ErrorState, IconButton, Page, Poster, SearchInput, Select, Tabs, Toggle, Tooltip, buttonClass, cn, useToast } from '@/ui';
export type { MenuAction } from '@/ui';
export { useShell } from '@/shell/store';
export { useShortcut } from '@/shell/shortcuts';
export { useSettings } from '@/shell/useSettings';
export { useVisibleSources } from '@/shell/useVisibleSources';
export { DashboardRail } from '@/shell/dashboard/DashboardRail';
export { usePendingRemovals } from '@/features/sources/lib/pendingRemoval';
export { VirtualRows } from '@/features/library/components/VirtualRows';
export { captureWatched, undoWatched } from '@/features/library/lib/watchedUndo';
export { invalidateWatched } from '@/features/vod/lib/watchedQueries';
