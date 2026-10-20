import { RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { StalkerAccountInfo, XtreamAccountInfo } from '@/api/rpc';
import { useRpcQuery } from '@/api/query';
import type { Source } from '@/api/types';

import { Badge, Button, ErrorState, Skeleton } from '@/ui';
import { intlLocale, listSeparator } from '@/lib/intl';
import { absoluteTime, formatCount, relativeTime } from '../lib/format';
import { redactText } from '../lib/redact';

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

/** Badge tone for a portal's free-text status ("Active", "Expired", "Banned", "Disabled", "blocked (1)"). */
export function statusTone(status: string | undefined): Tone {
  const s = (status ?? '').toLowerCase();
  if (!s) return 'neutral';
  if (/^(active|ok|enabled|1)$/.test(s)) return 'success';
  if (/expired|banned|disabled|blocked|inactive|suspended/.test(s)) return 'danger';
  return 'warning';
}

/**
 * The panel's clock as text. A valid IANA zone formats the time in that zone
 * and names it ("Oct 11, 2026, 5:14 PM, Europe/Berlin"); an unknown zone falls
 * back to the viewer's local time without a label, so the two never disagree.
 * Only an RFC3339 instant (with `Z` or an offset) is converted: a bare wall
 * clock ("2026-10-11 18:00:00", sent when the panel has no `timestamp_now`) is
 * already in the server zone, so it is shown as sent with the zone name, as is
 * anything unparseable.
 */
export function serverTimeText(serverTime: string | undefined, timezone: string | undefined, lang: string): string | undefined {
  const tz = timezone?.trim() || undefined;
  if (!serverTime) return tz;
  const d = new Date(serverTime);
  if (!RFC3339_INSTANT.test(serverTime.trim()) || Number.isNaN(d.getTime())) return [serverTime, tz].filter(Boolean).join(listSeparator(lang));
  if (tz) {
    try {
      return `${new Intl.DateTimeFormat(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(d)}, ${tz}`;
    } catch (e) {
      if (!(e instanceof RangeError)) throw e;
    }
  }
  return absoluteTime(serverTime, lang) ?? serverTime;
}

/** A date-time that names its offset; anything else is a wall clock in an unknown zone. */
const RFC3339_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})$/;

/** Keys in a stalker `raw` reply that never belong on screen. */
const SECRET_KEY = /pass|token|secret|key|signature|serial|device_?id/i;

/** Scalar fields of a stalker reply, flattened one level, secrets dropped. */
export function rawRows(raw: Record<string, unknown> | null | undefined): [string, string][] {
  if (!raw || typeof raw !== 'object') return [];
  const out: [string, string][] = [];
  const visit = (obj: Record<string, unknown>, prefix: string) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (SECRET_KEY.test(k)) continue;
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push([key, String(v)]);
      else if (!prefix && typeof v === 'object' && !Array.isArray(v)) visit(v as Record<string, unknown>, key);
    }
  };
  visit(raw, '');
  return out.slice(0, 40);
}

function Row({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 @xl:flex-row @xl:items-baseline @xl:gap-6" data-testid={testId}>
      <dt className="w-44 shrink-0 text-sm text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg">{children}</dd>
    </div>
  );
}

function When({ iso, lang, expiry }: { iso: string | undefined; lang: string; expiry?: boolean }) {
  const { t } = useTranslation('sources');
  const abs = absoluteTime(iso, lang);
  if (!abs) return <span className="text-fg-muted">{expiry ? t('accountNoExpiry') : t('accountUnknown')}</span>;
  const rel = relativeTime(iso, lang);
  const past = iso ? Date.parse(iso) < Date.now() : false;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      <span className="tabular-nums">{abs}</span>
      {rel ? <span className={expiry && past ? 'text-sm text-danger' : 'text-sm text-fg-muted'}>{expiry && past ? t('accountExpired', { when: rel }) : rel}</span> : null}
    </span>
  );
}

function Loading() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-2" data-testid="account-loading">
      {Array.from({ length: 5 }, (_, i) => (
        <Skeleton key={i} className="h-10" />
      ))}
    </div>
  );
}

function Frame({ children, onRefresh, fetching }: { children: ReactNode; onRefresh: () => void; fetching: boolean }) {
  const { t } = useTranslation('sources');
  return (
    <div className="@container flex flex-col gap-3" data-testid="account-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-fg-muted">{t('accountLead')}</p>
        <Button size="sm" variant="ghost" icon={<RefreshCw aria-hidden className="size-4" />} loading={fetching} onClick={onRefresh} data-testid="account-refresh">
          {t('accountRefresh')}
        </Button>
      </div>
      {children}
    </div>
  );
}

function XtreamAccountView({ sourceId }: { sourceId: string }) {
  const { t, i18n } = useTranslation('sources');
  const lang = i18n.language;
  const q = useRpcQuery('xtream.accountInfo', { sourceId }, { staleTime: 30_000 });
  const refresh = () => void q.refetch();
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <Frame onRefresh={refresh} fetching={q.isFetching}>
        <ErrorState size="inline" error={q.error} title={t('accountLoadFailed')} onRetry={refresh} />
      </Frame>
    );
  const a: XtreamAccountInfo = q.data;
  const formats = a.allowedOutputFormats?.filter(Boolean) ?? [];
  return (
    <Frame onRefresh={refresh} fetching={q.isFetching}>
      <dl className="flex flex-col divide-y divide-divider rounded-lg border border-edge bg-surface">
        <Row label={t('accountStatus')} testId="account-status">
          <Badge variant={statusTone(a.status)}>{a.status}</Badge>
        </Row>
        <Row label={t('accountExpires')} testId="account-expires">
          <When iso={a.expDate} lang={lang} expiry />
        </Row>
        <Row label={t('accountConnections')} testId="account-connections">
          <span className="tabular-nums">
            {a.maxConnections > 0
              ? t('accountConnectionsOf', { active: formatCount(a.activeCons, lang), max: formatCount(a.maxConnections, lang) })
              : t('accountConnectionsUnlimited', { active: formatCount(a.activeCons, lang) })}
          </span>
        </Row>
        <Row label={t('accountCreated')}>
          <When iso={a.createdAt} lang={lang} />
        </Row>
        <Row label={t('accountTrial')} testId="account-trial">
          {a.isTrial ? t('accountTrialYes') : t('accountTrialNo')}
        </Row>
        {formats.length > 0 ? (
          <Row label={t('accountFormats')} testId="account-formats">
            <span className="flex flex-wrap gap-1.5">
              {formats.map((f) => (
                <Badge key={f} variant="outline">
                  {f}
                </Badge>
              ))}
            </span>
          </Row>
        ) : null}
        {a.serverTime || a.timezone ? (
          <Row label={t('accountServerTime')}>
            <span data-testid="account-server-time">{serverTimeText(a.serverTime, a.timezone, lang)}</span>
          </Row>
        ) : null}
      </dl>
    </Frame>
  );
}

function StalkerAccountView({ sourceId }: { sourceId: string }) {
  const { t, i18n } = useTranslation('sources');
  const lang = i18n.language;
  const q = useRpcQuery('stalker.accountInfo', { sourceId }, { staleTime: 30_000 });
  const refresh = () => void q.refetch();
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <Frame onRefresh={refresh} fetching={q.isFetching}>
        <ErrorState size="inline" error={q.error} title={t('accountLoadFailed')} onRetry={refresh} />
      </Frame>
    );
  const a: StalkerAccountInfo = q.data;
  const rows = rawRows(a.raw);
  const empty = !a.status && !a.expDate && !a.tariff && rows.length === 0;
  return (
    <Frame onRefresh={refresh} fetching={q.isFetching}>
      <dl className="flex flex-col divide-y divide-divider rounded-lg border border-edge bg-surface">
        <Row label={t('accountMac')}>
          <span className="font-mono text-sm">{a.mac}</span>
        </Row>
        <Row label={t('accountStatus')} testId="account-status">
          {a.status ? <Badge variant={statusTone(a.status)}>{a.status}</Badge> : <span className="text-fg-muted">{t('accountUnknown')}</span>}
        </Row>
        <Row label={t('accountExpires')} testId="account-expires">
          <When iso={a.expDate} lang={lang} expiry />
        </Row>
        <Row label={t('accountTariff')}>{a.tariff ?? <span className="text-fg-muted">{t('accountUnknown')}</span>}</Row>
      </dl>
      {empty ? <p className="text-sm text-fg-muted" data-testid="account-empty">{t('accountEmpty')}</p> : null}
      {rows.length > 0 ? (
        <details className="group rounded-lg border border-edge bg-surface" data-testid="account-raw">
          <summary className="cursor-pointer select-none rounded-lg px-4 py-3 text-sm font-medium text-fg hover:bg-hover active:bg-active">{t('accountPortalDetails', { count: rows.length })}</summary>
          <dl className="flex flex-col divide-y divide-divider border-t border-divider">
            {rows.map(([k, v]) => (
              <Row key={k} label={k}>
                <span className="text-sm">{redactText(v)}</span>
              </Row>
            ))}
          </dl>
        </details>
      ) : null}
    </Frame>
  );
}

/** Subscription details for Xtream and Stalker sources (`xtream.accountInfo` / `stalker.accountInfo`). */
export function AccountPanel({ source }: { source: Source }) {
  if (source.kind === 'xtream') return <XtreamAccountView sourceId={source.id} />;
  if (source.kind === 'stalker') return <StalkerAccountView sourceId={source.id} />;
  return null;
}

export function hasAccountInfo(source: Source): boolean {
  return source.kind === 'xtream' || source.kind === 'stalker';
}
