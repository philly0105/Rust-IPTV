import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';

import { cn } from '@/ui';

export const TMDB_HOME = 'https://www.themoviedb.org';

/**
 * TMDB mark: the wordmark in a stretched pill, drawn in `currentColor` so it
 * follows the accent token in both themes. Kept smaller and quieter than the
 * app's own branding, as TMDB's attribution terms ask.
 */
export function TmdbLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 92 20" aria-hidden="true" className={cn('h-3.5 w-auto shrink-0', className)} focusable="false">
      <rect x="0.75" y="0.75" width="90.5" height="18.5" rx="9.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="66" y="4" width="21" height="12" rx="6" fill="currentColor" />
      <text
        x="33"
        y="14.2"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="var(--font-sans), system-ui, sans-serif"
        fontSize="11.5"
        fontWeight="800"
        letterSpacing="1.2"
      >
        TMDB
      </text>
    </svg>
  );
}

async function openTmdb(e: MouseEvent<HTMLAnchorElement>) {
  // The desktop webview does not open target=_blank links on its own.
  if (!isDesktop) return;
  e.preventDefault();
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(TMDB_HOME);
  } catch {
    window.open(TMDB_HOME, '_blank', 'noopener');
  }
}

/**
 * Required notice for any screen that shows TMDB data (detail enrichment,
 * similar / known-for rails, actor page). Sits at the foot of the TMDB section.
 */
export function TmdbAttribution({ className }: { className?: string }) {
  const { t } = useTranslation('vod');
  return (
    <footer
      data-testid="tmdb-attribution"
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-divider pt-3 text-xs text-fg-subtle', className)}
    >
      <a
        href={TMDB_HOME}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => void openTmdb(e)}
        aria-label={t('tmdbLogoLabel')}
        title={t('tmdbLogoLabel')}
        className="inline-flex items-center rounded-sm text-accent opacity-80 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-focus motion-safe:transition-opacity"
      >
        <TmdbLogo />
      </a>
      <p className="min-w-0">{t('tmdbAttribution')}</p>
    </footer>
  );
}
