/**
 * Arrow-key walking for a row of cards (My Videos' recordings). Recently watched had a Continue
 * watching rail here; its titles now carry their progress on their own history rows (EntryRow's
 * `resume`), so the rail is gone and only its key handling is left.
 */

/**
 * Arrow keys walk the rail in reading order (mirrored in RTL); Home and End
 * jump to its ends. `selector` picks the rail's cards. Returns false for keys
 * it does not handle.
 */
export function moveInRail(from: HTMLElement, key: string, selector: string): boolean {
  const cards = [...(from.closest('ul')?.querySelectorAll<HTMLElement>(selector) ?? [])];
  const at = cards.indexOf(from);
  if (at < 0) return false;
  const rtl = getComputedStyle(from).direction === 'rtl';
  let to: number;
  if (key === 'Home') to = 0;
  else if (key === 'End') to = cards.length - 1;
  else if (key === 'ArrowRight') to = at + (rtl ? -1 : 1);
  else if (key === 'ArrowLeft') to = at + (rtl ? 1 : -1);
  else return false;
  const target = cards[Math.max(0, Math.min(cards.length - 1, to))];
  target?.focus();
  target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}
