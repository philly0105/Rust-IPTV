import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { create } from 'zustand';

import type { ItemRef, Settings, Source } from '@/api/types';
import { DEFAULT_SETTINGS } from '@/api/types';
import common from '@/i18n/en/common.json';
import vod from '@/i18n/en/vod.json';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['vod', 'common'],
  defaultNS: 'vod',
  resources: { en: { vod, common } },
  interpolation: { escapeValue: false },
});

/** Records rpc calls; tests install handlers per command. */
export function createRpcMock() {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
}

/** Minimal stand-in for `@/features/player` (C8): a store, a recorder for playItem, and a stage placeholder. */
interface FakePlayer {
  source?: { ref: ItemRef; episodeId?: string };
  mode: 'inline' | 'embedded-mpv' | 'external';
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  error?: string;
  positionSeconds: number;
  durationSeconds?: number;
  queue: { ref?: ItemRef; episodeId?: string; url: string; resumeSeconds?: number }[];
  stop: () => void;
}
export const usePlayerStore = create<FakePlayer>((set) => ({
  source: undefined,
  mode: 'inline',
  status: 'idle',
  positionSeconds: 0,
  queue: [],
  stop: () => set({ source: undefined, status: 'idle', queue: [] }),
}));
export const played: unknown[] = [];
export async function playItem(args: { ref: ItemRef; episodeId?: string }): Promise<void> {
  played.push(args);
  const source: FakePlayer['source'] = { ref: args.ref };
  if (args.episodeId) source.episodeId = args.episodeId;
  usePlayerStore.setState({ source, status: 'playing', mode: 'inline', positionSeconds: 0 });
}
export function PlayerStage({ className }: { className?: string }) {
  return <div data-testid="player-stage" className={className} />;
}
export const playerModule = { usePlayerStore, playItem, PlayerStage, playSource: async () => undefined, restorePlayback: async () => undefined };

export function installDomStubs(): void {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  // jsdom has no layout: report a desktop-sized box so virtualizers render a window of rows.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

/**
 * Focuses `el` the way Tab does. VirtualGrid starts its cursor on the first title only for
 * keyboard focus (`:focus-visible`), and jsdom decides that from the last input event, which an
 * earlier click (in this test or the one before) leaves as a mouse event.
 */
export function keyboardFocus(el: HTMLElement): void {
  fireEvent.keyDown(document.documentElement, { key: 'Tab' });
  act(() => el.focus());
}

export let currentLocation = '';
function LocationProbe() {
  const loc = useLocation();
  currentLocation = `${loc.pathname}${loc.search}`;
  return null;
}

export function renderAt(path: string, routes: { path: string; element: ReactNode }[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          <Routes>
            {routes.map((r) => (
              <Route key={r.path} path={r.path} element={r.element} />
            ))}
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

export function makeSource(id: string, kind: Source['kind'], name: string): Source {
  return {
    id,
    kind,
    name,
    position: 0,
    autoRefresh: false,
    createdAt: '2026-10-01T00:00:00Z',
    channelCount: 10,
    movieCount: 5000,
    seriesCount: 40,
  } as Source;
}

/**
 * Opens a detail hero's More menu (VL-hero-actions: Start over, Favorites, Other sources and the
 * lock live there) and returns the menu.
 */
export async function openHeroMenu(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: i18n.t('common:moreActions') }));
  return screen.findByRole('menu');
}

/** Opens the landing's "Browse all categories" index (VL-landing-index) if it is closed. */
export async function openCategoryIndex(): Promise<void> {
  const toggle = await screen.findByRole('button', { name: i18n.t('vod:browseAllCategories') });
  if (toggle.getAttribute('aria-expanded') !== 'true') fireEvent.click(toggle);
}

/**
 * A category's link in the landing's index. The chip row above the rails links the first
 * categories too, so a name alone matches two links.
 */
export async function findIndexLink(name: RegExp): Promise<HTMLElement> {
  return within(await screen.findByRole('list', { name: i18n.t('vod:categories') })).findByRole('link', { name });
}

/** A test wrapper with a fresh query client, for components rendered alone that read a query (a rail reads the cover size). */
export function QueryWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
