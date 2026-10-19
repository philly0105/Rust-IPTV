/**
 * Every cross-feature import of the stats page goes through this file, so the
 * slice has one seam to the primitives, the shell and the player.
 *
 * Shell hooks come from their own modules rather than the `@/shell` barrel:
 * the barrel pulls in the whole layout, and tests then drive the real
 * shortcut registry and header store.
 */

export { Button, Dialog, EmptyState, ErrorState, IconButton, Poster, Skeleton, Tabs, buttonClass, cn, errorDescription, useToast } from '@/ui';
export { useShell } from '@/shell/store';
export { useShortcut } from '@/shell/shortcuts';
export { useVisibleSources } from '@/shell/useVisibleSources';
export { itemPath } from '@/shell/dashboard/cards';
export { playItem } from '@/features/player/store';
