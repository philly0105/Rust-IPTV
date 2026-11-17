/**
 * /sports: NFL, college football, NBA and MLB games from ESPN's scoreboard (lib/espn.ts), with
 * the user's channels that carry each one (lib/match.ts).
 *
 * The controls sit together at the top: the league tabs with each league's count for the day, the
 * "My teams" filter (once a team is followed from a card's menu), the "With streams" filter, the "1080p+"
 * filter (the page's own: it hides the streams whose name marks a lower quality), and the Eastern day ESPN files
 * games under (a week either way). The header's search field narrows every
 * section to the games whose teams or networks it names. The league (`?league=nba`) and the day
 * (`?day=YYYY-MM-DD`) live in the URL; the defaults leave their parameter out, a URL without a league
 * opens the one picked last, and a day picked in an earlier run of the app opens today (paths.ts). The
 * filters and the league are kept across visits; the search is not.
 *
 * Below them, three sections: Live now (whatever day is picked: games in progress from today and
 * yesterday, whose late games run past midnight), then the picked day's Upcoming and Final games, so
 * a game never shows twice. Every league's games for the day are fetched (four small answers), so the
 * tabs can count them and switching league shows them at once; streams are matched only for the games
 * the league and search leave on screen.
 */

import { CalendarX2, Hd, SearchX, Star, TriangleAlert, Tv } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import type { ChannelQuality, Settings } from '@/api/types';
import { NoSourcesState, useNoSourcesAdding } from '@/features/sources/components/NoSourcesState';
import { channelQuality, qualityOrder } from '@/lib/channelQuality';

import { DayStrip } from '../components/DayStrip';
import { GameCard } from '../components/GameCard';
import { LEAGUE_KEYS, LeagueFilter } from '../components/LeagueFilter';
import { GRID_COLUMNS, SportsSkeleton } from '../components/SportsSkeleton';
import { QUALITY_LABEL, useStreamContext, type StreamContext } from '../components/StreamList';
import { WeekSearch } from '../components/WeekSearch';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterChip,
  Page,
  SearchEverythingLink,
  SectionHeader,
  TEXT_LINK,
  cn,
  intlLocale,
  useNow,
  useSettingsValue,
  useShell,
  useToast,
  useVisibleSources,
} from '../deps';
import { followsGame, useFollowedTeams } from '../hooks/useFollowedTeams';
import { useGameStreams } from '../hooks/useGameStreams';
import { useLiveGames, useSportsDay } from '../hooks/useGames';
import { etDate, etDays } from '../lib/espn';
import { filterGames, leagueCounts, sectionGames } from '../lib/filter';
import type { StreamMatch } from '../lib/match';
import { LEAGUES, type Game, type League } from '../lib/types';
import {
  pickDay,
  readDay,
  readHdOnly,
  readLeague,
  readMyTeamsOnly,
  readRememberedLeague,
  readStreamsOnly,
  rememberLeague,
  writeHdOnly,
  writeMyTeamsOnly,
  writeStreamsOnly,
} from '../paths';

const DAY_PANEL = 'sports-day';

/**
 * From a tablet up, on a window at least 40rem tall, the toolbar stays at the top of the page's
 * scroller while the cards scroll under it, so a 15-game day never needs a scroll back up to change
 * day or league. Not on a phone or a short window, where its three rows would hold a fifth of the
 * screen for good. Written out whole, so Tailwind finds the classes.
 */
const PINNED = '[@media(min-width:48rem)_and_(min-height:40rem)]:sticky [@media(min-width:48rem)_and_(min-height:40rem)]:top-0';
/** A control focused from the keyboard scrolls clear of the pinned toolbar, not under it. */
const CLEAR_PINNED = '[@media(min-width:48rem)_and_(min-height:40rem)]:[&_button]:scroll-mt-32';

/**
 * A filter chip on a phone, beside the day strip, while it is off: its icon and count, with the label
 * hidden but still the chip's name. The label's empty box would leave two gaps between the icon and the
 * count, so the gap goes and the icon keeps one of its own. Turned on, the chip says its name, so what
 * hides games is never only an icon.
 */
const COMPACT_CHIP = 'max-sm:gap-0 max-sm:px-3 max-sm:[&>svg]:me-1.5';
const compactChip = (pressed: boolean) => (pressed ? undefined : COMPACT_CHIP);
const compactLabel = (pressed: boolean) => (pressed ? undefined : 'max-sm:sr-only');

/** What the quality chip turns on: Full HD (1080p) and up. */
const QUALITY_FLOOR: ChannelQuality = 'fhd';

const selectMinQuality = (s: Settings) => s.liveMinQuality ?? null;

/**
 * The streams whose channel name marks no quality below {@link QUALITY_FLOOR}. A name that marks none
 * stays, as Live TV keeps untagged channels by default: most per-game event channels name no quality.
 */
function atFloor(streams: ReadonlyMap<string, StreamMatch[]>): ReadonlyMap<string, StreamMatch[]> {
  const out = new Map<string, StreamMatch[]>();
  for (const [key, list] of streams) {
    out.set(
      key,
      list.filter((m) => {
        const q = channelQuality(m.channel.name);
        return q === null || qualityOrder(q) >= qualityOrder(QUALITY_FLOOR);
      }),
    );
  }
  return out;
}

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
  // Each card spans four rows of this grid as a subgrid (GameCard), so the cards in a row share one
  // height and their status lines, teams, notes and streams line up across it. The grid has no row
  // gap, since a subgrid's tracks keep its parent's gutters and a card without notes would show
  // two of them around its empty track: the cards' bottom margin spaces the rows instead, and the
  // list takes the last one back. The columns follow the page's width, not the window's: as many
  // cards of at least 22rem as fit, so a card keeps room for a stream row beside the rail.
  return (
    <ul className={cn('-mb-3 grid gap-x-3', GRID_COLUMNS, CLEAR_PINNED)} data-testid="sports-grid">
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
  const { t, i18n } = useTranslation('sports');
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
  // The URL's league, else the one picked last (a page opened from the rail names none).
  const [remembered, setRemembered] = useState(readRememberedLeague);
  const league = params.has('league') ? readLeague(params.get('league')) : remembered;
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
  // "1080p+" is the page's own filter, kept on this device: it never changes Live TV's quality filter,
  // which hides channels everywhere. That one, set on Live TV, the core applies to every channel list the
  // page reads; while it hides everything below 1080p (Full HD or 4K only) the chip shows as on, and says
  // where to change it.
  const { toast } = useToast();
  const liveMin = useSettingsValue(selectMinQuality).data ?? null;
  const liveFloor = liveMin === 'fhd' || liveMin === 'uhd';
  const [hdOnly, setHdOnly] = useState(readHdOnly);
  const qualityOn = hdOnly || liveFloor;
  const qualityLabel = QUALITY_LABEL[QUALITY_FLOOR];
  const followed = useFollowedTeams();
  const [myTeamsOnly, setMyTeamsOnly] = useState(readMyTeamsOnly);
  const toggleMyTeamsOnly = (on: boolean) => {
    writeMyTeamsOnly(on);
    setMyTeamsOnly(on);
  };
  // With no team followed the chip is gone, so its filter must not hide anything either, and it is off
  // again when the last team goes: following a team later must not hide every other game at once.
  const filterMyTeams = myTeamsOnly && followed.size > 0;
  useEffect(() => {
    if (followed.size === 0 && myTeamsOnly) {
      writeMyTeamsOnly(false);
      setMyTeamsOnly(false);
    }
  }, [followed.size, myTeamsOnly]);

  const sources = useVisibleSources();
  const sourceCount = sources.data?.length ?? 0;
  const hasSources = sourceCount > 0;
  // The banner stays while its add dialog is open: the new source is listed before its import
  // runs, and dropping the banner then would close the dialog mid-import.
  const adding = useNoSourcesAdding();
  const noSources = (sources.data !== undefined && !hasSources) || adding;

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
  const liveGames = useMemo(
    () => filterGames(leagueLive, null, query).filter((g) => !filterMyTeams || followsGame(followed, g)),
    [leagueLive, query, filterMyTeams, followed],
  );
  const dayGames = useMemo(
    () => filterGames(leagueDay, null, query).filter((g) => !filterMyTeams || followsGame(followed, g)),
    [leagueDay, query, filterMyTeams, followed],
  );
  // Part of the channel index failed: a game with no stream may have one the page couldn't look through.
  const streamsError = hasSources ? (dayStreams.error ?? liveStreams.error ?? null) : null;
  // Part of the guide failed: games still match by channel name, and the page says so once, quietly.
  const guideError = hasSources && streamsError === null ? (dayStreams.guideError ?? liveStreams.guideError ?? null) : null;
  const retryStreams = () => {
    dayStreams.retry();
    liveStreams.retry();
  };
  const ctx = useStreamContext(now, sourceCount, hdOnly, streamsError !== null);
  // Live TV's filter has already left the lower qualities out of the index.
  const floorStreams = hdOnly && !liveFloor;
  const dayMatches = useMemo(() => (floorStreams ? atFloor(dayStreams.streams) : dayStreams.streams), [floorStreams, dayStreams.streams]);
  const liveMatches = useMemo(() => (floorStreams ? atFloor(liveStreams.streams) : liveStreams.streams), [floorStreams, liveStreams.streams]);

  const streamsOf: StreamsOf = (g) => {
    const live = !dayKeys.has(g.key);
    const from = live ? liveStreams : dayStreams;
    return { streams: (live ? liveMatches : dayMatches).get(g.key), streamsLoading: sources.isPending || from.loading };
  };
  const matching = sources.isPending || dayStreams.loading || liveStreams.loading;
  const hasStream = (g: Game) => (streamsOf(g).streams?.length ?? 0) > 0;
  // Nothing is hidden for want of a stream until matching is done, or where there is nothing to match or
  // the channels couldn't be read.
  const filterStreams = streamsOnly && hasSources && !matching && streamsError === null;
  const keep = (list: Game[]) => (filterStreams ? list.filter(hasStream) : list);

  const sections = useMemo(() => sectionGames(liveGames, dayGames), [liveGames, dayGames]);
  const live = keep(sections.live);
  const upcoming = keep(sections.upcoming);
  const final = keep(sections.final);
  const { loading, error, refetch, failedLeagues } = allDay;
  const failed = error !== null && error !== undefined;
  // Nothing counted yet (the day still loading, or ESPN failed with nothing to show): no number, not a 0.
  const uncounted = allDay.games.length === 0 && (loading || failed);
  const watchable =
    hasSources && !matching && !uncounted && streamsError === null ? [...sections.live, ...sections.upcoming, ...sections.final].filter(hasStream).length : undefined;

  // A league that failed with no games kept has no count either; the others still have theirs. While a
  // team search is on, the tabs count the games it finds, as With streams does: one toolbar, one kind of number.
  const counts = useMemo(() => {
    if (uncounted) return undefined;
    const all: Partial<Record<League, number>> = leagueCounts(filterGames(allDay.games, null, query));
    for (const l of failedLeagues) delete all[l];
    return all;
  }, [uncounted, allDay.games, failedLeagues, query]);
  const liveLeagues = useMemo(() => new Set<League>(filterGames(allLive.games, null, query).map((g) => g.league)), [allLive.games, query]);
  const showLeague = league === null;
  const myTeamsCount = useMemo(
    () => (followed.size > 0 ? [...new Set([...leagueLive, ...leagueDay].filter((g) => followsGame(followed, g)).map((g) => g.key))].length : 0),
    [leagueLive, leagueDay, followed],
  );
  const filtered = league !== null || query.trim() !== '' || filterStreams || filterMyTeams;
  const pickLeague = (next: League | null) => {
    rememberLeague(next);
    setRemembered(next);
    setParam('league', next);
  };
  // A day, league or filter changed from the pinned toolbar part way down a long day would open the
  // new list part way down too, its first rows under the toolbar: the shell's scroll memory only
  // starts a new page at the top. While the toolbar is pinned (its top on the scroller's), the page
  // goes back to the top first. Unpinned, the toolbar is only in reach near the top anyway.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const backToTop = () => {
    const bar = toolbarRef.current;
    const main = bar?.closest<HTMLElement>('#main');
    if (!bar || !main || main.scrollTop === 0) return;
    if (Math.abs(bar.getBoundingClientRect().top - main.getBoundingClientRect().top) < 1) main.scrollTop = 0;
  };
  // A team search with no game on the picked day can look through the days after it (on a press:
  // up to 28 scoreboards), and a game found there opens its day, in every league if need be.
  const [weekSearch, setWeekSearch] = useState(false);
  if (weekSearch && !query.trim()) setWeekSearch(false);
  const dayAt = days.indexOf(day);
  const weekDays = useMemo(() => days.slice(dayAt + 1, dayAt + 8), [days, dayAt]);
  const openWeekGame = (g: Game) => {
    backToTop();
    pickDay(g.etDate);
    const otherLeague = league !== null && g.league !== league;
    if (otherLeague) {
      rememberLeague(null);
      setRemembered(null);
    }
    // One update for both, or the second would bring back what the first took out.
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (otherLeague) p.delete('league');
        if (g.etDate === today) p.delete('day');
        else p.set('day', g.etDate);
        return p;
      },
      { replace: true },
    );
  };
  const clearFilters = () => {
    setQuery('');
    toggleStreamsOnly(false);
    toggleMyTeamsOnly(false);
    pickLeague(null);
  };

  // A league that failed while others answered is named, so its missing games and count are explained.
  const failedNames = failedLeagues.map((l) => t(LEAGUE_KEYS[l]));
  const errorTitle =
    failedNames.length > 0 && failedNames.length < LEAGUES.length
      ? t('errorLeague', { league: new Intl.ListFormat(intlLocale(i18n.language), { type: 'conjunction' }).format(failedNames) })
      : t('errorTitle');
  const grid = (games: Game[]) => <GameGrid games={games} streamsOf={streamsOf} showStreams={hasSources} showLeague={showLeague} ctx={ctx} />;
  let body: ReactNode;
  if (allDay.games.length === 0 && loading) {
    body = <SportsSkeleton label={t('loading')} />;
  } else if (allDay.games.length === 0 && failed) {
    body = <ErrorState error={error} title={t('errorTitle')} hint={t('errorHint')} onRetry={refetch} />;
  } else if (allDay.games.length === 0) {
    body = <EmptyState icon={<CalendarX2 />} title={t('emptyDay')} description={t('emptyDayHint')} />;
  } else if (league !== null && leagueDay.length === 0 && failedLeagues.includes(league)) {
    body = <ErrorState error={error} title={errorTitle} hint={t('errorHint')} onRetry={refetch} />;
  } else if (league !== null && leagueDay.length === 0 && !query.trim() && !filterStreams && !filterMyTeams) {
    // The league has no games that day: nothing was filtered, so there is nothing to clear.
    body = (
      <EmptyState
        icon={<CalendarX2 />}
        title={t('emptyLeagueDay', { league: t(LEAGUE_KEYS[league]) })}
        description={t('emptyLeagueDayHint')}
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              backToTop();
              pickLeague(null);
            }}
            data-testid="sports-all-leagues"
          >
            {t('showAllLeagues')}
          </Button>
        }
      />
    );
  } else if (query.trim() !== '' && filterGames(leagueDay, null, query).length === 0) {
    // The search names no game of the day: the question is mostly when the team plays next.
    body = weekSearch ? (
      <WeekSearch days={weekDays} query={query} onPick={openWeekGame} />
    ) : (
      <EmptyState
        icon={<SearchX />}
        title={t('noTeamGame', { query: query.trim() })}
        description={weekDays.length > 0 ? t('noTeamGameHint') : t('noMatchesHint')}
        action={
          weekDays.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setWeekSearch(true)} data-testid="sports-search-week">
              {t('searchWeek')}
            </Button>
          ) : (
            <SearchEverythingLink query={query} size="sm" />
          )
        }
      />
    );
  } else if (keep(dayGames).length === 0) {
    // Every game of the day is filtered away; Live now may still show games of today or yesterday above.
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
        {failed ? <ErrorState size="inline" error={error} title={errorTitle} hint={t('errorHint')} onRetry={refetch} /> : null}
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
      {/* Pinned, it covers the cards under it with the page's own colour, and keeps a strip of it above
          the league tabs (the margin takes back the padding where it is not pinned). The day tabs'
          rule is its bottom edge.
          On a phone it is two rows, not three: the league tabs across the width, then the day strip
          with the filter chips at its end, drawn as their icon and count while off (their label stays
          their name) and "1080p+" in words. The chips' own row held a sixth of the first screen for one or two small chips. The
          first row's box steps aside there (display: contents), so its two parts sit on the grid. */}
      <div
        ref={toolbarRef}
        className={cn('z-10 -mt-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-y-3 bg-bg pt-3 sm:flex sm:flex-col sm:gap-3', PINNED)}
        data-testid="sports-toolbar"
      >
        <div className="contents sm:flex sm:min-w-0 sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          <LeagueFilter
            className="max-sm:col-span-2"
            value={league}
            onChange={(next) => {
              backToTop();
              pickLeague(next);
            }}
            counts={counts}
            live={liveLeagues}
          />
          {followed.size > 0 || hasSources ? (
            <div className="flex items-center gap-2 max-sm:col-start-2 max-sm:row-start-2 max-sm:ms-2 sm:flex-wrap" data-testid="sports-filters">
              {followed.size > 0 ? (
                <FilterChip
                  pressed={myTeamsOnly}
                  onClick={() => {
                    backToTop();
                    toggleMyTeamsOnly(!myTeamsOnly);
                  }}
                  className={compactChip(myTeamsOnly)}
                  icon={<Star aria-hidden size={14} className={myTeamsOnly ? 'shrink-0 fill-current' : 'shrink-0'} />}
                  count={myTeamsCount}
                  title={t('myTeamsHint')}
                  data-testid="sports-my-teams"
                >
                  <span className={compactLabel(myTeamsOnly)}>{t('myTeams')}</span>
                </FilterChip>
              ) : null}
              {hasSources ? (
                <FilterChip
                  pressed={streamsOnly}
                  onClick={() => {
                    backToTop();
                    toggleStreamsOnly(!streamsOnly);
                  }}
                  className={compactChip(streamsOnly)}
                  icon={<Tv aria-hidden size={14} className="shrink-0" />}
                  count={watchable}
                  title={t('withStreamsHint')}
                  data-testid="sports-streams-only"
                >
                  <span className={compactLabel(streamsOnly)}>{t('withStreamsFilter')}</span>
                </FilterChip>
              ) : null}
              {hasSources ? (
                <FilterChip
                  pressed={qualityOn}
                  onClick={() => {
                    // Live TV's filter is on: the chip can't loosen it from here, so a press (or a tap,
                    // with no tooltip to read) says where it is set.
                    if (liveFloor) {
                      toast({ title: t('qualityLiveOn', { quality: qualityLabel }) });
                      return;
                    }
                    backToTop();
                    writeHdOnly(!hdOnly);
                    setHdOnly(!hdOnly);
                  }}
                  // On a phone, the words alone: an HD glyph said nothing on a touch screen, where its
                  // tooltip never shows, and "1080p+" is about as narrow.
                  className="max-sm:px-3"
                  icon={<Hd aria-hidden size={14} className="shrink-0 max-sm:hidden" />}
                  title={liveFloor ? t('qualityLiveOn', { quality: qualityLabel }) : t('qualityHint', { quality: qualityLabel })}
                  data-testid="sports-quality"
                >
                  {`${qualityLabel}+`}
                </FilterChip>
              ) : null}
            </div>
          ) : null}
        </div>
        <DayStrip
          className="max-sm:col-start-1 max-sm:row-start-2"
          days={days}
          value={day}
          today={today}
          onChange={(d) => {
            backToTop();
            pickDay(d);
            setParam('day', d === today ? null : d);
          }}
          panelIdPrefix={DAY_PANEL}
        />
      </div>
      {noSources ? (
        // One short row over the day's games, which still list without a source.
        <NoSourcesState layout="banner" icon={<Tv />} title={t('noSourcesTitle')} description={t('noSourcesHint')} testId="sports-add-source" stateTestId="sports-no-sources" stay />
      ) : null}
      {streamsError !== null && allDay.games.length > 0 ? (
        // One message for the page, not "No stream found" on every card: the cards say they couldn't check.
        <ErrorState
          size="inline"
          error={streamsError}
          title={t('streamsErrorTitle')}
          onRetry={retryStreams}
        />
      ) : null}
      {guideError !== null && allDay.games.length > 0 ? (
        <p role="status" className="-mt-2 flex items-start gap-2 text-caption text-fg-muted" data-testid="sports-guide-failed">
          <TriangleAlert aria-hidden size={14} className="mt-px shrink-0 text-warning" />
          <span>
            {t('guideErrorNote')}{' '}
            <button type="button" className={TEXT_LINK} onClick={retryStreams} data-testid="sports-guide-retry">
              {t('common:retry')}
            </button>
          </span>
        </p>
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
