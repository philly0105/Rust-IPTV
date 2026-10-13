import { useTranslation } from 'react-i18next';

import type { AccountStatus } from '@/api/rpc';

import { Badge } from '@/ui';
import { connections, connectionsFull, expiryState } from '../lib/account';
import { absoluteTime, relativeTime } from '../lib/format';

/**
 * The subscription at a glance, beside the source name: expired (danger), expiring within
 * `warnDays` (warning), trial, and connections in use when the provider sets a limit.
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
      {conns ? (
        <Badge
          variant={full ? 'warning' : 'neutral'}
          title={full ? t('accountConnectionsFullHint') : undefined}
          data-testid="account-badge-connections"
          data-full={full ? 'true' : undefined}
        >
          {t('accountBadgeConnections', { active: conns.active, max: conns.max })}
        </Badge>
      ) : null}
    </>
  );
}
