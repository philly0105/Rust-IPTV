/** Builds a flat camelCase i18n key: `k('status', 'downloading')` -> `statusDownloading` (C9). */
export function k(prefix: string, id: string): string {
  return prefix + id.charAt(0).toUpperCase() + id.slice(1);
}
