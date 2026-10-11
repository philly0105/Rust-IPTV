import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { SourceKind } from '@/api/types';

import { KIND_MARK } from './SourceCard';

const TILES: { kind: SourceKind; title: string; body: string; needs: string }[] = [
  { kind: 'm3u', title: 'onboardM3uTitle', body: 'onboardM3uBody', needs: 'onboardM3uNeeds' },
  { kind: 'xtream', title: 'onboardXtreamTitle', body: 'onboardXtreamBody', needs: 'onboardXtreamNeeds' },
  { kind: 'stalker', title: 'onboardStalkerTitle', body: 'onboardStalkerBody', needs: 'onboardStalkerNeeds' },
];

/** First-run empty state: the three ways to add a source, plus backup restore. */
export function Onboarding({ onPick }: { onPick: (kind: SourceKind) => void }) {
  const { t } = useTranslation('sources');
  return (
    <section aria-labelledby="sources-onboarding-title" className="mx-auto flex w-full max-w-5xl flex-col gap-8 py-6 @2xl:py-12" data-testid="sources-onboarding">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id="sources-onboarding-title" className="font-display text-3xl font-semibold text-fg @2xl:text-4xl">
          {t('onboardTitle')}
        </h2>
        <p className="text-base text-fg-muted">{t('onboardLead')}</p>
      </div>

      <ul className="grid gap-4 @3xl:grid-cols-3">
        {TILES.map((tile) => (
          <li key={tile.kind}>
            <button
              type="button"
              onClick={() => onPick(tile.kind)}
              data-testid={`onboard-${tile.kind}`}
              className="group flex h-full w-full flex-col gap-4 rounded-lg border border-border bg-surface p-5 text-left shadow-1 hover:border-accent/70 hover:bg-surface-2 motion-safe:transition-colors"
            >
              <span className="flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-12 items-center justify-center rounded-md border border-border bg-surface-2 font-display text-base font-semibold tracking-wide text-accent group-hover:border-accent/70"
                >
                  {KIND_MARK[tile.kind]}
                </span>
                <span className="font-display text-xl font-semibold text-fg">{t(tile.title)}</span>
              </span>
              <span className="text-sm text-fg-muted">{t(tile.body)}</span>
              <span className="mt-auto border-t border-border pt-3 text-sm text-fg">{t(tile.needs)}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="text-sm text-fg-muted">
        {t('onboardBackupLead')}{' '}
        <Link to="/settings/backup" className="font-medium text-accent underline-offset-4 hover:underline">
          {t('onboardBackupLink')}
        </Link>
      </p>
    </section>
  );
}
