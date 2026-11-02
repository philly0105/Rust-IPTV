import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, type NavigateFunction, type NavigateOptions, type To } from 'react-router';

/**
 * The location's pathname alone, for the shell's always-mounted readers: the rail and the command
 * palette (F1-3). The router hands every `useLocation` reader a new location for each typed `?q=`
 * (Favorites, Recently watched and My List search replace it per keystroke), so the rail re-rendered
 * whole, 54 components per keystroke, though only a pathname change moves it.
 *
 * The provider reads the location and passes on the string: a search-only change re-renders the
 * provider, whose children are the same elements, and no reader. It follows the router's own
 * context, so it changes in the same render as the page; a `router.subscribe` store would run ahead
 * of RouterProvider's transition and mark the new page in the rail a frame before it shows.
 */
const PathnameContext = createContext<string | null>(null);

/**
 * A navigate that never changes, for the same readers. react-router's `useNavigate` reads the route
 * context, which the router builds again on every location change, `?q=` included, so each caller
 * re-rendered per keystroke whatever else it read: every rail source entry with the links under it
 * (2 entries and 6 links per keystroke on a two-source rail), and the palette with its five item
 * hooks from its first opening on. This one forwards to the provider's own.
 */
const NavigateContext = createContext<NavigateFunction | null>(null);

export function PathnameProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const latest = useRef(navigate);
  latest.current = navigate;
  const [stable] = useState(() => ((to: To | number, options?: NavigateOptions) =>
    typeof to === 'number' ? latest.current(to) : latest.current(to, options)) as NavigateFunction);
  return (
    <NavigateContext.Provider value={stable}>
      <PathnameContext.Provider value={pathname}>{children}</PathnameContext.Provider>
    </NavigateContext.Provider>
  );
}

/** The current pathname; re-renders only when it changes under a {@link PathnameProvider}. */
export function usePathname(): string {
  const provided = useContext(PathnameContext);
  // Without the shell above (a test that renders the rail alone) it reads the location itself.
  // Whether a provider is above never changes for a mounted component, so the hook order holds.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return provided ?? useLocation().pathname;
}

/** `useNavigate` that never re-renders its caller under a {@link PathnameProvider}. */
export function useStableNavigate(): NavigateFunction {
  const provided = useContext(NavigateContext);
  // As usePathname: the router's own without the shell above.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return provided ?? useNavigate();
}
