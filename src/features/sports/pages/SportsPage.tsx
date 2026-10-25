/**
 * /sports: NFL, college football, NBA and MLB games from ESPN's scoreboard (lib/espn.ts), with
 * the user's channels that carry each one (lib/match.ts).
 *
 * The controls sit together at the top: the league tabs with each league's count for the day, a
 * "With streams" filter, and the Eastern day ESPN files games under (a week either way). The header's
 * search field narrows every section to the games whose teams or networks it names. The league
 * (`?league=nba`) and the day (`?day=YYYY-MM-DD`) live in the URL; the defaults leave their parameter
 * out, and a day picked in an earlier run of the app opens today (paths.ts). The filter is kept across
 * visits; the search is not.
 *
 * Below them, three sections: Live now (whatever day is picked: games in progress from today and
 * yesterday, whose late games run past midnight), then the picked day's Upcoming and Final games, so
 * a game never shows twice. Every league's games for the day are fetched (four small answers), so the
 * tabs can count them and switching league shows them at once; streams are matched only for the games
 * the league and search leave on screen.
 */

import { CalendarX2, SearchX, Tv } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';

import { DayStrip } from '../components/DayStrip';
import { GameCard } from '../components/GameCard';
import { LeagueFilter } from '../components/LeagueFilter';
import { SportsSkeleton } from '../components/SportsSkeleton';
import { useStreamContext, type StreamContext } from '../components/StreamList';
import { Button, EmptyState, ErrorState, FilterChip, Page, SectionHeader, buttonClass, useNow, useShell, useVisibleSources } from '../deps';
import { useGameStreams } from '../hooks/useGameStreams';
import { useLiveGames, useSportsDay } from '../hooks/useGames';
import { etDate, etDays } from '../lib/espn';
import { filterGames, leagueCounts, sectionGames } from '../lib/filter';
import type { StreamMatch } from '../lib/match';
import { LEAGUES, type Game, type League } from '../lib/types';
import { pickDay, readDay, readLeague, readStreamsOnly, writeStreamsOnly } from '../paths';

const DAY_PANEL = 'sports-day';

interface StreamsOf {
  (game: Game): { streams: readonly StreamMatch[] | undefined; streamsLoading: boolean };
}

function GameGrid({
  games,
  streamsOf,
  showStreams,
  showLeague,
  ctx,
}: {
  games: readonly Game[];
  streamsOf: StreamsOf;
  showStreams: boolean;
  showLeague: boolean;
  ctx: StreamContext;
}) {
  return (
    <ul className="grid items-start gap-3 md:grid-cols-2 xl:grid-cols-3">
      {games.map((g) => (
        <GameCard key={g.key} game={g} {...streamsOf(g)} showStreams={showStreams} showLeague={showLeague} ctx={ctx} />
      ))}
    </ul>
  );
}

function Section({ id, title, count, children }: { id: string; title: string; count: number; children: ReactNode }) {
  return (
    <section aria-labelledby={`sports-${id}-heading`} className="flex flex-col gap-3" data-testid={`sports-${id}`}>
      <SectionHeader id={`sports-${id}-heading`} title={title} count={count} />
      {children}
    </section>
  );
}

export function SportsPage() {
  const { t } = useTranslation('sports');
  const { setHeader } = useShell();
  const title = t('title');
  const placeholder = t('searchTeams');
  const [query, setQuery] = useState('');
  useEffect(() => {
    setHeader({ title, search: { value: query, onChange: setQuery, placeholder } });
  }, [setHeader, title, query, placeholder]);

  const now = useNow();
  const today = etDate(now);
  // The window moves with the Eastern date, not with every tick of the clock.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => etDays(now, 7, 7), [today]);

  const [params, setParams] = useSearchParams();
  const league = readLeague(params.get('league'));
  const day = readDay(params.get('day'), days, today);
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
  const [streamsOnly, setStreamsOnly] = useState(readStreamsOnly);
  const toggleStreamsOnly = (on: boolean) => {
    writeStreamsOnly(on);
    setStreamsOnly(on);
  };

  const sources = useVisibleSources();
  const sourceCount = sources.data?.length ?? 0;
  const hasSources = sourceCount > 0;
  const noSources = sources.data !== undefined && !hasSources;

  const allLive = useLiveGames(LEAGUES);
  const allDay = useSportsDay(day, LEAGUES);
  // Streams are matched for the league's games; the search only hides cards, so typing never moves the
  // guide window the matching reads.
  const leagueLive = useMemo(() => filterGames(allLive.games, league, ''), [allLive.games, league]);
  const leagueDay = useMemo(() => filterGames(allDay.games, league, ''), [allDay.games, league]);
  const dayKeys = useMemo(() => new Set(leagueDay.map((g) => g.key)), [leagueDay]);
  // Live games the day list also holds share its matches; the others (yesterday's late games, or
  // every live game while another day is picked) get a pass of their own, over their own window.
  const liveOnly = useMemo(() => leagueLive.filter((g) => !dayKeys.has(g.key)), [leagueLive, dayKeys]);
  const dayStreams = useGameStreams(leagueDay, hasSources);
  const liveStreams = useGameStreams(liveOnly, hasSources);
  const liveGames = useMemo(() => filterGames(leagueLive, null, query), [leagueLive, query]);
  const dayGames = useMemo(() => filterGames(leagueDay, null, query), [leagueDay, query]);
  const ctx = useStreamContext(now, sourceCount);

  const streamsOf: StreamsOf = (g) => {
    const from = dayKeys.has(g.key) ? dayStreams : liveStreams;
    return { streams: from.streams.get(g.key), streamsLoading: sources.isPending || from.loading };
  };
  const matching = sources.isPending || dayStreams.loading || liveStreams.loading;
  const hasStream = (g: Game) => (streamsOf(g).streams?.length ?? 0) > 0;
  // Nothing is hidden for want of a stream until matching is done, or where there is nothing to match.
  const filterStreams = streamsOnly && hasSources && !matching;
  const keep = (list: Game[]) => (filterStreams ? list.filter(hasStream) : list);

  const sections = useMemo(() => sectionGames(liveGames, dayGames), [liveGames, dayGames]);
  const live = keep(sections.live);
  const upcoming = keep(sections.upcoming);
  const final = keep(sections.final);
  const watchable = hasSources && !matching ? [...sections.live, ...sections.upcoming, ...sections.final].filter(hasStream).length : undefined;

  const counts = allDay.games.length > 0 || !allDay.loading ? leagueCounts(allDay.games) : undefined;
  const liveLeagues = useMemo(() => new Set<League>(allLive.games.map((g) => g.league)), [allLive.games]);
  const showLeague = league === null;
  const filtered = league !== null || query.trim() !== '' || filterStreams;
  const clearFilters = () => {
    setQuery('');
    toggleStreamsOnly(false);
    setParam('league', null);
  };

  const { loading, error, refetch } = allDay;
  const failed = error !== null && error !== undefined;
  const grid = (games: Game[]) => <GameGrid games={games} streamsOf={streamsOf} showStreams={hasSources} showLeague={showLeague} ctx={ctx} />;
  let body: ReactNode;
  if (allDay.games.length === 0 && loading) {
    body = <SportsSkeleton label={t('loading')} />;
  } else if (allDay.games.length === 0 && failed) {
    body = <ErrorState error={error} title={t('errorTitle')} hint={t('errorHint')} onRetry={refetch} />;
  } else if (allDay.games.length === 0) {
    body = <EmptyState icon={<CalendarX2 />} title={t('emptyDay')} description={t('emptyDayHint')} />;
  } else if (upcoming.length === 0 && final.length === 0 && live.length === 0) {
    // Every game of the day is filtered away (a live one may still lead the page above).
    body = (
      <EmptyState
        icon={<SearchX />}
        title={t('noMatches')}
        description={t('noMatchesHint')}
        action={
          filtered ? (
            <Button size="sm" variant="secondary" onClick={clearFilters} data-testid="sports-clear-filters">
              {t('clearFilters')}
            </Button>
          ) : undefined
        }
      />
    );
  } else {
    body = (
      <>
        {/* A league that failed while others answered: its last good games stay, with a way to ask again. */}
        {failed ? <ErrorState size="inline" error={error} title={t('errorTitle')} hint={t('errorHint')} onRetry={refetch} /> : null}
        {upcoming.length > 0 ? (
          <Section id="upcoming" title={t('upcoming')} count={upcoming.length}>
            {grid(upcoming)}
          </Section>
        ) : null}
        {final.length > 0 ? (
          <Section id="final" title={t('finalGames')} count={final.length}>
            {grid(final)}
          </Section>
        ) : null}
      </>
    );
  }

  return (
    <Page width="wide" className="flex min-w-0 flex-col gap-6 pb-10" data-testid="sports-page">
      {/* C16: the page's single h1; the shell header shows the same text as a paragraph. */}
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-w-0 flex-col gap-3" data-testid="sports-toolbar">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <LeagueFilter value={league} onChange={(next) => setParam('league', next)} counts={counts} live={liveLeagues} />
          {hasSources ? (
            <FilterChip
              pressed={streamsOnly}
              onClick={() => toggleStreamsOnly(!streamsOnly)}
              icon={<Tv aria-hidden size={14} className="shrink-0" />}
              count={watchable}
              title={t('withStreamsHint')}
              data-testid="sports-streams-only"
            >
              {t('withStreamsFilter')}
            </FilterChip>
          ) : null}
        </div>
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
      </div>
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
      {live.length > 0 ? (
        <Section id="live" title={t('liveNow')} count={live.length}>
          {grid(live)}
        </Section>
      ) : null}
      <div role="tabpanel" id={`${DAY_PANEL}-${day}`} aria-labelledby={`${DAY_PANEL}-tab-${day}`} className="flex min-w-0 flex-col gap-6" data-testid="sports-day-panel">
        {body}
      </div>
    </Page>
  );
}

export default SportsPage;
