/**
 * Shell hooks (SPEC C16) and the layout route component (C7).
 */

export { useShell, useShellHeader, useShellStore } from './store';
export type { HeaderSearch, HeaderState, ShellApi } from './store';
export { registerCommands, useCommands, useCommandList, commandRegistry } from './commands';
export type { Command } from './commands';
export { useShortcut, useShortcutList, shortcutRegistry, parseCombo, normalizeCombo, matches as comboMatches } from './shortcuts';
export type { ShortcutInfo, ShortcutOptions } from './shortcuts';
export { railLinks, railLinkIds, sourceBasePath } from './railLinks';
export type { RailLink, RailLinkId, RailLinkOptions } from './railLinks';
export {
  useTheme,
  persistTheme,
  resolveTheme,
  useAppearance,
  previewAppearance,
  sanitizeAppearance,
  clampUiScale,
  applyAppearanceToDocument,
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
} from './theme';
export type { Appearance, ResolvedTheme, ThemeApi } from './theme';
export { useSettings } from './useSettings';
export { ShellLayout, openPalette, openShortcutHelp } from './ShellLayout';
export { DOCUMENTED_SHORTCUTS, SHORTCUT_AREA_KEYS, groupShortcuts } from './ShortcutOverlay';
