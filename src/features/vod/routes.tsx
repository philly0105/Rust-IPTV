import type { RouteObject } from 'react-router';

const searchPage = (scoped: boolean): RouteObject['lazy'] => async () => {
  const { SearchPage } = await import('./pages/SearchPage');
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
  { path: 's/:sourceId/movie/:itemId', lazy: async () => ({ Component: (await import('./pages/MovieDetailPage')).MovieDetailPage }) },
  { path: 's/:sourceId/series', lazy: landingPage('series') },
  { path: 's/:sourceId/series/c/:categoryId', lazy: categoryPage('series') },
  { path: 's/:sourceId/series/:itemId', lazy: async () => ({ Component: (await import('./pages/SeriesDetailPage')).SeriesDetailPage }) },
  { path: 's/:sourceId/actor/:personId', lazy: async () => ({ Component: (await import('./pages/ActorPage')).ActorPage }) },
];
