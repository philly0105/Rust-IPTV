/**
 * The guide window a match pass reads: the union of its games' match windows (`gameWindow`), and the page's
 * window that only grows while the day stays. A module of its own, so the page test runs it for real
 * beside its mocked stream hooks.
 */

import { useMemo, useState } from 'react';

import { gameWindow } from '../lib/espn';
import type { Game } from '../lib/types';

/** A span of time in ms, [`from`, `to`): the guide window a match pass reads. */
export interface GuideSpan {
  from: number;
  to: number;
}

/** The earliest start and latest end of the games' match windows; {0, 0} for no games. */
export function unionWindow(games: readonly Game[]): GuideSpan {
  let from = Infinity;
  let to = -Infinity;
  for (const g of games) {
    const w = gameWindow(g);
    from = Math.min(from, w.from);
    to = Math.max(to, w.to);
  }
  return games.length > 0 ? { from, to } : { from: 0, to: 0 };
}

/**
 * The guide window for one of the page's match passes: the union of the windows of every `games` it was
 * given since `key` (the picked day) last changed. It only grows, so a league tab whose games fit the span
 * already read, or a game going live or final, keeps the guide keys: the leagues' windows differ (an NFL
 * Sunday 12:30 PM to 1 AM, its NBA games 3 PM to 1:30 AM), and every tab press asked the whole guide again
 * (14 to 16 epg.grid calls with descriptions on a big account, about 44 MB on the test slate) and prepared
 * it again for matching, about 1.4 s in node (F5-1). The first visit asks what the games need, as before;
 * a wider league asks once more. Matches don't change: a programme counts only inside its game's window.
 */
export function useGrowingWindow(games: readonly Game[], key: string): GuideSpan {
  const next = useMemo(() => unionWindow(games), [games]);
  const [held, setHeld] = useState(() => ({ key, ...next }));
  let span = held;
  if (held.key !== key) span = { key, ...next };
  // No games give no window ({0, 0}), which must not stretch the span back to 1970.
  else if (games.length > 0 && held.to <= held.from) span = { key, ...next };
  else if (games.length > 0 && (next.from < held.from || next.to > held.to)) {
    span = { key, from: Math.min(held.from, next.from), to: Math.max(held.to, next.to) };
  }
  // Derived state: set during render, so the wider window is used in this render, not the next one.
  if (span !== held) setHeld(span);
  return span;
}
