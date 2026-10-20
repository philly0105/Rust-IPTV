/**
 * Interaction states shared by every artwork card: VOD posters, dashboard
 * posters, channel and source tiles (docs/architecture/appearance.md). One
 * language everywhere, drawn on the artwork rather than around the caption:
 *
 *   rest      hairline ring, resting shadow
 *   hover     lifts 2px, the ring brightens, the shadow deepens
 *   focus     2px focus ring plus the soft glow, like every other control
 *   pressed   settles back down and gives a little (scale 0.98)
 *   cursor    the keyboard cursor of a listbox grid: the focus ring, no lift
 *
 * Movement sits behind motion-safe, so reduced motion keeps every colour and
 * ring change and drops only the lift and the press.
 *
 * Usage: put CARD_ROOT on the focusable card (link, button or grid option
 * content), CARD_ART on the element that frames the artwork, and add
 * CARD_ART_CURSOR when a listbox's active descendant rests on the card.
 */

/** The focusable card: names the `card` group and hands its focus ring to the artwork. */
export const CARD_ROOT = 'group/card outline-none focus-visible:outline-none focus-visible:shadow-none';

/** The artwork frame: rest, hover, focus-visible and pressed states. */
export const CARD_ART =
  'relative overflow-hidden rounded-lg shadow-1 ring-1 ring-edge ' +
  'motion-safe:transition-[translate,scale,box-shadow] motion-safe:duration-150 motion-safe:ease-out ' +
  'group-hover/card:shadow-2 group-hover/card:ring-border motion-safe:group-hover/card:-translate-y-0.5 ' +
  'group-focus-visible/card:ring-2 group-focus-visible/card:ring-focus group-focus-visible/card:shadow-[0_0_0_6px_var(--color-glow)] ' +
  'motion-safe:group-active/card:translate-y-0 motion-safe:group-active/card:scale-[0.98] group-active/card:shadow-1';

/** The keyboard cursor of a listbox grid (aria-activedescendant) resting on this card. */
export const CARD_ART_CURSOR = 'ring-2 ring-focus shadow-[0_0_0_6px_var(--color-glow)]';
