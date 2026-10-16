import { clsx } from 'clsx';
import { CircleAlert, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';
import { DEFAULT_SETTINGS } from '@/api/types';
import { expiryAlerts, loadDismissed, saveDismissed, type ExpiryAlert } from '@/features/sources/lib/account';
import { absoluteTime, relativeTime } from '@/features/sources/lib/format';

import { IconButton, buttonClass } from '@/ui';

/**
 * account: subscriptions that expired or expire within `accountExpiryWarnDays`, one row per
 * source above the dashboard rails. Each row links to the source's subscription details and
 * can be dismissed; a dismissal holds for that expiry date only, so a renewal that is about
 * to run out again warns again.
 */
export function AccountAlerts({ sources }: { sources: readonly Source[] }) {
  const { t, i18n } = useTranslation('shell');
  const lang = i18n.language;
  const settings = useRpcQuery('settings.get', undefined, { staleTime: Infinity });
  const warnDays = settings.data?.accountExpiryWarnDays ?? DEFAULT_SETTINGS.accountExpiryWarnDays;
  const hasAccounts = sources.some((s) => s.kind !== 'm3u');
  // Waits for the settings: with warnings off there is nothing to ask.
  const statuses = useRpcQuery('account.statusAll', undefined, { enabled: hasAccounts && settings.isSuccess && warnDays > 0 });
  const [dismissed, setDismissed] = useState(loadDismissed);

  const byId = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const alerts = useMemo(
    () => expiryAlerts(statuses.data ?? [], { warnDays, dismissed, sourceIds: new Set(byId.keys()) }),
    [statuses.data, warnDays, dismissed, byId],
  );
  if (alerts.length === 0) return null;

  const dismiss = (a: ExpiryAlert) => {
    const next = new Set(dismissed).add(a.key);
    saveDismissed(next);
    setDismissed(next);
  };

  return (
    <section aria-label={t('accountAlertsLabel')} className="mx-8 flex flex-col gap-2" data-testid="account-alerts">
      {alerts.map((a) => {
        const name = byId.get(a.sourceId)?.name ?? '';
        const expired = a.state.kind === 'expired';
        const Icon = expired ? CircleAlert : TriangleAlert;
        const title =
          a.state.kind === 'expired'
            ? t('accountAlertExpiredTitle', { name })
            : t('accountAlertExpiringTitle', { name, when: relativeTime(a.state.expDate, lang) ?? '' });
        const date = absoluteTime(a.state.expDate, lang);
        return (
          <div
            key={a.key}
            className={clsx(
              'flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border px-4 py-3',
              expired ? 'border-danger/40 bg-danger/10' : 'border-warning/40 bg-warning/10',
            )}
            data-testid="account-alert"
            data-kind={a.state.kind}
            data-source-id={a.sourceId}
          >
            <Icon aria-hidden className={clsx('size-5 shrink-0', expired ? 'text-danger' : 'text-warning')} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p id={`${a.key}-title`} className="font-medium text-fg" dir="auto" title={date}>
                {title}
              </p>
              <p className="text-sm text-fg-muted">{expired ? t('accountAlertExpiredBody') : t('accountAlertExpiringBody')}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Link
                to={`/sources?account=${encodeURIComponent(a.sourceId)}`}
                className={buttonClass('secondary', 'sm')}
                aria-describedby={`${a.key}-title`}
                data-testid="account-alert-open"
              >
                {t('accountAlertOpen')}
              </Link>
              <IconButton
                label={t('accountAlertDismiss', { name })}
                icon={<X aria-hidden className="size-4" />}
                size="sm"
                variant="ghost"
                onClick={() => dismiss(a)}
                data-testid="account-alert-dismiss"
              />
            </div>
          </div>
        );
      })}
    </section>
  );
}
