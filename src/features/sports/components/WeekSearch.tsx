/**
 * The team search's answer for the coming week, when the picked day has no game it names: searching
 * a team mostly asks when it plays next. It reads the week's scoreboards on a press (React Query
 * keeps each day, so the day strip opens them at once afterwards) and lists the games the search
 * finds, each opening its day.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { EmptyState, formatClock, formatDay, SearchEverythingLink } from '../deps';
import { useSportsDays } from '../hooks/useGames';
import { filterGames } from '../lib/filter';
import { LEAGUES, type Game } from '../lib/types';
import { LEAGUE_SHORT_KEYS } from './LeagueFilter';

/** At most this many games: the next few are the answer, not the whole season. */
const SHOWN = 8;

/** Midday of an Eastern date on the viewer's calendar, so the formatter names that date. */
function localNoon(day: string): number {
  const [y = NaN, m = NaN, d = NaN] = day.split('-').map(Number);
  return new Date(y, m - 1, d, 12).getTime();
}

export function WeekSearch({ days, query, onPick }: { days: readonly string[]; query: string; onPick(game: Game): void }) {
  const { t, i18n } = useTranslation('sports');
  const lang = i18n.language;
  // Every league: a team plays in one, whichever tab is picked.
  const week = useSportsDays(days, LEAGUES);
  const found = useMemo(() => filterGames(week.games, null, query).slice(0, SHOWN), [week.games, query]);
  if (found.length === 0) {
    if (week.loading) {
      return (
        <p role="status" className="text-body-sm text-fg-muted" data-testid="sports-week-loading">
          {t('searchingWeek')}
        </p>
      );
    }
    // No game this week: the search of everything may still find the team's channel or a show about it.
    return (
      <EmptyState
        title={t('noTeamWeek', { query: query.trim() })}
        description={t('emptyDayHint')}
        action={<SearchEverythingLink query={query} size="sm" />}
      />
    );
  }
  return (
    <section aria-labelledby="sports-week-heading" className="flex flex-col gap-3" data-testid="sports-week">
      <h2 id="sports-week-heading" className="text-title-sm text-fg">
        {t('nextGames')}
      </h2>
      <ul className="flex max-w-2xl flex-col divide-y divide-divider overflow-hidden rounded-lg border border-edge bg-surface">
        {found.map((g) => {
          const time = g.timeValid && !g.timeNote ? formatClock(g.startMs, lang) : t('tbd');
          const leagueName = t(LEAGUE_SHORT_KEYS[g.league]);
          // On a phone the date sits over the matchup, with the league after it: in one row the date
          // column left the matchup half the width and cut every opponent ("Utah Jazz at Los An…").
          return (
            <li key={g.key}>
              <button
                type="button"
                onClick={() => onPick(g)}
                className="flex w-full min-w-0 flex-col items-start gap-0.5 px-3.5 py-2.5 text-start hover:bg-hover active:bg-active sm:flex-row sm:items-center sm:gap-3"
                data-testid="sports-week-game"
              >
                <span className="shrink-0 text-caption text-fg-muted tabular-nums sm:w-36">
                  {formatDay(localNoon(g.etDate), lang)} · {time}
                  <span className="sm:hidden"> · {leagueName}</span>
                </span>
                <span dir="auto" className="w-full min-w-0 truncate text-body-sm font-medium text-fg sm:w-auto sm:flex-1">
                  {t('matchup', { away: g.away.displayName, home: g.home.displayName })}
                </span>
                <span className="shrink-0 text-caption font-semibold text-fg-subtle max-sm:hidden">{leagueName}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
