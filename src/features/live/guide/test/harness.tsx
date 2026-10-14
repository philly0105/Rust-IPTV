/**
 * Test harness for the guide's Run 2 C5 UI: an i18n instance with the live,
 * guide and common namespaces (the kit's own strings come from common), a
 * render helper with a fresh query client and a router whose location and
 * navigate are exposed, and an RPC double shared by the test files.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, type Location, type NavigateFunction } from 'react-router';

import type { EpgProgram, GuideSearchHit, ItemRef, RecordingRule } from '@/api/types';
import common from '@/i18n/en/common.json';
import guide from '@/i18n/en/guide.json';
import live from '@/i18n/en/live.json';

export { installDomStubs, makeChannel, program, settings } from '../../test/harness';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['live', 'guide', 'common'],
  defaultNS: 'live',
  resources: { en: { live, guide, common } },
  interpolation: { escapeValue: false },
});

export interface RpcCall {
  cmd: string;
  args: unknown;
}

/** Handlers by command; an unmocked command rejects so a test sees it. */
export function createRpcMock() {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: RpcCall[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  const reset = () => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    calls.length = 0;
  };
  const of = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { handlers, calls, call, reset, of };
}

/** The router's current location and navigate, updated on every render. */
export const router: { location?: Location; navigate?: NavigateFunction } = {};
function RouterSpy() {
  router.location = useLocation();
  router.navigate = useNavigate();
  return null;
}

export function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
}

/** Renders `routes` at `path` (or `ui` at `/`), with the guide's providers. */
export function renderGuide(
  target: { path: string; routes: { path: string; element: ReactNode }[] } | ReactNode,
  client: QueryClient = newClient(),
) {
  const { path, routes } =
    target && typeof target === 'object' && 'routes' in target
      ? target
      : { path: '/', routes: [{ path: '/', element: target as ReactNode }] };
  const utils = render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <RouterSpy />
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

export const LIVE_REF = (itemId: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType: 'live', itemId });

export function hit(title: string, start: number, end: number, over: Partial<GuideSearchHit> = {}): GuideSearchHit {
  const program: EpgProgram = { channelId: 'ch', title, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  return { ref: LIVE_REF('c1'), channelName: 'Channel 1', channelNumber: 2, categoryId: 'g1', program, ...over };
}

export function rule(over: Partial<RecordingRule> = {}): RecordingRule {
  return {
    id: 'rule1',
    ref: LIVE_REF('c1'),
    channelName: 'Channel 1',
    title: 'Evening News',
    enabled: true,
    createdAt: '2026-10-01T10:00:00Z',
    upcoming: 3,
    nextStart: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  };
}
