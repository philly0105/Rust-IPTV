/**
 * Rename rules (contract C2): the core trims the name and takes 1 to 120
 * characters; `null` (or an empty name) goes back to the provider's name.
 * The dialog checks the same rules before it sends anything, and skips the
 * call when nothing would change.
 */

/** Longest custom name the core accepts, in characters (Unicode scalar values, as Rust counts them). */
export const NAME_MAX = 120;

/** Length as the core counts it: code points, so an emoji is one character, not two UTF-16 units. */
export function nameLength(name: string): number {
  return Array.from(name).length;
}

export interface RenameContext {
  /** The name shown now: the custom name when renamed, else the provider's. */
  current: string;
  /** The provider's name. */
  provider: string;
  /** A custom name is set now. */
  renamed: boolean;
}

/** What Save does with the typed name. */
export type RenamePlan =
  | { kind: 'invalid'; reason: 'empty' | 'tooLong' }
  /** Nothing to send: the name stays as it is. */
  | { kind: 'unchanged' }
  /** `channels.rename` with `name: null`: back to the provider's name. */
  | { kind: 'reset' }
  | { kind: 'rename'; name: string };

/**
 * Decides what saving `input` means. An empty field resets a renamed channel
 * and is refused otherwise (there is no name to go back to). Typing the
 * provider's name is a reset too, so no custom row is kept that only repeats it.
 */
export function planRename(input: string, ctx: RenameContext): RenamePlan {
  const name = input.trim();
  if (nameLength(name) > NAME_MAX) return { kind: 'invalid', reason: 'tooLong' };
  if (name === '') return ctx.renamed ? { kind: 'reset' } : { kind: 'invalid', reason: 'empty' };
  if (name === ctx.provider) return ctx.renamed ? { kind: 'reset' } : { kind: 'unchanged' };
  if (name === ctx.current) return { kind: 'unchanged' };
  return { kind: 'rename', name };
}
