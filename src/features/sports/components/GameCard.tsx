/**
 * One game, compact: a status line (the league when every league shows, LIVE with the clock, the
 * final, the start time in the user's language and zone, or a postponement, then the networks and a
 * menu to put the game's best stream on the multi-view wall while it is on, follow either team or
 * open ESPN's Gamecast), both teams with logos, ranks, records, scores
 * and a star on a followed team, ESPN's notes, then the matched streams. Team names, notes and
 * network names are ESPN's English text and stay as they are (dir="auto").
 */

import { ExternalLink, Star } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge, LivePill, Menu, MetaLine, cn, displayChannelName, formatClock, formatDay, openExternalUrl, useMultiviewMenuItem } from '../deps';
import { setFollowed, teamKey, useFollowedTeams } from '../hooks/useFollowedTeams';
import type { StreamMatch } from '../lib/match';
import type { Game, GameTeam } from '../lib/types';
import { LEAGUE_SHORT_KEYS } from './LeagueFilter';
import { StreamList, streamAction, type StreamContext } from './StreamList';

/** The viewer's local date of `t` as 'YYYY-MM-DD', to compare with a game's Eastern date. */
function localDate(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** "Final", or "Final/OT", "Final/2OT", "Final/10" (extra innings) from ESPN's short detail. */
function finalLabel(game: Game, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const extra = /^Final\/(\S+)$/i.exec(game.shortDetail.trim())?.[1];
  return extra ? t('finalAfter', { period: extra }) : t('final');
}

function GameStatus({ game }: { game: Game }) {
  const { t, i18n } = useTranslation('sports');
  const lang = i18n.language;
  switch (game.phase) {
    case 'live':
      return (
        <span className="flex min-w-0 items-center gap-2">
          <LivePill dot="still" />
          {/* ESPN's own clock line ("Q3 5:42", "Top 5th", "Halftime"). */}
          <span dir="auto" className="truncate font-medium text-fg tabular-nums" data-testid="sports-clock">
            {game.shortDetail || game.displayClock}
          </span>
        </span>
      );
    case 'final':
      return <span className="shrink-0 font-semibold whitespace-nowrap text-fg">{finalLabel(game, t)}</span>;
    case 'postponed':
    case 'canceled':
    case 'suspended':
      return (
        <Badge variant="warning" data-testid="sports-phase-badge">
          {t(game.phase)}
        </Badge>
      );
    default: {
      if (!game.timeValid || game.timeNote) return <span className="shrink-0 whitespace-nowrap text-fg-muted">{t('tbd')}</span>;
      const time = formatClock(game.startMs, lang);
      // A late Eastern game falls on the next day further east: say which.
      const label = localDate(game.startMs) === game.etDate ? time : t('dayTime', { day: formatDay(game.startMs, lang), time });
      // The time keeps its line and the networks after it truncate first ("8:00" never sits over "PM").
      return (
        <span className="shrink-0 font-medium whitespace-nowrap text-fg tabular-nums" data-testid="sports-start">
          {label}
        </span>
      );
    }
  }
}

function TeamRow({ team, game, followed }: { team: GameTeam; game: Game; followed: boolean }) {
  const { t } = useTranslation('sports');
  const lost = game.phase === 'final' && team.winner === false;
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="sports-team">
      {team.logo ? (
        <img src={team.logo} alt="" loading="lazy" decoding="async" className="size-7 shrink-0 object-contain" />
      ) : (
        <span aria-hidden className="size-7 shrink-0 rounded-full bg-surface-3" />
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        {team.rank !== null ? (
          <span className="shrink-0 text-caption text-fg-subtle tabular-nums">
            <span aria-hidden>{team.rank}</span>
            <span className="sr-only">{t('ranked', { rank: team.rank })}</span>
          </span>
        ) : null}
        <span dir="auto" className={cn('min-w-0 truncate text-body font-medium', lost ? 'text-fg-muted' : 'text-fg')}>
          {team.displayName}
        </span>
        {team.record ? <span className="shrink-0 text-caption text-fg-subtle tabular-nums">{team.record}</span> : null}
        {followed ? (
          <span className="shrink-0 self-center" data-testid="sports-team-followed">
            <Star aria-hidden size={12} className="fill-accent text-accent" />
            <span className="sr-only">{t('following')}</span>
          </span>
        ) : null}
      </span>
      {team.score !== null ? (
        <span className={cn('shrink-0 text-title-sm tabular-nums', lost ? 'text-fg-muted' : 'text-fg')} data-testid="sports-score">
          {team.score}
        </span>
      ) : null}
    </div>
  );
}

export interface GameCardProps {
  game: Game;
  streams: readonly StreamMatch[] | undefined;
  streamsLoading: boolean;
  /** False with no source: there is nothing to match against. */
  showStreams: boolean;
  /** Every league is on show: the card names its own. */
  showLeague: boolean;
  ctx: StreamContext;
  /** The page clock where the card's actions follow it, else a constant (`cardNow`). */
  now: number;
}

/**
 * Memoized: a poll leaves unchanged games as they were and their streams come from a per-game cache, so a
 * poll, a search keystroke or a clock tick re-renders only the cards whose game, streams or `now` moved.
 */
export const GameCard = memo(function GameCard({ game, streams, streamsLoading, showStreams, showLeague, ctx, now }: GameCardProps) {
  const { t } = useTranslation('sports');
  const title = t('matchup', { away: game.away.displayName, home: game.home.displayName });
  const networks = [...new Set(game.broadcasts.map((b) => b.name))];
  // A postponed or canceled game has nothing on air to offer.
  const playable = game.phase === 'live' || game.phase === 'final' || game.phase === 'scheduled';
  // A live game's down and distance leads ESPN's notes ("2nd & 7 at NO 35").
  const notes = [game.phase === 'live' ? game.situation : null, game.seriesSummary, game.note, game.timeNote].filter((n): n is string => !!n);
  const teams = useFollowedTeams();
  const follows = (team: GameTeam) => teams.has(teamKey(game.league, team));
  const menu = [game.away, game.home].map((team) => {
    const on = follows(team);
    return {
      id: `follow-${team.id}`,
      label: t(on ? 'unfollowTeam' : 'followTeam', { team: team.displayName }),
      icon: <Star aria-hidden size={15} className={cn(on && 'fill-accent text-accent')} />,
      onSelect: () => setFollowed(teamKey(game.league, team), !on),
    };
  });
  const gamecast = game.gamecastUrl;
  // While Watch is on offer (the game is on, or starts within 15 minutes), the menu puts the best
  // stream that plays it on the multi-view wall, so a Sunday's games can share the screen.
  const wallStream = streams?.find((m) => streamAction(game, m, now, ctx.canRecord, title)?.kind === 'watch');
  const wallItem = useMultiviewMenuItem(
    wallStream
      ? {
          ref: wallStream.channel.ref,
          title: displayChannelName(wallStream.channel.name, ctx.strip) || wallStream.channel.name,
          ...(wallStream.channel.logoUrl ? { logo: wallStream.channel.logoUrl } : {}),
          ...(wallStream.channel.number !== undefined ? { number: wallStream.channel.number } : {}),
          ...(wallStream.channel.categoryId ? { categoryId: wallStream.channel.categoryId } : {}),
        }
      : null,
  );
  // Four rows of the page's grid as a subgrid: the status line, the teams, the notes and the streams
  // each take one track shared with the other cards in the row, so every card in a row is as tall as
  // the tallest and the stream lists start on one line. The tracks have no gaps (the rows space
  // themselves with a top margin), so a card without notes keeps an empty track of no height.
  // Where subgrid is not supported the card is a plain four-row grid of its own.
  return (
    <li
      className={cn(
        'row-span-4 mb-3 grid min-w-0 grid-cols-1 grid-rows-subgrid rounded-lg border bg-surface p-3.5',
        game.phase === 'live' ? 'border-live/40' : 'border-edge',
      )}
      data-testid="sports-game"
      data-game={game.key}
      data-phase={game.phase}
    >
      <h3 className="sr-only">{title}</h3>
      <div className="flex min-w-0 items-center gap-3 text-body-sm">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {showLeague ? (
            <span className="shrink-0 text-caption font-semibold text-fg-subtle" data-testid="sports-game-league">
              {t(LEAGUE_SHORT_KEYS[game.league])}
            </span>
          ) : null}
          <GameStatus game={game} />
          {networks.length > 0 ? (
            // One line that truncates: a regional MLB game can list five networks, and the whole list
            // is in the tooltip. It takes only the room the status leaves (flex-1 grows from zero), so
            // it truncates before a live clock does. The dots are drawn, not spoken.
            <span className="flex min-w-0 flex-1 items-center gap-2 text-caption text-fg-muted" title={networks.join(', ')}>
              <span aria-hidden className="text-fg-subtle">
                ·
              </span>
              <span dir="auto" className="min-w-0 truncate">
                <span aria-hidden data-testid="sports-networks">
                  {networks.join(' · ')}
                </span>
                <span className="sr-only">{networks.join(', ')}</span>
              </span>
            </span>
          ) : null}
        </div>
        <Menu
          label={t('gameMenu', { title })}
          align="end"
          triggerClassName="-my-1.5 -me-1.5 size-8 shrink-0 text-fg-muted"
          items={[
            ...(wallStream ? [wallItem, { id: 'multiview-sep', type: 'separator' as const }] : []),
            ...menu,
            ...(gamecast
              ? [
                  { id: 'gamecast-sep', type: 'separator' as const },
                  { id: 'gamecast', label: t('gamecast'), icon: <ExternalLink aria-hidden size={15} />, onSelect: () => openExternalUrl(gamecast) },
                ]
              : []),
          ]}
        />
      </div>
      <div className="mt-2.5 flex min-w-0 flex-col gap-1.5">
        <TeamRow team={game.away} game={game} followed={follows(game.away)} />
        <TeamRow team={game.home} game={game} followed={follows(game.home)} />
      </div>
      {notes.length > 0 ? (
        <MetaLine
          className="row-start-3 mt-2.5 self-start text-caption text-fg-muted"
          data-testid="sports-notes"
          items={notes.map((text, i) => (
            <span key={i} dir="auto">
              {text}
            </span>
          ))}
        />
      ) : null}
      {showStreams && playable ? (
        <div className="row-start-4 -mx-1 mt-2.5 min-w-0 border-t border-divider px-1 pt-1">
          <StreamList game={game} title={title} streams={streams} loading={streamsLoading} ctx={ctx} now={now} />
        </div>
      ) : null}
    </li>
  );
});
