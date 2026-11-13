import { QueryClientProvider } from '@tanstack/react-query';
import { use } from 'react';
import { RouterProvider } from 'react-router';

import { queryClient } from '@/api/query';
import { createAppRouter } from './routes';

let router: ReturnType<typeof createAppRouter> | null = null;

/**
 * The app's router, created on its first use: the browser router reads its first location from
 * the address bar then, so main.tsx can put the startup target there first.
 */
export function appRouter(): ReturnType<typeof createAppRouter> {
  router ??= createAppRouter();
  return router;
}

/**
 * Creates the router and resolves once it has loaded the first location's lazy route modules,
 * or after `maxMs`; undefined when there is nothing to wait for. Rendered before that, the
 * router shows its `HydrateFallback` skeleton first and the page in a second commit.
 */
export function appRouterReady(maxMs: number): Promise<void> | undefined {
  const r = appRouter();
  if (r.state.initialized || maxMs <= 0) return undefined;
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(done, maxMs);
    const off = r.subscribe((state) => {
      if (state.initialized) done();
    });
  });
}

/**
 * `start`, when given, holds the first render (the boot splash stays up) until it settles: main.tsx
 * passes its wait for the startup target, so the router starts at the screen a cold start opens.
 */
export function App({ start }: { start?: Promise<unknown> }) {
  if (start) use(start);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={appRouter()} />
    </QueryClientProvider>
  );
}
