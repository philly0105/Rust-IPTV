/**
 * A press that closed a player menu (PL-MENU-OUTSIDE-CLICK). Clicking away is how most people
 * dismiss a popover; over the picture that same click also paused live TV (or resumed a paused
 * film) and, doubled, went fullscreen. The menus note the press that closed them (the options
 * menu, the channel history, the video's context menu), and the surface's click handler asks for
 * it: a click that ends a noted press only closed a menu.
 */

/** How long a noted press waits for its click (a long press still counts). */
const NOTE_MS = 2000;

let noted: { target: EventTarget | null; at: number } | null = null;

/** A pointer press on `target` closed a menu. */
export function noteMenuDismissed(target: EventTarget | null): void {
  noted = { target, at: Date.now() };
}

/**
 * True, once, when the click on `target` ends the press that closed a menu. Any other click
 * forgets the note, so a press elsewhere (outside the player) never swallows a later click.
 */
export function consumeMenuDismiss(target: EventTarget | null): boolean {
  const n = noted;
  noted = null;
  if (!n || Date.now() - n.at > NOTE_MS) return false;
  return n.target === target || (target instanceof Node && n.target instanceof Node && target.contains(n.target));
}

/** Testing only. */
export function __resetMenuDismissForTests(): void {
  noted = null;
}
