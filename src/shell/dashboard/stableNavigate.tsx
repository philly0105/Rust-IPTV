/**
 * Home's `navigate`, which does not re-render its readers when a navigation starts.
 *
 * React Router's `useNavigate` reads the route context, and the router builds that context anew on
 * every router state change. So when a click on a rail link starts loading the next page, every
 * Home component that called `useNavigate` rendered again before Home went: each continue card,
 * channel card and On now card with its artwork, progress bar and glyphs, about 600 components
 * and a 70 ms task at a 4x CPU slowdown (P3-HOME-NAV). `StableNavigateProvider` calls
 * `useNavigate` once, near Home's root, where a re-render reaches no card, and hands its readers a
 * function that always calls the latest one.
 */

import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { useNavigate, type NavigateFunction } from 'react-router';

const StableNavigateContext = createContext<NavigateFunction | null>(null);

export function StableNavigateProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const latest = useRef(navigate);
  latest.current = navigate;
  const stable = useMemo(() => ((...args: Parameters<NavigateFunction>) => latest.current(...args)) as NavigateFunction, []);
  return <StableNavigateContext.Provider value={stable}>{children}</StableNavigateContext.Provider>;
}

/** The provider's navigate; outside one (a card rendered on its own), React Router's. */
export function useStableNavigate(): NavigateFunction {
  const stable = useContext(StableNavigateContext);
  // A mounted reader stays inside or outside the provider for its whole life, so the hook calls
  // below never change between its renders.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return stable ?? useNavigate();
}
