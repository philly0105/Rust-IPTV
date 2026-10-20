/**
 * A one-line card under a detail page's hero while TMDB is off, the default
 * (VL-detail-empty-no-tmdb): what TMDB would add and the way to turn it on. It
 * shows until dismissed; the dismissal is a UI preference of this browser
 * (localStorage), so it never comes back on any detail page.
 */

import { Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { IconButton, TEXT_LINK, cn } from '@/ui';

export const TMDB_PROMO_KEY = 'vod.tmdbPromoDismissed';

function dismissedBefore(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(TMDB_PROMO_KEY) === '1';
  } catch {
    return false;
  }
}

export function TmdbPromo({ className }: { className?: string }) {
  const { t } = useTranslation('vod');
  const [dismissed, setDismissed] = useState(dismissedBefore);
  if (dismissed) return null;
  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(TMDB_PROMO_KEY, '1');
    } catch {
      // A full or blocked store: it stays hidden for this visit.
    }
  };
  return (
    <aside
      aria-label={t('tmdbPromoLabel')}
      className={cn('flex max-w-3xl items-center gap-3 rounded-lg border border-edge bg-surface py-2 ps-4 pe-2 text-body-sm text-fg-muted', className)}
      data-testid="vod-tmdb-promo"
    >
      <Sparkles aria-hidden size={16} className="shrink-0 text-fg-subtle" />
      <p className="min-w-0 flex-1">
        {t('tmdbPromo')}{' '}
        <Link to="/settings/metadata" className={TEXT_LINK}>
          {t('tmdbPromoAction')}
        </Link>
      </p>
      <IconButton size="sm" label={t('tmdbPromoDismiss')} icon={<X aria-hidden size={16} />} onClick={dismiss} data-testid="vod-tmdb-promo-dismiss" />
    </aside>
  );
}
