/** The English confirmation word, accepted in every locale (some locales need diacritics or an IME). */
export const FALLBACK_CONFIRM_WORD = 'remove';

/**
 * Traditional/simplified pairs that occur in the localized confirm words (zhtw 刪除, zh 删除),
 * folded to one form so a zhtw user typing with a simplified IME still matches.
 */
const HAN_VARIANTS: Readonly<Record<string, string>> = { '刪': '删' };

/**
 * Case-, accent-, width- and whitespace-insensitive form: trim, lowercase, NFKD (folds full-width
 * IME input such as `ｒｅｍｏｖｅ`), combining marks and Arabic tatweel (U+0640) stripped, and the
 * Han variants above unified.
 */
export function foldConfirmWord(text: string): string {
  return text
    .trim()
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[\p{M}ـ]/gu, '')
    .replace(/刪/g, (c) => HAN_VARIANTS[c] ?? c)
    .toLowerCase();
}

/** Whether `typed` confirms: the localized word or `remove`, ignoring case, accents and surrounding spaces. */
export function confirmWordMatches(typed: string, word: string): boolean {
  const folded = foldConfirmWord(typed);
  if (!folded) return false;
  return folded === foldConfirmWord(word) || folded === FALLBACK_CONFIRM_WORD;
}
