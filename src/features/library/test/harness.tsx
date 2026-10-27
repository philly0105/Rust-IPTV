import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { create } from 'zustand';

import { queryClient } from '@/api/query';
import type { PlayerSource } from '@/api/types';
import library from '@/i18n/en/library.json';
// The shared no-source state's actions come from the sources feature, in its namespace.
import sources from '@/i18n/en/sources.json';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['library', 'sources'],
  defaultNS: 'library',
  resources: { en: { library, sources } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

/** Records every rpc call; handlers are set per test. */
export function createRpcMock() {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  const reset = () => {
    for (const key of Object.keys(handlers)) delete handlers[key];
    calls.length = 0;
  };
  const callsOf = (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args);
  return { handlers, calls, call, reset, callsOf };
}

/** Stand-in for the player feature: a tiny store plus recorded calls. */
interface FakePlayerState {
  source?: PlayerSource;
  positionSeconds: number;
  durationSeconds?: number;
  stop: () => void;
}
export const fakePlayer = {
  usePlayerStore: create<FakePlayerState>((set) => ({ positionSeconds: 0, stop: () => set({ source: undefined }) })),
  played: [] as PlayerSource[],
  items: [] as unknown[],
};
export const playerModule = {
  usePlayerStore: fakePlayer.usePlayerStore,
  playSource: async (s: PlayerSource) => {
    fakePlayer.played.push(s);
    fakePlayer.usePlayerStore.setState({ source: s });
  },
  playItem: async (args: unknown) => {
    fakePlayer.items.push(args);
  },
  PlayerStage: ({ className }: { className?: string }) => <div data-testid="player-stage" className={className} />,
};

/** The shell header: pages push title and actions into it; tests render the actions. */
type FakeHeaderState = { title: string; subtitle?: string; actions?: React.ReactNode; search?: { placeholder: string } } | null;
const useFakeHeader = create<{ header: FakeHeaderState }>(() => ({ header: null }));
const setHeader = (header: FakeHeaderState) => useFakeHeader.setState({ header });
export const shellModule = {
  useShell: () => ({ setHeader }),
  useShortcut: () => undefined,
};
function FakeHeader() {
  const header = useFakeHeader((s) => s.header);
  return (
    <header data-testid="fake-header">
      {/* Like the real shell header (C16): the title is a paragraph, never a heading; pages own their h1. */}
      <p data-testid="page-title">{header?.title}</p>
      {header?.subtitle ? <p data-testid="page-subtitle">{header.subtitle}</p> : null}
      {header?.actions}
      {/* The page's own search, when it puts one in the header (else the shell shows Search everything). */}
      {header?.search ? <p data-testid="page-search">{header.search.placeholder}</p> : null}
    </header>
  );
}

/** jsdom has no layout: give virtualizers a desktop-sized box. */
export function installDomStubs(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

export function renderAt(path: string, routes: { path: string; element: React.ReactNode }[]) {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: 0 } });
  useFakeHeader.setState({ header: null });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <FakeHeader />
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

/** i18n only, for rendering a single component outside a page. */
export function I18nWrap({ children }: { children: React.ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
