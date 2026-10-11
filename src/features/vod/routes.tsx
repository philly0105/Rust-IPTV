import type { RouteObject } from 'react-router';

import { ActorPage } from './pages/ActorPage';
import { CategoryGridPage } from './pages/CategoryGridPage';
import { MovieDetailPage } from './pages/MovieDetailPage';
import { SearchPage } from './pages/SearchPage';
import { SeriesDetailPage } from './pages/SeriesDetailPage';
import { VodLandingPage } from './pages/VodLandingPage';

/** C7: movies, series, detail, actor, and both search routes. Mounted as children of the shell layout route. */
export const vodRoutes: RouteObject[] = [
  { path: 'search', element: <SearchPage /> },
  { path: 's/:sourceId/search', element: <SearchPage scoped /> },
  { path: 's/:sourceId/movies', element: <VodLandingPage kind="movie" /> },
  { path: 's/:sourceId/movies/c/:categoryId', element: <CategoryGridPage kind="movie" /> },
  { path: 's/:sourceId/movie/:itemId', element: <MovieDetailPage /> },
  { path: 's/:sourceId/series', element: <VodLandingPage kind="series" /> },
  { path: 's/:sourceId/series/c/:categoryId', element: <CategoryGridPage kind="series" /> },
  { path: 's/:sourceId/series/:itemId', element: <SeriesDetailPage /> },
  { path: 's/:sourceId/actor/:personId', element: <ActorPage /> },
];
