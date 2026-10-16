/**
 * Watch stats (contract C7): time watched per day, top channels and top
 * titles.
 *
 * - `useWatchStatsReporter`: mounted once in the shell effects; reports the
 *   player's watch time to the core (`stats.record`). Small and i18n-free,
 *   so it can sit in the entry chunk.
 * - `statsRoutes`: `/stats`, the page (a lazy chunk).
 * - `STATS_PATH`: the page's path, for the rail and the command palette.
 */

export { useWatchStatsReporter } from './reporter';
export { statsRoutes } from './routes';
export { STATS_PATH } from './paths';
