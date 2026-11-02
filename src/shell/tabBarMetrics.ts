/**
 * The phone tab bar's height, apart from TabBar.tsx (F1-7): the shell's skeleton and the
 * --shell-bottom-inset it sets read these on every launch, while the bar itself loads only below
 * 640 px.
 */

/** The bar's own height, in rem against the 15 px root: it follows the UI scale, not density. */
export const TAB_BAR_HEIGHT = 'calc(56rem / 15)';
/** What overlays lift by while the bar shows: its height plus the home indicator's safe area. */
export const SHELL_BOTTOM_INSET = `calc(${TAB_BAR_HEIGHT} + env(safe-area-inset-bottom, 0px))`;
