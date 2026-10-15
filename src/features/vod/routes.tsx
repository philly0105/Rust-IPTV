import type { RouteObject } from 'react-router';

/** Route chunk loaders, shared with the hover prefetch (C4) so a prefetched chunk is the one the route opens. */
export const loadSearchPage = () => import('./pages/SearchPage');
export const loadMovieDetailPage = () => import('./pages/MovieDetailPage');
export const loadSeriesDetailPage = () => import('./pages/SeriesDetailPage');

const searchPage = (scoped: boolean): RouteObject['lazy'] => async () => {
  const { SearchPage } = await loadSearchPage();
  return { element: <SearchPage scoped={scoped} /> };
};
const landingPage = (kind: 'movie' | 'series'): RouteObject['lazy'] => async () => {
  const { VodLandingPage } = await import('./pages/VodLandingPage');
  return { element: <VodLandingPage kind={kind} /> };
};
const categoryPage = (kind: 'movie' | 'series'): RouteObject['lazy'] => async () => {
  const { CategoryGridPage } = await import('./pages/CategoryGridPage');
  return { element: <CategoryGridPage kind={kind} /> };
};

/** C7: movies, series, detail, actor, and both search routes. Mounted as children of the shell layout route. Pages load lazily. */
export const vodRoutes: RouteObject[] = [
  { path: 'search', lazy: searchPage(false) },
  { path: 's/:sourceId/search', lazy: searchPage(true) },
  { path: 's/:sourceId/movies', lazy: landingPage('movie') },
  { path: 's/:sourceId/movies/c/:categoryId', lazy: categoryPage('movie') },
  { path: 's/:sourceId/movie/:itemId', lazy: async () => ({ Component: (await loadMovieDetailPage()).MovieDetailPage }) },
  { path: 's/:sourceId/series', lazy: landingPage('series') },
  { path: 's/:sourceId/series/c/:categoryId', lazy: categoryPage('series') },
  { path: 's/:sourceId/series/:itemId', lazy: async () => ({ Component: (await loadSeriesDetailPage()).SeriesDetailPage }) },
  { path: 's/:sourceId/actor/:personId', lazy: async () => ({ Component: (await import('./pages/ActorPage')).ActorPage }) },
];
