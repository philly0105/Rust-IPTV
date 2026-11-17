import type { CSSProperties } from 'react';

import { cn } from '../cn';

/**
 * The frame of a player menu that opens from the bar (the options menu, the channel history): a
 * popover over the picture, growing up from just above the bar, or in a player too short for that
 * (a phone's inline player, the mini player) a sheet from the bottom of the screen. A menu taller
 * than the room above the bar leaves the player: on a docked stage it floats over the page beside
 * it, in fullscreen and Fill window it is a full-height side panel. Controls measures the room and
 * the menu and decides (`PlayerPopup`); the menus draw the frame it hands them.
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
  /** Too little room above the bar: a sheet from the bottom of the screen (or `side`) instead. */
  sheet: boolean;
  /**
   * With `sheet`: a player that is the whole window (fullscreen, Fill window) and too short for the
   * menu: a full-height panel at the inline end, the mirror of the channel panel at the start.
   */
  side?: boolean | undefined;
  /**
   * A docked player too short for the menu: the popover floats over the page from the player's
   * bottom edge (fixed, out of the player), slid up as far as it must to show whole, `room` then
   * measured down to the bottom of the window. Its place in the window (top and one side).
   */
  drop?: CSSProperties | undefined;
  /** Hands the menu's element to the frame, which measures its full height. */
  menuRef?: ((el: HTMLElement | null) => void) | undefined;
}

/** Not measured (a menu rendered on its own, or before layout): a popover with its own cap. */
export const UNMEASURED: MenuFit = { room: null, sheet: false };

/**
 * The frame's classes. `popover`: the popover's width, with a cap for before it is measured (the
 * style from `menuFrameStyle` sets the height to the room). The sheet spans a phone's width above
 * the home indicator; on a wider screen it is a panel in the bottom corner. The side panel runs the
 * window's height. No blur behind the sheet and the side panel: they are large, and opaque
 * (`player-sheet`, player.css), so the page never shows through. Nor behind a popover floating
 * out of the player over the page: in the light theme the white page through the glass made it
 * read as two greys (v-themes-locales-16).
 */
export function menuFrameClass(fit: MenuFit, popover: string): string {
  return cn(
    'player-glass-strong player-glass-edge overflow-y-auto overscroll-contain p-1.5',
    fit.side
      ? 'player-sheet fixed inset-y-0 end-0 z-[60] w-80 max-w-[calc(100vw-2rem)] border-s pb-[max(0.375rem,env(safe-area-inset-bottom))] motion-safe:animate-drawer-in'
      : fit.sheet
        ? 'player-sheet fixed inset-x-0 bottom-0 z-[60] max-h-[calc(100dvh-3rem)] rounded-t-xl border-t pb-[max(0.375rem,env(safe-area-inset-bottom))] motion-safe:animate-sheet-in sm:inset-x-auto sm:end-4 sm:bottom-4 sm:w-80 sm:rounded-xl sm:border sm:pb-1.5'
        : cn('rounded-lg border motion-safe:animate-pop-in', fit.drop ? 'player-sheet fixed z-[60]' : 'glass-blur', popover),
  );
}

/** The popover's height: the room it was given (its class caps it until that is measured). */
export function menuFrameStyle(fit: MenuFit): CSSProperties | undefined {
  if (fit.sheet || fit.room === null) return undefined;
  return { ...fit.drop, maxHeight: `${fit.room}px` };
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
