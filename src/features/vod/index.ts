/** Public surface of the VOD feature (movies, series, detail, actor, search). */
export { vodRoutes } from './routes';
export { PosterCard, PosterCardSkeleton, type PosterCardProps } from './components/PosterCard';
export { PosterRail, type PosterRailProps } from './components/PosterRail';
export { TmdbRail, searchHref } from './components/TmdbRail';
export { TmdbAttribution, TmdbLogo, TMDB_HOME } from './components/TmdbAttribution';
export { episodeSubtitle, downloadFileName } from './lib/format';
export { mergeMovieDetail, mergeSeriesDetail, mergeSeasonEpisodes, type DetailModel } from './lib/merge';
export { detailHref, groupSearchResults, normalizeQuery, type SearchGroup, type SearchHit } from './lib/search';
