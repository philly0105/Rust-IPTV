/**
 * Test harness for the channel edits UI: an in-memory core that follows
 * contract C2 (`channels.edits`, `channels.setHidden`, `channels.rename`,
 * `catalog.item` still answering for hidden channels), an events stub, and
 * the i18n and query providers.
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

import type { Channel, ChannelEdit, ContentType, ItemRef, RpcErrorCode } from '@/api/types';
import channels from '@/i18n/en/channels.json';
import common from '@/i18n/en/common.json';
import live from '@/i18n/en/live.json';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['channels', 'live', 'common'],
  defaultNS: 'channels',
  resources: { en: { channels, live, common } },
  interpolation: { escapeValue: false },
  initAsync: false,
});

export function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

export function renderUi(ui: ReactNode, client: QueryClient) {
  return render(<Providers client={client}>{ui}</Providers>);
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

/**
 * The event connection the edits see. Closed by default: tests have no event
 * socket, so a write refreshes its queries itself. `open()` plus `emit()`
 * stand in for the core's `channels.changed` coming back.
 */
export const events = {
  state: 'closed' as 'connecting' | 'open' | 'closed',
  handlers: new Map<string, Set<(payload: unknown) => void>>(),
  emit(type: string, payload?: unknown) {
    for (const h of [...(this.handlers.get(type) ?? [])]) h(payload);
  },
  reset() {
    this.state = 'closed';
    this.handlers.clear();
  },
};

/** Stand-in for `@/api/events`, driven by {@link events}. */
export const eventsMock = {
  onAppEvent: (type: string, handler: (payload: unknown) => void) => {
    const set = events.handlers.get(type) ?? new Set();
    set.add(handler);
    events.handlers.set(type, set);
    return () => void set.delete(handler);
  },
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
  getConnectionState: () => events.state,
};

// ---------------------------------------------------------------------------
// Fake core
// ---------------------------------------------------------------------------

export const fail = (code: RpcErrorCode, message: string, details?: unknown): never => {
  throw details === undefined ? { code, message } : { code, message, details };
};

export const refKey = (r: ItemRef) => `${r.sourceId}|${r.contentType}|${r.itemId}`;
export const ref = (itemId: string, contentType: ContentType = 'live', sourceId = 'src1'): ItemRef => ({ sourceId, contentType, itemId });

/** A catalog channel with its provider name. */
export function makeChannel(itemId: string, name: string, contentType: ContentType = 'live', sourceId = 'src1'): Channel {
  return {
    ref: ref(itemId, contentType, sourceId),
    name,
    categoryId: 'news',
    categoryName: 'News',
    isRadio: contentType === 'radio',
  };
}

type Handler = (args: unknown) => unknown;

function createFakeCore() {
  /** Provider catalog by ref key: what `catalog.item` answers (hidden or not). */
  const catalog = new Map<string, Channel>();
  /** Ref keys parental Hide mode locks: still in the catalog, but `catalog.item` refuses them. */
  const locked = new Set<string>();
  const edits = new Map<string, ChannelEdit>();
  const calls: { cmd: string; args: unknown }[] = [];
  const overrides: Record<string, Handler> = {};
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 14, 10, 0, clock++)).toISOString();

  const edit = (r: ItemRef): ChannelEdit => {
    const k = refKey(r);
    const existing = edits.get(k);
    if (existing) return existing;
    const row: ChannelEdit = { ref: r, hidden: false, originalName: catalog.get(k)!.name, updatedAt: stamp() };
    edits.set(k, row);
    return row;
  };
  const tidy = (k: string) => {
    const row = edits.get(k);
    if (row && !row.hidden && row.name === undefined) edits.delete(k);
  };

  const handlers: Record<string, Handler> = {
    'settings.get': () => ({ stripCountryPrefix: false }),
    'channels.edits': (raw) => {
      const a = raw as { sourceId: string; hiddenOnly?: boolean };
      return [...edits.values()]
        .filter((e) => e.ref.sourceId === a.sourceId && (!a.hiddenOnly || e.hidden))
        .sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))
        .map((e) => ({ ...e }));
    },
    // As crates/iptv-core/src/channeledit/mod.rs `set_hidden`: hiding needs every
    // ref in the catalog (one missing ref and nothing is written); unhiding never
    // answers not_found, so a channel the provider dropped can leave the hidden
    // list, and a ref with no hidden row is a no-op.
    'channels.setHidden': (raw) => {
      const a = raw as { refs: ItemRef[]; hidden: boolean };
      if (a.refs.length < 1 || a.refs.length > 500) fail('invalid', 'refs must hold 1 to 500 items.');
      if (a.hidden) {
        const missing = a.refs.find((r) => !catalog.has(refKey(r)));
        if (missing) fail('not_found', `channel ${missing.itemId} not found in source ${missing.sourceId}; refresh the source`);
        for (const r of a.refs) {
          const row = edit(r);
          row.hidden = true;
          row.updatedAt = stamp();
        }
        return null;
      }
      for (const r of a.refs) {
        const k = refKey(r);
        const row = edits.get(k);
        if (!row?.hidden) continue;
        row.hidden = false;
        row.updatedAt = stamp();
        tidy(k);
      }
      return null;
    },
    'channels.rename': (raw) => {
      const a = raw as { ref: ItemRef; name: string | null };
      const k = refKey(a.ref);
      if (!catalog.has(k)) fail('not_found', 'Channel is not in the catalog.');
      const name = a.name?.trim() ?? '';
      if ([...name].length > 120) fail('invalid', 'name must be 1 to 120 characters.');
      const row = edit(a.ref);
      if (name === '') delete row.name;
      else row.name = name;
      row.updatedAt = stamp();
      tidy(k);
      return edits.has(k) ? { ...edits.get(k)! } : null;
    },
    // As crates/iptv-core/src/catalog/rpc.rs `item`: a parental-locked item is
    // not_found with details.parentalLocked, a dropped one plain not_found.
    'catalog.item': (raw) => {
      const a = raw as { ref: ItemRef };
      const ch = catalog.get(refKey(a.ref));
      if (!ch) fail('not_found', 'Not in the catalog.');
      if (locked.has(refKey(a.ref))) {
        fail('not_found', `catalog item ${a.ref.itemId} is locked by parental controls; unlock them to open it`, { parentalLocked: true });
      }
      return { ...ch };
    },
  };

  return {
    calls,
    callsOf: (cmd: string) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    edits,
    reset() {
      catalog.clear();
      locked.clear();
      edits.clear();
      calls.length = 0;
      clock = 0;
      for (const k of Object.keys(overrides)) delete overrides[k];
    },
    /** Adds channels to the provider catalog. */
    add(...chs: Channel[]) {
      for (const ch of chs) catalog.set(refKey(ch.ref), ch);
    },
    /** The provider drops a channel (its edit row stays). */
    drop(r: ItemRef) {
      catalog.delete(refKey(r));
    },
    /** Parental Hide mode locks a channel: it stays in the catalog. */
    lock(r: ItemRef) {
      locked.add(refKey(r));
    },
    /** Seeds an edit row as the core would have stored it. */
    seed(r: ItemRef, patch: { hidden?: boolean; name?: string; originalName?: string }) {
      const k = refKey(r);
      edits.set(k, {
        ref: r,
        hidden: patch.hidden ?? false,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        originalName: patch.originalName ?? catalog.get(k)?.name ?? r.itemId,
        updatedAt: stamp(),
      });
    },
    isHidden: (r: ItemRef) => edits.get(refKey(r))?.hidden === true,
    nameOf: (r: ItemRef) => edits.get(refKey(r))?.name,
    /** Replaces one command for the rest of the test. */
    override(cmd: string, fn: Handler) {
      overrides[cmd] = fn;
    },
    /** The built-in handler, for overrides that wrap it. */
    base: (cmd: string) => handlers[cmd]!,
    async call(cmd: string, args?: unknown): Promise<unknown> {
      calls.push({ cmd, args });
      const h = overrides[cmd] ?? handlers[cmd];
      if (!h) throw new Error(`unmocked rpc ${cmd}`);
      return h(args);
    },
  };
}

export const core = createFakeCore();
