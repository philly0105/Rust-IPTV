/**
 * Test harness for onboarding: an i18n instance with the real English
 * strings, an in-memory core for the four commands the feature uses
 * (`app.info`, `settings.get`, `settings.update`, `sources.list`), DOM stubs
 * jsdom lacks, and a render with the query and i18n providers.
 *
 * Test files mock `@/api/transport` (rpc only, the real RpcError stays) and
 * `@/api/events`, then import this module dynamically so it sees the mocks.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { queryClient } from '@/api/query';
import { DEFAULT_SETTINGS, type AppInfo, type Settings, type Source } from '@/api/types';
import common from '@/i18n/en/common.json';
import onboarding from '@/i18n/en/onboarding.json';
import { shortcutRegistry } from '@/shell/shortcuts';

import { resetOnboardingSession } from '../host';
import { resetOnboardingStore } from '../store';

export const VERSION = '0.1.0';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['onboarding', 'common'],
  defaultNS: 'onboarding',
  resources: { en: { onboarding, common } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

const SOURCE: Source = {
  id: 'src1',
  kind: 'xtream',
  name: 'Home portal',
} as Source;

/**
 * The core as the feature sees it: settings with the two markers, a source
 * list and the app version. `settings.update` applies its patch, unless
 * `failUpdates` is set; every call is recorded.
 */
export function createCore() {
  const state = {
    settings: { ...DEFAULT_SETTINGS } as Settings,
    sources: [] as Source[],
    version: VERSION,
    failUpdates: false,
    /** When set, `app.info` never answers (a slow core). */
    holdInfo: false,
    /** When set, `app.info` fails. */
    failInfo: false,
  };
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown): Promise<unknown> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case 'app.info': {
        if (state.failInfo) throw { code: 'internal', message: 'no info' };
        if (state.holdInfo) return new Promise(() => undefined);
        const info: AppInfo = {
          version: state.version,
          dataDir: 'C:/data',
          platform: 'windows',
          isDesktop: true,
          logFile: 'C:/data/app.log',
          proxyBase: null,
          updaterAvailable: false,
        };
        return info;
      }
      case 'settings.get':
        return { ...state.settings };
      case 'settings.update': {
        if (state.failUpdates) throw { code: 'internal', message: 'disk full' };
        const { patch } = args as { patch: Partial<Settings> };
        state.settings = { ...state.settings, ...patch };
        return { ...state.settings };
      }
      case 'sources.list':
        return state.sources.map((s) => ({ ...s }));
      default:
        throw { code: 'internal', message: `unmocked rpc ${cmd}` };
    }
  };
  const updates = () => calls.filter((c) => c.cmd === 'settings.update').map((c) => (c.args as { patch: Partial<Settings> }).patch);
  const addSource = () => {
    state.sources = [{ ...SOURCE }];
  };
  return { state, calls, call, updates, addSource };
}
export type Core = ReturnType<typeof createCore>;

export function renderUi(ui: ReactNode) {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
    </QueryClientProvider>,
  );
}

/** jsdom lacks matchMedia, ResizeObserver and scrolling; give components enough to render. */
export function installDomStubs(): void {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
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
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

/** Gives `el` a laid-out box, as a real layout would. */
export function placeAt(el: Element, box: { top: number; left: number; width: number; height: number }): void {
  const rect = {
    ...box,
    x: box.left,
    y: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => box,
  };
  el.getBoundingClientRect = () => rect as DOMRect;
}

/** Clears the shared state a test may leave behind. */
export function resetShared(): void {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  shortcutRegistry.reset();
  resetOnboardingStore();
  resetOnboardingSession();
  document.documentElement.dir = 'ltr';
}
