/**
 * /sports: NFL, college football, NBA and MLB games from ESPN's scoreboard (lib/espn.ts), with
 * the user's channels that carry each one (lib/match.ts).
 *
 * The league (`?league=nba`, every league by default) and the US Eastern day ESPN files games
 * under (`?day=YYYY-MM-DD`, today by default, a week either way) live in the URL; the defaults
 * leave their parameter out, and a day picked in an earlier run of the app opens today (paths.ts).
 * "Live now" leads whatever day is picked, then come the day's games by
 * league, live first and then by start. Only what is on screen is fetched: the picked day for the
 * picked leagues, and today and yesterday for Live now.
 */

import { CalendarX2, Tv } from 'lucide-react';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { GameCard } from '../components/GameCard';
import { DayStrip } from '../components/DayStrip';
import { LEAGUE_KEYS, LeagueFilter } from '../components/LeagueFilter';
import { SportsSkeleton } from '../components/SportsSkeleton';
import { useStreamContext, type StreamContext } from '../components/StreamList';
import { EmptyState, ErrorState, Page, SectionHeader, buttonClass, useNow, useShell, useVisibleSources } from '../deps';
import { useGameStreams } from '../hooks/useGameStreams';
import { useLiveGames, useSportsDay } from '../hooks/useGames';
import { etDate, etDays } from '../lib/espn';
import type { StreamMatch } from '../lib/match';
import { LEAGUES, type Game, type League } from '../lib/types';
import { pickDay, readDay, readLeague } from '../paths';

const DAY_PANEL = 'sports-day';

/** Live games first; otherwise the order given (by start). */
function liveFirst(games: readonly Game[]): Game[] {
  return [...games].sort((a, b) => Number(b.phase === 'live') - Number(a.phase === 'live'));
}

interface StreamsOf {
  (game: Game): { streams: readonly StreamMatch[] | undefined; streamsLoading: boolean };
}

function GameGrid({ games, streamsOf, showStreams, ctx }: { games: readonly Game[]; streamsOf: StreamsOf; showStreams: boolean; ctx: StreamContext }) {
  return (
    <ul className="grid items-start gap-3 md:grid-cols-2 2xl:grid-cols-3">
      {games.map((g) => (
        <GameCard key={g.key} game={g} {...streamsOf(g)} showStreams={showStreams} ctx={ctx} />
      ))}
    </ul>
  );
}

export function SportsPage() {
  const { t } = useTranslation('sports');
  const { setHeader } = useShell();
  const title = t('title');
  useEffect(() => {
    setHeader({ title });
  }, [setHeader, title]);

  const now = useNow();
  const today = etDate(now);
  // The window moves with the Eastern date, not with every tick of the clock.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => etDays(now, 7, 7), [today]);

  const [params, setParams] = useSearchParams();
  const league = readLeague(params.get('league'));
  const day = readDay(params.get('day'), days, today);
  const leagues = useMemo<readonly League[]>(() => (league ? [league] : LEAGUES), [league]);
  const setParam = useCallback(
    (key: 'day' | 'league', value: string | null) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (value) p.set(key, value);
          else p.delete(key);
          return p;
        },
        { replace: true },
      ),
    [setParams],
  );

  const sources = useVisibleSources();
  const sourceCount = sources.data?.length ?? 0;
  const hasSources = sourceCount > 0;
  const noSources = sources.data !== undefined && !hasSources;

  const live = useLiveGames(leagues);
  const dayGames = useSportsDay(day, leagues);
  const dayKeys = useMemo(() => new Set(dayGames.games.map((g) => g.key)), [dayGames.games]);
  // Live games the day list also holds share its matches; the others (yesterday's late games, or
  // every live game while another day is picked) get a pass of their own, over their own window.
  const liveOnly = useMemo(() => live.games.filter((g) => !dayKeys.has(g.key)), [live.games, dayKeys]);
  const dayStreams = useGameStreams(dayGames.games, hasSources);
  const liveStreams = useGameStreams(liveOnly, hasSources);
  const ctx = useStreamContext(now, sourceCount);

  const streamsOf: StreamsOf = (g) => {
    const from = dayKeys.has(g.key) ? dayStreams : liveStreams;
    return { streams: from.streams.get(g.key), streamsLoading: sources.isPending || from.loading };
  };

  const groups = useMemo(
    () =>
      LEAGUES.filter((l) => leagues.includes(l))
        .map((l) => ({ league: l, games: liveFirst(dayGames.games.filter((g) => g.league === l)) }))
        .filter((group) => group.games.length > 0),
    [leagues, dayGames.games],
  );

  /** "12 games, 9 with streams"; the games alone while matching runs or with no source. */
  const countOf = (games: readonly Game[]) => {
    const count = t('gameCount', { count: games.length });
    if (!hasSources || dayStreams.loading) return count;
    const matched = games.filter((g) => (dayStreams.streams.get(g.key)?.length ?? 0) > 0).length;
    return t('countSummary', { games: count, streams: t('withStreams', { count: matched }) });
  };

  const { games, loading, error, refetch } = dayGames;
  const failed = error !== null && error !== undefined;
  let body: ReactNode;
  if (games.length === 0 && loading) {
    body = <SportsSkeleton label={t('loading')} />;
  } else if (games.length === 0 && failed) {
    body = <ErrorState error={error} title={t('errorTitle')} hint={t('errorHint')} onRetry={refetch} />;
  } else if (games.length === 0) {
    body = <EmptyState icon={<CalendarX2 />} title={t('emptyDay')} description={t('emptyDayHint')} />;
  } else {
    body = (
      <>
        {/* A league that failed while others answered: its last good games stay, with a way to ask again. */}
        {failed ? <ErrorState size="inline" error={error} title={t('errorTitle')} hint={t('errorHint')} onRetry={refetch} /> : null}
        {groups.map(({ league: l, games: list }) => (
          <section key={l} aria-labelledby={`sports-league-${l}`} className="flex flex-col gap-3" data-testid={`sports-league-${l}`}>
            <SectionHeader id={`sports-league-${l}`} title={t(LEAGUE_KEYS[l])} count={countOf(list)} />
            <GameGrid games={list} streamsOf={streamsOf} showStreams={hasSources} ctx={ctx} />
          </section>
        ))}
      </>
    );
  }

  return (
    <Page width="wide" className="flex min-w-0 flex-col gap-6 pb-10" data-testid="sports-page">
      {/* C16: the page's single h1; the shell header shows the same text as a paragraph. */}
      <h1 className="sr-only">{title}</h1>
      <LeagueFilter value={league} onChange={(next) => setParam('league', next)} />
      {noSources ? (
        <div className="rounded-lg border border-dashed border-edge" data-testid="sports-no-sources">
          <EmptyState
            size="inline"
            icon={<Tv />}
            title={t('noSourcesTitle')}
            description={t('noSourcesHint')}
            action={
              <Link to="/sources?add=1" className={buttonClass('primary', 'sm')} data-testid="sports-add-source">
                {t('addSource')}
              </Link>
            }
          />
        </div>
      ) : null}
      {live.games.length > 0 ? (
        <section aria-labelledby="sports-live" className="flex flex-col gap-3" data-testid="sports-live">
          <SectionHeader id="sports-live" title={t('liveNow')} count={live.games.length} />
          <GameGrid games={live.games} streamsOf={streamsOf} showStreams={hasSources} ctx={ctx} />
        </section>
      ) : null}
      <div className="flex min-w-0 flex-col gap-4">
        <DayStrip
          days={days}
          value={day}
          today={today}
          onChange={(d) => {
            pickDay(d);
            setParam('day', d === today ? null : d);
          }}
          panelIdPrefix={DAY_PANEL}
        />
        <div role="tabpanel" id={`${DAY_PANEL}-${day}`} aria-labelledby={`${DAY_PANEL}-tab-${day}`} className="flex min-w-0 flex-col gap-6" data-testid="sports-day-panel">
          {body}
        </div>
      </div>
    </Page>
  );
}

export default SportsPage;
