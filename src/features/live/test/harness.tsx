import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';

import type { Channel, EpgProgram, Settings } from '@/api/types';
import { DEFAULT_SETTINGS } from '@/api/types';
import live from '@/i18n/en/live.json';

import { resetStalkerPreviewSources } from '../lib/stalkerPreviewQueue';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['live'],
  defaultNS: 'live',
  resources: { en: { live } },
  interpolation: { escapeValue: false },
});

/** jsdom has no layout; give the virtualizer a ResizeObserver that reports nothing. */
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
      matches: query.includes('min-width'),
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

export function renderAt(path: string, routes: { path: string; element: ReactNode }[]) {
  // Portal backoff and answers are per source and outlive a render; each test starts clean.
  resetStalkerPreviewSources();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
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

export function makeChannel(i: number, sourceId = 'src1'): Channel {
  return {
    ref: { sourceId, contentType: 'live', itemId: `c${i}` },
    name: `Channel ${i}`,
    number: i + 1,
    categoryId: 'g1',
    categoryName: 'News',
    isRadio: false,
    archive: i < 3 ? { enabled: true, durationHours: 48 } : undefined,
  };
}

export function program(title: string, startMs: number, endMs: number): EpgProgram {
  return { channelId: 'ch', title, start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() };
}

export const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
