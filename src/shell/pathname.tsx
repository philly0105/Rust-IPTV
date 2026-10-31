import { createContext, useContext, type ReactNode } from 'react';
import { useLocation } from 'react-router';

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

export function PathnameProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <PathnameContext.Provider value={pathname}>{children}</PathnameContext.Provider>;
}

/** The current pathname; re-renders only when it changes under a {@link PathnameProvider}. */
export function usePathname(): string {
  const provided = useContext(PathnameContext);
  // Without the shell above (a test that renders the rail alone) it reads the location itself.
  // Whether a provider is above never changes for a mounted component, so the hook order holds.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return provided ?? useLocation().pathname;
}
