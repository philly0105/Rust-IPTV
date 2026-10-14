/**
 * The core's rules for a user-typed name (a channel's custom name, a custom
 * list's name), so a dialog can refuse what the core would refuse before it
 * sends anything. Mirrors `channeledit::normalize_name`, `is_invisible` and
 * `is_line_break` in crates/iptv-core/src/channeledit/mod.rs, which
 * `lists::clean_name` uses too.
 */

/** Rust `str::trim`: strips Unicode White_Space at both ends (not U+FEFF, which JS `trim` also strips). */
export function trimName(name: string): string {
  return name.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
}

/**
 * Characters that show nothing on their own: white space, the format
 * characters and other default-ignorable code points, and the Hangul and
 * Braille blanks (`channeledit::is_invisible`).
 */
const INVISIBLE =
  /[\p{White_Space}\u{AD}\u{34F}\u{61C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180B}-\u{180F}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{206F}\u{2800}\u{3164}\u{FE00}-\u{FE0F}\u{FEFF}\u{FFA0}\u{FFF0}-\u{FFF8}\u{1BCA0}-\u{1BCA3}\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]/u;

/** True when `name` has no visible character (empty, or only white space and invisible characters). */
export function isBlankName(name: string): boolean {
  for (const c of name) if (!INVISIBLE.test(c)) return false;
  return true;
}

/** Control characters (Rust `char::is_control`, category Cc) and U+2028/U+2029, which break a one-line label. */
const LINE_BREAK = /[\p{Cc}\u{2028}\u{2029}]/u;

/** True when `name` holds a control character or a line or paragraph separator (`channeledit::is_line_break`). */
export function hasLineBreak(name: string): boolean {
  return LINE_BREAK.test(name);
}
