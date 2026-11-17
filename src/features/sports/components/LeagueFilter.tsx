/**
 * All, NFL, College Football, NBA, MLB: pill tabs that pick the league every section shows. Each
 * names how many games the picked day holds, and a red dot marks a league with a game on now.
 */

import { useTranslation } from 'react-i18next';

import { Tabs, cn } from '../deps';
import { LEAGUES, type League } from '../lib/types';

export const LEAGUE_KEYS: Record<League, string> = { nfl: 'leagueNfl', cfb: 'leagueCfb', nba: 'leagueNba', mlb: 'leagueMlb' };
/** Where room is short (the tab row below a 1280 px window, a card's status line): "NCAAF" for college football. */
export const LEAGUE_SHORT_KEYS: Record<League, string> = { nfl: 'leagueNfl', cfb: 'leagueCfbShort', nba: 'leagueNba', mlb: 'leagueMlb' };

const ALL = 'all';

function Label({ text, short, count, live, liveLabel }: { text: string; short?: string; count?: number; live: boolean; liveLabel: string }) {
  // A league with no games that day reads as empty before it is picked: its name is quiet too.
  const empty = count === 0;
  return (
    <>
      {/* In the pill's top corner, as a notification dot, so it takes no width: in the row it pushed
          MLB onto a second line on a phone, and the filter chips onto a third toolbar row at 1024. */}
      {live ? (
        <span aria-hidden className="absolute end-1 top-1 size-1.5 rounded-full bg-live" data-testid="sports-league-live" />
      ) : null}
      {/* Below a 1280 px window the short name shows, so the five tabs fit one row on a phone and leave
          the filter chips their row on a tablet; the full name is still the tab's name. */}
      {short && short !== text ? (
        <>
          <span aria-hidden className={cn('xl:hidden', empty && 'text-fg-subtle')}>
            {short}
          </span>
          <span className={cn('max-xl:sr-only', empty && 'text-fg-subtle')}>{text}</span>
        </>
      ) : (
        <span className={cn(empty && 'text-fg-subtle')}>{text}</span>
      )}
      {/* The spaces are not drawn in the tab's flex row; they keep its name "NBA 7, Live now". */}
      {count !== undefined ? (
        <>
          {' '}
          <span className="tabular-nums text-fg-subtle">{count}</span>
        </>
      ) : null}
      {live ? <span className="sr-only">{`, ${liveLabel}`}</span> : null}
    </>
  );
}

export function LeagueFilter({
  value,
  onChange,
  counts,
  live,
  className,
}: {
  value: League | null;
  onChange(next: League | null): void;
  /** Games of the picked day per league; left out while the day loads, and a league's left out when it failed. */
  counts?: Partial<Record<League, number>>;
  /** Leagues with a game in progress. */
  live: ReadonlySet<League>;
  className?: string;
}) {
  const { t } = useTranslation('sports');
  // All counts only when every league answered: a sum without a failed league would be too low.
  const total = counts && LEAGUES.every((l) => counts[l] !== undefined) ? LEAGUES.reduce((sum, l) => sum + (counts[l] ?? 0), 0) : undefined;
  const liveLabel = t('liveNow');
  return (
    <div data-testid="sports-leagues" className={cn('max-w-full min-w-0', className)}>
      {/* Five pills are wider than a phone in most languages, and pill tabs scroll with no fade or
          scrollbar, so the row wraps instead of hiding its last leagues. */}
      <Tabs
        variant="pill"
        // Tighter pills on a phone, where the five tabs must share about 360 px. There the track spans
        // the row and the pills share what is left, so it doesn't stop short of the edge by a ragged gap.
        className="flex-wrap [&>button]:relative max-sm:[&>button]:grow max-sm:[&>button]:px-2"
        label={t('leagues')}
        value={value ?? ALL}
        onChange={(id) => onChange(LEAGUES.find((l) => l === id) ?? null)}
        items={[
          { id: ALL, label: <Label text={t('leagueAll')} count={total} live={live.size > 0} liveLabel={liveLabel} /> },
          ...LEAGUES.map((l) => ({
            id: l,
            label: <Label text={t(LEAGUE_KEYS[l])} short={t(LEAGUE_SHORT_KEYS[l])} count={counts?.[l]} live={live.has(l)} liveLabel={liveLabel} />,
          })),
        ]}
      />
    </div>
  );
}
