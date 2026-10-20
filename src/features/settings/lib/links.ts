import type { MouseEvent } from 'react';

import { isDesktop } from '@/api/transport';

/** The project's public pages (SS-12). */
export const PROJECT_URL = 'https://github.com/philly0105/Rust-IPTV';
export const ISSUES_URL = `${PROJECT_URL}/issues`;
export const RELEASES_URL = `${PROJECT_URL}/releases`;

/**
 * Click handler for an external link (`<a href target="_blank">`). The desktop webview does not
 * open such links by itself, so there the system browser opens it through the opener plugin
 * (its default permissions allow http and https); a browser follows the link as usual.
 */
export function openExternal(e: MouseEvent<HTMLAnchorElement>): void {
  if (!isDesktop) return;
  e.preventDefault();
  const href = e.currentTarget.href;
  void import('@tauri-apps/plugin-opener')
    .then(({ openUrl }) => openUrl(href))
    .catch(() => window.open(href, '_blank', 'noopener'));
}

/** "Windows", "macOS", "Linux" for `app.info.platform` (Rust's `std::env::consts::OS`); anything else as it is. */
export function platformName(os: string): string {
  const names: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux', android: 'Android', ios: 'iOS', freebsd: 'FreeBSD' };
  return names[os] ?? os;
}
