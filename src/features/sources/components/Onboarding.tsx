import { ArrowRight, DatabaseBackup, KeyRound, ListVideo, LockKeyhole, Router, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { isDesktop } from '@/api/transport';
import type { SourceKind } from '@/api/types';
import { Badge, buttonClass, cn } from '@/ui';

const TILES: { kind: SourceKind; icon: LucideIcon; title: string; body: string; needs: string }[] = [
  { kind: 'xtream', icon: KeyRound, title: 'onboardXtreamTitle', body: 'onboardXtreamBody', needs: 'onboardXtreamNeeds' },
  { kind: 'm3u', icon: ListVideo, title: 'onboardM3uTitle', body: 'onboardM3uBody', needs: 'onboardM3uNeeds' },
  { kind: 'stalker', icon: Router, title: 'onboardStalkerTitle', body: 'onboardStalkerBody', needs: 'onboardStalkerNeeds' },
];

/**
 * The three kinds of source as cards: an icon, the name, what it is, and what the provider has
 * to have given the user. Xtream comes first and is marked as the most common, since most
 * providers sell that login. Used by the Sources empty state below and by Home's first run.
 */
export function SourceKindTiles({ onPick, className }: { onPick: (kind: SourceKind) => void; className?: string }) {
  const { t } = useTranslation('sources');
  return (
    <ul className={cn('grid gap-3 @3xl:grid-cols-3 @3xl:gap-4', className)}>
      {TILES.map(({ kind, icon: Icon, title, body, needs }) => (
        <li key={kind}>
          <button
            type="button"
            onClick={() => onPick(kind)}
            data-testid={`onboard-${kind}`}
            className="group flex h-full w-full flex-col gap-3 rounded-lg border border-edge bg-surface p-5 text-start shadow-1 hover:border-border hover:bg-surface-2 active:bg-pressed motion-safe:transition-colors"
          >
            <span className="flex items-center justify-between gap-3">
              <span aria-hidden className="flex size-10 items-center justify-center rounded-lg border border-edge bg-surface-2 text-fg group-hover:bg-surface-3">
                <Icon size={18} />
              </span>
              {kind === 'xtream' ? <Badge>{t('onboardMostCommon')}</Badge> : null}
            </span>
            <span className="flex flex-col gap-1">
              <span className="text-title-sm text-fg">{t(title)}</span>
              <span className="text-body-sm text-fg-muted">{t(body)}</span>
            </span>
            <span className="mt-auto flex items-end justify-between gap-3 border-t border-divider pt-3">
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-caption text-fg-subtle">{t('onboardYouNeed')}</span>
                <span className="text-body-sm text-fg">{t(needs)}</span>
              </span>
              <ArrowRight
                aria-hidden
                size={16}
                className="mb-0.5 shrink-0 text-fg-subtle group-hover:text-fg motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5 rtl:-scale-x-100 motion-safe:rtl:group-hover:-translate-x-0.5"
              />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** First-run empty state: the three ways to add a source, plus backup restore. */
export function Onboarding({ onPick }: { onPick: (kind: SourceKind) => void }) {
  const { t } = useTranslation('sources');
  return (
    <section aria-labelledby="sources-onboarding-title" className="flex w-full max-w-5xl flex-col gap-8 py-4 @2xl:py-10" data-testid="sources-onboarding">
      <div className="flex max-w-2xl flex-col gap-2">
        <h2 id="sources-onboarding-title" className="text-headline text-fg @2xl:text-display">
          {t('onboardTitle')}
        </h2>
        <p className="text-body text-fg-muted">{t('onboardLead')}</p>
      </div>

      <SourceKindTiles onPick={onPick} />

      <div className="flex flex-col gap-4 border-t border-divider pt-5 @2xl:flex-row @2xl:items-center @2xl:justify-between">
        <p className="flex items-start gap-2 text-body-sm text-fg-muted">
          <LockKeyhole aria-hidden size={16} className="mt-0.5 shrink-0 text-fg-subtle" />
          {t(isDesktop ? 'onboardPrivacyDesktop' : 'onboardPrivacyServer')}
        </p>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-body-sm text-fg-muted">
          {t('onboardBackupLead')}
          <Link to="/settings/backup" className={buttonClass('secondary', 'sm')}>
            <DatabaseBackup aria-hidden size={16} />
            {t('onboardBackupLink')}
          </Link>
        </p>
      </div>
    </section>
  );
}
