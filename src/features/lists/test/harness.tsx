/**
 * Test harness for custom lists: an i18n instance with the real English
 * strings, an RPC recorder, a miniature of the core's lists module (the same
 * limits and validation as crates/iptv-core/src/lists, contract C3), and a
 * router render that exposes the current URL.
 *
 * Test files mock `@/api/transport` (rpc only, the real RpcError stays) and
 * `@/api/events`, then import this module dynamically so it sees the mocks.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import i18next from 'i18next';
import type { ReactNode } from 'react';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

import { queryClient } from '@/api/query';
import { RpcError } from '@/api/transport';
import { DEFAULT_SETTINGS, itemKey, sameRef, type Channel, type CustomList, type CustomListEntry, type ItemRef, type Source } from '@/api/types';
import type { RefWithSnapshot } from '@/api/rpc';
import common from '@/i18n/en/common.json';
import lists from '@/i18n/en/lists.json';
import live from '@/i18n/en/live.json';
import shell from '@/i18n/en/shell.json';
import { shortcutRegistry } from '@/shell/shortcuts';
import { useShellStore } from '@/shell/store';
import { useToastStore } from '@/ui';

import { useListsDialogs } from '../store';

export const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['lists', 'common', 'live', 'shell'],
  defaultNS: 'lists',
  resources: { en: { lists, common, live, shell } },
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
export type RpcMock = ReturnType<typeof createRpcMock>;

export const SOURCES: Partial<Source>[] = [
  { id: 'src1', kind: 'xtream', name: 'Home portal', channelCount: 300 },
  { id: 'src2', kind: 'm3u', name: 'Backup list', channelCount: 40 },
];

export function channel(itemId: string, name: string, opts: { sourceId?: string; radio?: boolean; categoryName?: string } = {}): Channel {
  const contentType = opts.radio ? 'radio' : 'live';
  return {
    ref: { sourceId: opts.sourceId ?? 'src1', contentType, itemId },
    name,
    categoryId: 'cat1',
    categoryName: opts.categoryName ?? 'News',
    isRadio: !!opts.radio,
  };
}

export interface CoreList {
  id: string;
  name: string;
  onDashboard: boolean;
  items: { ref: ItemRef; title: string; available: boolean; channel?: Channel }[];
}

/**
 * The core's lists in miniature. `lists` is in position order. Items keep
 * the channel they were added with; `available: false` mimics a channel the
 * provider dropped. `fail[cmd]` makes the next call of `cmd` throw that code.
 */
export function installCore(rpc: RpcMock, initial: CoreList[] = []) {
  const core = {
    lists: initial.map((l) => ({ ...l, items: l.items.map((i) => ({ ...i })) })),
    fail: {} as Record<string, RpcError['code']>,
    nextId: 1,
    favorites: [] as ItemRef[],
  };
  const guard = (cmd: string) => {
    const code = core.fail[cmd];
    if (code) {
      delete core.fail[cmd];
      throw new RpcError(code, `${cmd} refused`);
    }
  };
  const view = (l: CoreList, position: number): CustomList => ({
    id: l.id,
    name: l.name,
    position,
    onDashboard: l.onDashboard,
    itemCount: l.items.length,
    createdAt: '2026-10-13T09:00:00.000Z',
    updatedAt: '2026-10-13T09:00:00.000Z',
  });
  const find = (id: string) => {
    const l = core.lists.find((x) => x.id === id);
    if (!l) throw new RpcError('not_found', `list ${id} not found`);
    return l;
  };
  const checkName = (raw: string, except?: string) => {
    const name = raw.trim();
    if (!name || [...name].length > 60) throw new RpcError('invalid', 'list name must be 1 to 60 characters');
    if (core.lists.some((l) => l.id !== except && l.name.toLowerCase() === name.toLowerCase())) throw new RpcError('conflict', 'a list with that name exists');
    return name;
  };
  const toItems = (items: RefWithSnapshot[] = []) =>
    items.map((i) => {
      if (i.ref.contentType !== 'live' && i.ref.contentType !== 'radio') throw new RpcError('invalid', 'only channels');
      return { ref: i.ref, title: i.snapshot.title, available: true, channel: { ...channel(i.ref.itemId, i.snapshot.title, { sourceId: i.ref.sourceId, radio: i.ref.contentType === 'radio' }), ref: i.ref } };
    });

  rpc.handlers['lists.list'] = () => {
    guard('lists.list');
    return core.lists.map(view);
  };
  rpc.handlers['lists.create'] = (raw) => {
    guard('lists.create');
    const a = raw as { name: string; items?: RefWithSnapshot[] };
    const name = checkName(a.name);
    if (core.lists.length >= 50) throw new RpcError('invalid', 'at most 50 lists');
    const l: CoreList = { id: `new${core.nextId++}`, name, onDashboard: false, items: toItems(a.items) };
    core.lists.push(l);
    return view(l, core.lists.length - 1);
  };
  rpc.handlers['lists.update'] = (raw) => {
    guard('lists.update');
    const a = raw as { id: string; name?: string; onDashboard?: boolean };
    const l = find(a.id);
    if (a.name !== undefined) l.name = checkName(a.name, l.id);
    if (a.onDashboard !== undefined) l.onDashboard = a.onDashboard;
    return view(l, core.lists.indexOf(l));
  };
  rpc.handlers['lists.remove'] = (raw) => {
    guard('lists.remove');
    const a = raw as { id: string };
    core.lists = core.lists.filter((l) => l.id !== a.id);
  };
  rpc.handlers['lists.reorder'] = (raw) => {
    guard('lists.reorder');
    const a = raw as { ids: string[] };
    const ids = core.lists.map((l) => l.id);
    if (a.ids.length !== ids.length || new Set(a.ids).size !== ids.length || a.ids.some((id) => !ids.includes(id))) {
      throw new RpcError('invalid', 'ids must be a permutation of every list');
    }
    core.lists = a.ids.map((id) => core.lists.find((l) => l.id === id)!);
  };
  rpc.handlers['lists.items'] = (raw) => {
    guard('lists.items');
    const l = find((raw as { id: string }).id);
    return l.items.map(
      (i, position): CustomListEntry => ({
        ref: i.ref,
        snapshot: { title: i.title, contentType: i.ref.contentType },
        ...(i.available && i.channel ? { channel: i.channel } : {}),
        available: i.available,
        position,
        addedAt: '2026-10-13T09:00:00.000Z',
      }),
    );
  };
  rpc.handlers['lists.addItems'] = (raw) => {
    guard('lists.addItems');
    const a = raw as { id: string; items: RefWithSnapshot[] };
    const l = find(a.id);
    const fresh = toItems(a.items).filter((i) => !l.items.some((x) => sameRef(x.ref, i.ref)));
    if (l.items.length + fresh.length > 2000) throw new RpcError('invalid', 'a list holds at most 2000 items');
    l.items.push(...fresh);
    return { added: fresh.length };
  };
  rpc.handlers['lists.removeItems'] = (raw) => {
    guard('lists.removeItems');
    const a = raw as { id: string; refs: ItemRef[] };
    const l = find(a.id);
    l.items = l.items.filter((i) => !a.refs.some((r) => sameRef(r, i.ref)));
  };
  rpc.handlers['lists.reorderItems'] = (raw) => {
    guard('lists.reorderItems');
    const a = raw as { id: string; refs: ItemRef[] };
    const l = find(a.id);
    const keys = l.items.map((i) => itemKey(i.ref));
    const want = a.refs.map(itemKey);
    if (want.length !== keys.length || new Set(want).size !== keys.length || want.some((k) => !keys.includes(k))) {
      throw new RpcError('invalid', 'refs must be a permutation of the list');
    }
    l.items = want.map((k) => l.items.find((i) => itemKey(i.ref) === k)!);
  };
  rpc.handlers['lists.containing'] = (raw) => {
    guard('lists.containing');
    const ref = (raw as { ref: ItemRef }).ref;
    return core.lists.filter((l) => l.items.some((i) => sameRef(i.ref, ref))).map((l) => l.id);
  };
  rpc.handlers['epg.nowNext'] = () => ({});
  rpc.handlers['favorites.contains'] = (raw) => (raw as { refs: ItemRef[] }).refs.filter((r) => core.favorites.some((f) => sameRef(f, r)));
  rpc.handlers['settings.get'] = () => ({ ...DEFAULT_SETTINGS });
  rpc.handlers['sources.list'] = () => SOURCES;
  return core;
}

/** A list of channels for `installCore`. */
export function coreList(id: string, name: string, channels: Channel[], opts: { onDashboard?: boolean; dropped?: Channel[] } = {}): CoreList {
  return {
    id,
    name,
    onDashboard: opts.onDashboard ?? false,
    items: [
      ...channels.map((c) => ({ ref: c.ref, title: c.name, available: true, channel: c })),
      ...(opts.dropped ?? []).map((c) => ({ ref: c.ref, title: c.name, available: false })),
    ],
  };
}

export function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
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
  globalThis.CSS ??= {} as typeof CSS;
  CSS.escape ??= (s: string) => s.replace(/["\\]/g, '\\$&');
  window.matchMedia ??= ((query: string) => ({
    matches: query.includes('min-width'),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Clears the shared state a test may leave behind. */
export function resetShared(): void {
  queryClient.clear();
  queryClient.setDefaultOptions({ queries: { retry: false, gcTime: Infinity } });
  useToastStore.setState({ toasts: [] });
  shortcutRegistry.reset();
  useShellStore.setState({ header: null, headerOwner: null });
  useListsDialogs.setState({ dialog: null, seq: 0 });
}

/** The current URL (path + search), for tests that check navigation. */
export const location = { current: '' };
function LocationProbe() {
  const loc = useLocation();
  location.current = `${loc.pathname}${loc.search}`;
  return null;
}

export function Providers({ children, path = '/' }: { children: ReactNode; path?: string }) {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={[path]}>
          <LocationProbe />
          {children}
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

export function renderAt(path: string, routes: { path: string; element: ReactNode }[], extra?: ReactNode) {
  return render(
    <Providers path={path}>
      <Routes>
        {routes.map((r) => (
          <Route key={r.path} path={r.path} element={r.element} />
        ))}
        <Route path="*" element={<p data-testid="elsewhere" />} />
      </Routes>
      {extra}
    </Providers>,
  );
}
