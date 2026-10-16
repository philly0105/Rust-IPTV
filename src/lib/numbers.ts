/**
 * Locale-aware number formatting with no other dependencies. The shell's import-progress toast
 * (shell/effects.ts) is in the entry chunk and needs only these two, so they live here instead of
 * pulling all of sources/lib/files.ts (decoders, pickers) and format.ts into the entry. Both are
 * re-exported from their old homes for existing callers.
 */

/** `1.2 GB`, `350 MB`, `12 KB` in the user's number format. */
export function formatFileSize(bytes: number, lang: string): string {
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let text: string;
  try {
    text = new Intl.NumberFormat(lang, { maximumFractionDigits: value < 10 && unit > 0 ? 1 : 0 }).format(value);
  } catch {
    text = String(Math.round(value));
  }
  return `${text} ${units[unit]}`;
}

export function formatCount(n: number, lang: string): string {
  try {
    return new Intl.NumberFormat(lang).format(n);
  } catch {
    return String(n);
  }
}
