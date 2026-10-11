/**
 * Single import point for shell/ui services the player uses. Points at U1's modules
 * directly (not the barrels) to avoid an import cycle: the shell layout imports the player.
 */
export { useShortcut } from '@/shell/shortcuts';
export { useToast } from '@/ui/Toast';
