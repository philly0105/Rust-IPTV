/**
 * Test harness of the multi-view slice: an English i18n instance with the slice's strings,
 * the app's query client (so `invalidate` reaches the rendered queries), a memory router,
 * and the browser pieces jsdom lacks (media element playback, layout boxes, matchMedia).
 *
 * Module mocks are declared in each test file (vi.mock is hoisted per file); this file only
 * provides the helpers they share.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { queryClient } from '@/api/query';
import type { Channel, ItemRef, Source } from '@/api/types';
import common from '@/i18n/en/common.json';
import multiview from '@/i18n/en/multiview.json';
// The shared no-source state (sources feature) draws its actions in its own namespace.
import sources from '@/i18n/en/sources.json';

import { __reloadMultiviewForTests, AUDIO_STORAGE_KEY, STORAGE_KEY } from '../store';
import type { MultiviewChannelInput } from '../types';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['multiview', 'common', 'sources'],
  defaultNS: 'multiview',
  resources: { en: { multiview, common, sources } },
  interpolation: { escapeValue: false },
});

/** Media elements that "play": play() resolves, pause/load do nothing. Returns the play spy's calls. */
export function installMediaStubs(): void {
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    writable: true,
    value: function play(this: HTMLMediaElement) {
      return Promise.resolve();
    },
  });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, writable: true, value: () => undefined });
  Object.defineProperty(HTMLMediaElement.prototype, 'load', { configurable: true, writable: true, value: () => undefined });
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
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

/** A fresh wall and fresh queries for each test. */
export function resetWall(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(AUDIO_STORAGE_KEY);
  __reloadMultiviewForTests();
  queryClient.clear();
}

export function ref(itemId: string, sourceId = 'src1'): ItemRef {
  return { sourceId, contentType: 'live', itemId };
}

export function input(i: number, sourceId = 'src1'): MultiviewChannelInput {
  return { ref: ref(`c${i}`, sourceId), title: `Channel ${i}`, number: i };
}

export function channel(i: number, sourceId = 'src1'): Channel {
  return {
    ref: ref(`c${i}`, sourceId),
    name: `Channel ${i}`,
    number: i,
    categoryId: 'g1',
    categoryName: 'News',
    isRadio: false,
  };
}

export function source(id: string, kind: Source['kind'] = 'xtream', name = `Source ${id}`): Source {
  return { id, kind, name, position: 0, channelCount: 10 } as unknown as Source;
}

/** Shows the current path (and the route state as JSON), for navigation assertions. */
export function LocationProbe() {
  const loc = useLocation();
  return (
    <div data-testid="location" data-state={JSON.stringify(loc.state ?? null)}>
      {loc.pathname}
    </div>
  );
}

export function renderWithApp(ui: ReactNode, path: string | { pathname: string; state: unknown } = '/multiview') {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="*"
              element={
                <>
                  {ui}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}
