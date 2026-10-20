import { MonitorPlay, TriangleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../deps';
import type { SourceLoad } from '../useWallData';

const bannerClass =
  'flex items-start gap-3 rounded-md border px-3 py-2.5 text-sm sm:items-center motion-safe:animate-fade-in';

/** Identity of one over-limit situation: dismissing it hides it until the numbers change. */
export function loadKey(l: SourceLoad): string {
  return `${l.sourceId}|${l.tiles}|${l.own}|${l.max}`;
}

/**
 * Accounts whose streams in use (tiles that open a stream, plus this app's recordings and
 * main player) outnumber their connections. Providers refuse (or cut) streams past the
 * limit, so tiles of that account may fail; the banner says which account and by how much.
 * Dismissed per situation (the page keeps which, `loadKey`): adding another tile of that
 * account, or a recording starting on it, shows it again.
 */
export function LimitBanners({ over, onDismiss }: { over: readonly SourceLoad[]; onDismiss(l: SourceLoad): void }) {
  const { t } = useTranslation('multiview');
  // A polite live region that exists before any banner (empty, it takes no room), so additions are announced.
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-2">
      {over.map((l) => (
        <div
          key={l.sourceId}
          data-testid="multiview-limit-banner"
          data-source-id={l.sourceId}
          className={cn(bannerClass, 'border-warning/40 bg-warning/10 text-fg')}
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning sm:mt-0" />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">{t('limitTitle')} </span>
            <span className="text-fg-muted">
              {t('limitBody', { count: l.max, tiles: l.tiles, source: l.name || t('limitUnknownSource') })}
              {l.own > 0 ? ` ${t('limitOwn')}` : null}
            </span>
          </p>
          <button
            type="button"
            aria-label={t('limitDismiss')}
            title={t('limitDismiss')}
            onClick={() => onDismiss(l)}
            className="-me-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted outline-none hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-focus"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The main player started something while the wall is up: the wall keeps quiet until it stops. */
export function MainPlayingBanner({ onStop }: { onStop(): void }) {
  const { t } = useTranslation('multiview');
  return (
    <div data-testid="multiview-main-playing" className={cn(bannerClass, 'border-edge bg-surface-2 text-fg')}>
      <MonitorPlay aria-hidden className="mt-0.5 size-4 shrink-0 text-accent sm:mt-0" />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('mainPlayingTitle')} </span>
        <span className="text-fg-muted">{t('mainPlaying')}</span>
      </p>
      <button
        type="button"
        onClick={onStop}
        className="inline-flex h-8 shrink-0 items-center rounded-md border border-edge bg-surface px-3 text-sm font-medium text-fg outline-none hover:bg-surface-3 active:bg-pressed focus-visible:ring-2 focus-visible:ring-focus"
      >
        {t('stopMain')}
      </button>
    </div>
  );
}
