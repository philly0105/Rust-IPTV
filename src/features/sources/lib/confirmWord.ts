/** The English confirmation word, accepted in every locale (some locales need diacritics or an IME). */
export const FALLBACK_CONFIRM_WORD = 'remove';

/** Case-, accent- and whitespace-insensitive form: trim, lowercase, NFD, combining marks stripped. */
export function foldConfirmWord(text: string): string {
  return text.trim().toLocaleLowerCase().normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Whether `typed` confirms: the localized word or `remove`, ignoring case, accents and surrounding spaces. */
export function confirmWordMatches(typed: string, word: string): boolean {
  const folded = foldConfirmWord(typed);
  if (!folded) return false;
  return folded === foldConfirmWord(word) || folded === FALLBACK_CONFIRM_WORD;
}
