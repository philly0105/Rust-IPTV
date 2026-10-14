/**
 * Test harness for the parental UI: an in-memory core that follows contract
 * C2 (PIN rules, wrong-PIN lockout, session unlock, locks, checks), an event
 * bus standing in for `@/api/events`, and the i18n and query providers.
 *
 * This module must not import `@/api/transport` or anything that does: the
 * test files' transport mock imports it. Errors are thrown as plain RpcError
 * payloads; the mock turns them into real `RpcError`s.
 */
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import type { ContentType, ItemRef, ParentalLock, ParentalLockTarget, ParentalMode, ParentalStatus, RpcErrorCode, Source } from '@/api/types';
import common from '@/i18n/en/common.json';
import parental from '@/i18n/en/parental.json';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['parental', 'common'],
  defaultNS: 'parental',
  resources: { en: { parental, common } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

export function renderUi(ui: ReactNode, client: QueryClient) {
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{ui}</I18nextProvider>
    </QueryClientProvider>,
  );
}

/** jsdom lacks matchMedia, ResizeObserver and layout; give components enough to render. */
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
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type Handler = (payload: unknown) => void;
const listeners = new Map<string, Set<Handler>>();

/** Stand-in for `@/api/events`: `onAppEvent` subscribes to {@link emitEvent}. */
export const eventsMock = {
  onAppEvent(type: string, handler: Handler): () => void {
    const set = listeners.get(type) ?? new Set<Handler>();
    set.add(handler);
    listeners.set(type, set);
    return () => set.delete(handler);
  },
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
  getConnectionState: () => 'open',
};

/** Delivers an app event to every `onAppEvent` subscriber. */
export function emitEvent(type: string, payload: unknown): void {
  for (const h of [...(listeners.get(type) ?? [])]) h(payload);
}

export function listenerCount(type: string): number {
  return listeners.get(type)?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Fake core
// ---------------------------------------------------------------------------

interface RpcErrorPayload {
  code: RpcErrorCode;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

const fail = (code: RpcErrorCode, message: string, details?: unknown, retryable?: boolean): never => {
  throw { code, message, ...(details === undefined ? {} : { details }), ...(retryable === undefined ? {} : { retryable }) } satisfies RpcErrorPayload;
};

export interface CoreState {
  pin: string | null;
  mode: ParentalMode;
  autoAdult: boolean;
  unlockMinutes: number;
  /** Session unlock: null when locked, else its end (ms; Infinity = until restart). */
  unlockedUntil: number | null;
  failedAttempts: number;
  lockoutUntil: number | null;
  locks: ParentalLock[];
  /** Adult category ids per `${sourceId}|${contentType}`. */
  adult: Record<string, string[]>;
  /** Category of an item, per `${sourceId}|${contentType}|${itemId}` (for checks without categoryId). */
  categoryOf: Record<string, string>;
}

export const LOCKOUT_AFTER = 5;
export const refKey = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;

function initialState(): CoreState {
  return {
    pin: null,
    mode: 'hide',
    autoAdult: true,
    unlockMinutes: 15,
    unlockedUntil: null,
    failedAttempts: 0,
    lockoutUntil: null,
    locks: [],
    adult: {},
    categoryOf: {},
  };
}

type Handlers = Record<string, (args: unknown) => unknown>;

/**
 * The C2 core in miniature. `handlers` holds every parental command plus
 * whatever a test adds (`sources.list`, `catalog.categories`); `override`
 * replaces one for a test (to fail it, or to make it slow).
 */
function createFakeCore() {
  let state = initialState();
  const calls: { cmd: string; args: unknown }[] = [];
  const extra: Handlers = {};

  const unlocked = () => state.pin !== null && state.unlockedUntil !== null && state.unlockedUntil > Date.now();

  const status = (): ParentalStatus => {
    if (state.unlockedUntil !== null && state.unlockedUntil <= Date.now()) state.unlockedUntil = null;
    const now = Date.now();
    const s: ParentalStatus = {
      enabled: state.pin !== null,
      mode: state.mode,
      autoAdult: state.autoAdult,
      unlockMinutes: state.unlockMinutes,
      unlocked: unlocked(),
      failedAttempts: state.failedAttempts,
    };
    if (s.unlocked && Number.isFinite(state.unlockedUntil)) s.unlockedUntil = new Date(state.unlockedUntil!).toISOString();
    if (state.lockoutUntil !== null && state.lockoutUntil > now) s.retryAfterSeconds = Math.ceil((state.lockoutUntil - now) / 1000);
    return s;
  };

  const changed = () => {
    const s = status();
    emitEvent('parental.changed', s);
    return s;
  };

  const verify = (pin: string) => {
    const now = Date.now();
    if (state.lockoutUntil !== null && state.lockoutUntil > now) {
      fail('conflict', 'Too many wrong PINs.', { retryAfterSeconds: Math.ceil((state.lockoutUntil - now) / 1000) }, true);
    }
    if (pin === state.pin) {
      state.failedAttempts = 0;
      state.lockoutUntil = null;
      return;
    }
    state.failedAttempts += 1;
    if (state.failedAttempts >= LOCKOUT_AFTER) {
      const secs = Math.min(300, 30 * 2 ** (state.failedAttempts - LOCKOUT_AFTER));
      state.lockoutUntil = now + secs * 1000;
      changed();
      fail('conflict', 'Too many wrong PINs.', { retryAfterSeconds: secs }, true);
    }
    changed();
    fail('auth', 'Wrong PIN.');
  };

  const authorize = (pin: string | undefined, what: string) => {
    if (state.pin === null || unlocked()) return;
    if (pin === undefined) fail('auth', `Enter the PIN to ${what}.`);
    verify(pin!);
  };

  const validPin = (p: unknown): p is string => typeof p === 'string' && /^[0-9]{4,8}$/.test(p);
  const sameLock = (a: ParentalLockTarget, b: ParentalLockTarget) =>
    a.sourceId === b.sourceId && a.contentType === b.contentType && a.kind === b.kind && a.targetId === b.targetId;

  const parental: Handlers = {
    'parental.status': () => status(),
    'parental.setPin': (raw) => {
      const a = raw as { currentPin?: string; newPin: string };
      if (!validPin(a.newPin)) fail('invalid', 'newPin must be 4 to 8 digits.');
      if (state.pin !== null) {
        if (a.currentPin === undefined) fail('auth', 'Enter the current PIN to change it.');
        verify(a.currentPin!);
      }
      state.pin = a.newPin;
      state.failedAttempts = 0;
      state.lockoutUntil = null;
      return changed();
    },
    'parental.disable': (raw) => {
      const a = raw as { pin: string };
      if (state.pin === null) return status();
      verify(a.pin);
      state.pin = null;
      state.unlockedUntil = null;
      return changed();
    },
    'parental.configure': (raw) => {
      const a = raw as { pin?: string; mode?: ParentalMode; autoAdult?: boolean; unlockMinutes?: number };
      if (a.unlockMinutes !== undefined && (a.unlockMinutes < 0 || a.unlockMinutes > 720)) fail('invalid', 'unlockMinutes must be between 0 and 720.');
      authorize(a.pin, 'change parental settings');
      if (a.mode !== undefined) state.mode = a.mode;
      if (a.autoAdult !== undefined) state.autoAdult = a.autoAdult;
      if (a.unlockMinutes !== undefined) state.unlockMinutes = a.unlockMinutes;
      return changed();
    },
    'parental.unlock': (raw) => {
      const a = raw as { pin: string };
      if (state.pin === null) fail('invalid', 'Parental controls are off. Set a PIN first.');
      verify(a.pin);
      state.unlockedUntil = state.unlockMinutes > 0 ? Date.now() + state.unlockMinutes * 60_000 : Infinity;
      return changed();
    },
    'parental.lockNow': () => {
      const was = unlocked();
      state.unlockedUntil = null;
      return was ? changed() : status();
    },
    'parental.locks': (raw) => {
      const a = (raw ?? {}) as { sourceId?: string };
      return state.locks.filter((l) => !a.sourceId || l.sourceId === a.sourceId);
    },
    'parental.setLocked': (raw) => {
      const a = raw as { target: ParentalLockTarget; locked: boolean; pin?: string };
      if (!a.locked) authorize(a.pin, 'remove a lock');
      const had = state.locks.some((l) => sameLock(l, a.target));
      if (a.locked && !had) state.locks.push({ ...a.target, createdAt: '2026-10-13T08:00:00.000Z' });
      if (!a.locked) state.locks = state.locks.filter((l) => !sameLock(l, a.target));
      if (had !== a.locked) changed();
    },
    'parental.check': (raw) => {
      const a = raw as { items: { ref: ItemRef; categoryId?: string }[] };
      if (a.items.length > 500) fail('invalid', 'parental.check takes at most 500 items.');
      if (state.pin === null || unlocked()) return [];
      return a.items
        .filter(({ ref, categoryId }) => {
          const cat = categoryId ?? state.categoryOf[refKey(ref)];
          const byItem = state.locks.some((l) => l.kind === 'item' && l.sourceId === ref.sourceId && l.contentType === ref.contentType && l.targetId === ref.itemId);
          const byCat =
            cat !== undefined &&
            state.locks.some((l) => l.kind === 'category' && l.sourceId === ref.sourceId && l.contentType === ref.contentType && l.targetId === cat);
          const adult = cat !== undefined && state.autoAdult && (state.adult[`${ref.sourceId}|${ref.contentType}`] ?? []).includes(cat);
          return byItem || byCat || adult;
        })
        .map((i) => i.ref);
    },
    'parental.adultCategories': (raw) => {
      const a = raw as { sourceId: string; contentType: ContentType };
      return state.adult[`${a.sourceId}|${a.contentType}`] ?? [];
    },
  };

  const overrides: Handlers = {};

  return {
    get state() {
      return state;
    },
    calls,
    callsOf: (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    status,
    /** Fresh core: controls off, defaults from C2, nothing locked. `patch` sets fields. */
    reset(patch: Partial<CoreState> = {}) {
      state = { ...initialState(), ...patch };
      calls.length = 0;
      for (const k of Object.keys(extra)) delete extra[k];
      for (const k of Object.keys(overrides)) delete overrides[k];
    },
    /** Adds a non-parental command (`sources.list`, `catalog.categories`). */
    handle(cmd: string, fn: (args: unknown) => unknown) {
      extra[cmd] = fn;
    },
    /** Replaces one command for the rest of the test. */
    override(cmd: string, fn: (args: unknown) => unknown) {
      overrides[cmd] = fn;
    },
    lock(target: ParentalLockTarget) {
      state.locks.push({ ...target, createdAt: '2026-10-13T08:00:00.000Z' });
    },
    async call(cmd: string, args?: unknown): Promise<unknown> {
      calls.push({ cmd, args });
      const h = overrides[cmd] ?? parental[cmd] ?? extra[cmd];
      if (!h) throw new Error(`unmocked rpc ${cmd}`);
      return h(args);
    },
  };
}

export const core = createFakeCore();

export function makeSource(id: string, name: string, counts: Partial<Pick<Source, 'channelCount' | 'movieCount' | 'seriesCount'>> = {}): Source {
  return {
    id,
    kind: 'xtream',
    name,
    position: 0,
    autoRefresh: false,
    createdAt: '2026-10-01T00:00:00Z',
    channelCount: 40,
    movieCount: 30,
    seriesCount: 10,
    ...counts,
  } as Source;
}

export const channelRef = (itemId: string, sourceId = 'src1'): ItemRef => ({ sourceId, contentType: 'live', itemId });
