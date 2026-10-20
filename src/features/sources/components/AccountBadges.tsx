import { useTranslation } from 'react-i18next';

import type { AccountStatus } from '@/api/rpc';

import { Badge, cn } from '@/ui';
import { connections, connectionsFull, expiryState } from '../lib/account';
import { absoluteTime, relativeTime } from '../lib/format';

/**
 * Connections in use against the provider's limit: a short bar and "1/2 connections". Neutral
 * while there is room, the warning tone once every connection is taken (the next stream will
 * likely be refused). The bar is drawn only; the text says the same thing.
 */
function ConnectionsMeter({ active, max, full }: { active: number; max: number; full: boolean }) {
  const { t } = useTranslation('sources');
  const pct = max > 0 ? Math.min(100, Math.round((active / max) * 100)) : 0;
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1.5 text-caption tabular-nums', full ? 'text-warning' : 'text-fg-muted')}
      title={full ? t('accountConnectionsFullHint') : undefined}
      data-testid="account-badge-connections"
      data-full={full ? 'true' : undefined}
    >
      <span aria-hidden className="relative h-1.5 w-8 overflow-hidden rounded-full bg-surface-3">
        <span className={cn('absolute inset-y-0 start-0 rounded-full', full ? 'bg-warning' : 'bg-fg-muted')} style={{ width: `${pct}%` }} />
      </span>
      {t('accountBadgeConnections', { active, max })}
    </span>
  );
}

/**
 * The subscription at a glance, beside the source name: expired (danger), expiring within
 * `warnDays` (warning), trial, and a meter of connections in use when the provider sets a limit.
 * Nothing when the account is fine and unlimited, so healthy cards stay quiet.
 */
export function AccountBadges({ status, warnDays, now }: { status: AccountStatus | null | undefined; warnDays: number; now?: number }) {
  const { t, i18n } = useTranslation('sources');
  const lang = i18n.language;
  if (!status) return null;
  const state = expiryState(status, warnDays, now);
  const conns = connections(status);
  const full = connectionsFull(conns);
  const date = state.kind === 'expired' || state.kind === 'expiring' ? absoluteTime(state.expDate, lang) : undefined;

  return (
    <>
      {state.kind === 'expired' ? (
        <Badge variant="danger" title={date ? t('accountExpiredOn', { date }) : undefined} data-testid="account-badge-expired">
          {t('accountBadgeExpired')}
        </Badge>
      ) : null}
      {state.kind === 'expiring' ? (
        <Badge variant="warning" title={date ? t('accountExpiresOn', { date }) : undefined} data-testid="account-badge-expiring">
          {t('accountBadgeExpires', { when: relativeTime(state.expDate, lang, now) ?? '' })}
        </Badge>
      ) : null}
      {status.isTrial ? (
        <Badge variant="outline" data-testid="account-badge-trial">
          {t('accountTrial')}
        </Badge>
      ) : null}
      {conns ? <ConnectionsMeter active={conns.active} max={conns.max} full={full} /> : null}
    </>
  );
}
