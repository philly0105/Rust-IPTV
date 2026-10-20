/**
 * /stats (contract C7): watch time over the last 7 or 30 days, a per-day
 * chart split into live and movies/series, the most-watched channels and
 * titles, and Clear stats behind a confirm.
 *
 * The range lives in the URL (`?range=30`; 7 is the default and has no
 * parameter); `7` and `3` switch it from the keyboard. Everything is counted
 * on this device by the playback reporter (../reporter.ts).
 */

import { ChartColumn, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import type { WatchStatsTop } from '@/api/types';

import { DayChart, VOD_FILL } from '../components/DayChart';
import { StatsSkeleton } from '../components/StatsSkeleton';
import { TopChannels, TopTitles } from '../components/TopList';
import { Button, Dialog, EmptyState, ErrorState, Page, Tabs, buttonClass, cn, playItem, useShell, useShortcut, useToast, useVisibleSources, errorDescription } from '../deps';
import { useClearStats, useMonthHasData, useWatchStats } from '../hooks/useWatchStats';
import { rangeTotals } from '../lib/chart';
import { formatWatchTime } from '../lib/format';
import { readRange, type StatsRange } from '../paths';

export function StatsPage() {
  const { t, i18n } = useTranslation('stats');
  const lang = i18n.language;
  const { toast } = useToast();
  const { setHeader } = useShell();
  const title = t('title');
  useEffect(() => {
    setHeader({ title });
  }, [setHeader, title]);

  const [params, setParams] = useSearchParams();
  const range = readRange(params.get('range'));
  const setRange = useCallback(
    (next: StatsRange) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === 30) p.set('range', '30');
          else p.delete('range');
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );
  useShortcut('7', () => setRange(7), { description: t('showWeek'), area: title });
  useShortcut('3', () => setRange(30), { description: t('showMonth'), area: title });

  const { query, today } = useWatchStats(range);
  const data = query.data;
  const sources = useVisibleSources();
  const weekEmpty = range === 7 && data?.totalSeconds === 0;
  const monthHasData = useMonthHasData(weekEmpty, today);
  const firstSource = sources.data?.[0];
  const sourceById = useMemo(() => new Map((sources.data ?? []).map((s) => [s.id, s])), [sources.data]);

  const play = (item: WatchStatsTop) => {
    const source = sourceById.get(item.ref.sourceId);
    if (!source) return;
    playItem({
      ref: item.ref,
      title: item.title,
      ...(item.posterUrl ? { posterUrl: item.posterUrl } : {}),
      isLive: true,
      isRadio: item.ref.contentType === 'radio',
      sourceKind: source.kind,
    }).catch((err: unknown) => {
      toast({ variant: 'error', title: t('playFailed', { title: item.title }), description: errorDescription(err) });
    });
  };

  const [confirming, setConfirming] = useState(false);
  const clear = useClearStats();
  const confirmClear = () =>
    clear.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        toast({ variant: 'success', title: t('cleared') });
      },
      onError: (err) => toast({ variant: 'error', title: t('clearFailed'), description: errorDescription(err) }),
    });

  const time = (s: number) => formatWatchTime(s, lang);

  let headline = null;
  let body;
  if (query.isPending || (weekEmpty && monthHasData === null)) {
    body = <StatsSkeleton label={t('loading')} />;
  } else if (!data) {
    body = <ErrorState error={query.error} hint={t('errorHint')} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  } else if (data.totalSeconds === 0) {
    // "Show 30 days" only when that range has something; with nothing watched at all, point at something to watch.
    const olderData = range === 7 && monthHasData === true;
    body = (
      <EmptyState
        icon={<ChartColumn size={28} aria-hidden />}
        title={t('emptyTitle')}
        description={olderData ? t('emptyWeek') : t('emptyMonth')}
        action={
          olderData ? (
            <Button onClick={() => setRange(30)} data-testid="stats-show-month">
              {t('showMonth')}
            </Button>
          ) : firstSource ? (
            <Link to={`/s/${encodeURIComponent(firstSource.id)}/live`} className={buttonClass('primary')} data-testid="stats-watch-live">
              {t('watchLive')}
            </Link>
          ) : (
            <Link to="/dashboard" className={buttonClass('secondary')} data-testid="stats-go-home">
              {t('goHome')}
            </Link>
          )
        }
      />
    );
  } else {
    const split = rangeTotals(data.days);
    headline = (
      <div className="min-w-0 flex-1">
        <p className="max-w-[36ch] text-title text-balance sm:text-headline" data-testid="stats-total">
          {t(range === 7 ? 'totalWeek' : 'totalMonth', { time: time(data.totalSeconds) })}
        </p>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-muted" data-testid="stats-split">
          <li className="flex items-center gap-2">
            <span aria-hidden className="size-3 rounded-[3px] bg-accent" />
            <span>
              {t('live')} <span className="tabular-nums text-fg">{time(split.live)}</span>
            </span>
          </li>
          <li className="flex items-center gap-2">
            <span aria-hidden className={cn('size-3 rounded-[3px]', VOD_FILL)} />
            <span>
              {t('vod')} <span className="tabular-nums text-fg">{time(split.vod)}</span>
            </span>
          </li>
        </ul>
      </div>
    );
    body = (
      <div className="flex flex-col gap-8">
        <DayChart days={data.days} today={today} />
        <div className="grid gap-8 md:grid-cols-2">
          <TopChannels items={data.topChannels} canPlay={(item) => sourceById.has(item.ref.sourceId)} onPlay={play} />
          <TopTitles items={data.topTitles} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-divider pt-4">
          <p className="text-sm text-fg-subtle">{t('localNote')}</p>
          <Button variant="ghost" size="sm" icon={<Trash2 size={16} aria-hidden />} onClick={() => setConfirming(true)} data-testid="stats-clear">
            {t('clear')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Page width="default" className="flex min-w-0 flex-col gap-6 pb-10 pt-4" data-testid="stats-page">
      {/* C16: the page's single h1; the shell header shows the same text as a paragraph. */}
      <h1 className="sr-only">{title}</h1>
      {/* The range control comes first for keyboard and phones; from sm up it sits at the row's end. */}
      <div className="flex flex-col gap-4 sm:flex-row-reverse sm:items-start sm:justify-between">
        <Tabs
          className="self-start"
          variant="pill"
          label={t('range')}
          value={String(range)}
          onChange={(id) => setRange(readRange(id))}
          items={[
            { id: '7', label: t('week') },
            { id: '30', label: t('month') },
          ]}
        />
        {headline}
      </div>
      {body}
      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t('clearTitle')}
        description={t('clearBody')}
        size="sm"
        testId="stats-clear-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirming(false)}>
              {t('common:cancel')}
            </Button>
            <Button variant="danger" loading={clear.isPending} onClick={confirmClear} data-testid="stats-clear-confirm">
              {t('clear')}
            </Button>
          </>
        }
      />
    </Page>
  );
}

export default StatsPage;
