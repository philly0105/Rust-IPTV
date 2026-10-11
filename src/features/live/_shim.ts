/**
 * Single seam between the live feature and its sibling slices (C8, C11, C16).
 * Tests replace this module with `test/fakes.tsx` via `vi.mock('../_shim')`.
 */
export { Button, Dialog, EmptyState, ErrorState, IconButton, Kbd, Skeleton, useToast } from '@/ui';
export { registerCommands, useShell, useShortcut } from '@/shell';
export { PlayerStage, RadioPlayer, playItem, playSource, useChannelZap, usePlayerStore } from '@/features/player';
