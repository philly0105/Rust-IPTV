/**
 * One game: its status (LIVE with the clock, the final, the start time in the user's language and
 * zone, or a postponement), both teams with logos, ranks, records and scores, ESPN's notes and the
 * networks, a Gamecast link, then the matched streams. Team names, notes and network names are
 * ESPN's English text and stay as they are (dir="auto").
 */

import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge, LivePill, MetaLine, cn, formatClock, formatDay, openExternal } from '../deps';
import type { StreamMatch } from '../lib/match';
import type { Game, GameTeam } from '../lib/types';
import { StreamList, type StreamContext } from './StreamList';

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
          <span dir="auto" className="truncate text-body-sm font-medium text-fg tabular-nums" data-testid="sports-clock">
            {game.shortDetail || game.displayClock}
          </span>
        </span>
      );
    case 'final':
      return <span className="text-body-sm font-semibold text-fg">{finalLabel(game, t)}</span>;
    case 'postponed':
    case 'canceled':
    case 'suspended':
      return (
        <Badge variant="warning" data-testid="sports-phase-badge">
          {t(game.phase)}
        </Badge>
      );
    default: {
      if (!game.timeValid || game.timeNote) return <span className="text-body-sm text-fg-muted">{t('tbd')}</span>;
      const time = formatClock(game.startMs, lang);
      // A late Eastern game falls on the next day further east: say which.
      const label = localDate(game.startMs) === game.etDate ? time : t('dayTime', { day: formatDay(game.startMs, lang), time });
      return <span className="text-body-sm font-medium text-fg tabular-nums">{label}</span>;
    }
  }
}

function TeamRow({ team, game }: { team: GameTeam; game: Game }) {
  const { t } = useTranslation('sports');
  const lost = game.phase === 'final' && team.winner === false;
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="sports-team">
      {team.logo ? (
        <img src={team.logo} alt="" loading="lazy" decoding="async" className="size-8 shrink-0 object-contain" />
      ) : (
        <span aria-hidden className="size-8 shrink-0 rounded-full bg-surface-3" />
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
  ctx: StreamContext;
}

export function GameCard({ game, streams, streamsLoading, showStreams, ctx }: GameCardProps) {
  const { t } = useTranslation('sports');
  const title = t('matchup', { away: game.away.displayName, home: game.home.displayName });
  const networks = [...new Set(game.broadcasts.map((b) => b.name))];
  // A postponed or canceled game has nothing on air to offer.
  const playable = game.phase === 'live' || game.phase === 'final' || game.phase === 'scheduled';
  return (
    <li
      className={cn('flex min-w-0 flex-col gap-3 rounded-lg border bg-surface p-4', game.phase === 'live' ? 'border-live/40' : 'border-edge')}
      data-testid="sports-game"
      data-game={game.key}
      data-phase={game.phase}
    >
      <h3 className="sr-only">{title}</h3>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <GameStatus game={game} />
        {game.gamecastUrl ? (
          <a
            href={game.gamecastUrl}
            target="_blank"
            rel="noreferrer noopener"
            onClick={openExternal}
            className="inline-flex shrink-0 items-center gap-1 rounded-sm text-caption font-medium text-fg-muted hover:text-fg active:text-accent-pressed motion-safe:transition-colors"
            data-testid="sports-gamecast"
          >
            {t('gamecast')}
            <ExternalLink size={14} aria-hidden />
          </a>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <TeamRow team={game.away} game={game} />
        <TeamRow team={game.home} game={game} />
      </div>
      <MetaLine
        data-testid="sports-notes"
        items={[game.seriesSummary, game.note, game.timeNote].map((text, i) =>
          text ? (
            <span key={i} dir="auto">
              {text}
            </span>
          ) : null,
        )}
      />
      <MetaLine
        data-testid="sports-networks"
        items={networks.map((n) => (
          <span key={n} dir="auto">
            {n}
          </span>
        ))}
      />
      {showStreams && playable ? (
        <div className="border-t border-divider pt-2">
          <StreamList game={game} title={title} streams={streams} loading={streamsLoading} ctx={ctx} />
        </div>
      ) : null}
    </li>
  );
}
