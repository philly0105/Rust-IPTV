import type { CSSProperties } from 'react';

import { cn } from '../cn';

/**
 * The frame of a player menu that opens from the bar (the options menu, the channel history): a
 * popover over the picture, growing up from just above the bar, or in a player too short for that
 * (a phone's inline player, the mini player) a sheet from the bottom of the screen. Controls
 * measures the room and decides (`PlayerPopup`); the menus draw the frame it hands them.
 */

/**
 * Below this much room above the bar (CSS px: the menu's header and about three rows), a menu
 * opens as a sheet. A phone's inline player leaves 60 to 80 px; the desktop's default stage, over
 * 200.
 */
export const SHEET_BELOW_PX = 160;

export interface MenuFit {
  /** The height the popover may take, from just above the bar up to the top of the player; null until measured. */
  room: number | null;
  /** Too little room above the bar: a sheet from the bottom of the screen instead. */
  sheet: boolean;
}

/** Not measured (a menu rendered on its own, or before layout): a popover with its own cap. */
export const UNMEASURED: MenuFit = { room: null, sheet: false };

/**
 * The frame's classes. `popover`: the popover's width and its height cap in CSS (the style from
 * `menuFrameStyle` tightens the cap to the room). The sheet spans a phone's width above the home
 * indicator; on a wider screen it is a panel in the bottom corner. No blur behind the sheet: it
 * is large, and opaque (`player-sheet`, player.css), so the page never shows through.
 */
export function menuFrameClass(fit: MenuFit, popover: string): string {
  return cn(
    'player-glass-strong player-glass-edge overflow-y-auto overscroll-contain p-1.5',
    fit.sheet
      ? 'player-sheet fixed inset-x-0 bottom-0 z-[60] max-h-[min(80dvh,560px)] rounded-t-xl border-t pb-[max(0.375rem,env(safe-area-inset-bottom))] motion-safe:animate-sheet-in sm:inset-x-auto sm:end-4 sm:bottom-4 sm:w-80 sm:rounded-xl sm:border sm:pb-1.5'
      : cn('glass-blur rounded-lg border motion-safe:animate-pop-in', popover),
  );
}

/** The popover's height: `caps` (CSS lengths, as in its class) and the room above it, whichever is least. */
export function menuFrameStyle(fit: MenuFit, caps: string): CSSProperties | undefined {
  return !fit.sheet && fit.room !== null ? { maxHeight: `min(${caps}, ${fit.room}px)` } : undefined;
}

/**
 * Where a player menu mounts when it leaves the player (a sheet, the video's context menu): in
 * fullscreen and picture-in-picture only the layer the player fills is visible, so it goes there;
 * otherwise the body, above the page strips that follow the stage.
 */
export function playerMenuLayer(): Element {
  return document.fullscreenElement ?? document.querySelector('[data-pip-layer]:not([hidden])') ?? document.body;
}

/**
 * The header row of a player menu (its title or Back, and Close). It sticks to the top of the
 * frame, so it stays in view while a long list scrolls under it.
 */
export const MENU_HEADER = 'sticky -top-1.5 z-[1] -mx-1.5 -mt-1.5 mb-1 flex items-center gap-1 border-b border-white/10 bg-glass-strong px-1.5 pt-1.5 pb-1';
