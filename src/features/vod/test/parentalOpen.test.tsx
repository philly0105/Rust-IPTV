/**
 * The parental gate on movie and series pages (C2, Ask mode): a locked title shows only the
 * locked panel until the PIN is entered; an unlocked one opens as usual; a failed check keeps
 * the page closed with a retry.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, ParentalStatus, VodDetail, VodItem } from '@/api/types';
import common from '@/i18n/en/common.json';
import mylist from '@/i18n/en/mylist.json';
import parental from '@/i18n/en/parental.json';
import vod from '@/i18n/en/vod.json';

import { installDomStubs, makeSource, openHeroMenu, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const calls: { cmd: string; args: unknown }[] = [];
  const call = async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args });
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, calls, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
    rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const { queryClient } = await import('@/api/query');
const { registerGateHost, settleGate, useGateStore } = await import('@/features/parental/gate');
const { MovieDetailPage } = await import('../pages/MovieDetailPage');

const i18n = i18next.createInstance();
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['vod', 'common', 'parental', 'mylist'],
  defaultNS: 'vod',
  resources: { en: { vod, common, parental, mylist } },
  interpolation: { escapeValue: false },
});

const ref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const item: VodItem = { ref, title: 'Late Night Feature', year: 2024, categoryId: 'c1' };

const status = (patch: Partial<ParentalStatus> = {}): ParentalStatus => ({
  enabled: true,
  mode: 'ask',
  autoAdult: true,
  unlockMinutes: 15,
  unlocked: false,
  failedAttempts: 0,
  ...patch,
});

let unregister: (() => void) | null = null;

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  queryClient.clear();
  h['sources.get'] = () => makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.list'] = () => [makeSource('src1', 'xtream', 'Alpha IPTV')];
  h['settings.get'] = () => settings();
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['watchlist.list'] = () => [];
  h['parental.locks'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['positions.get'] = () => null;
  h['xtream.vodDetail'] = (): VodDetail => ({ item: { ...item, plot: 'A film for grown-ups.' } as VodItem, cast: [], providerDetailsUnavailable: false, backdrops: [] });
  h['parental.status'] = () => status();
  h['parental.check'] = () => [ref];
  unregister = registerGateHost();
});
afterEach(() => {
  cleanup();
  unregister?.();
  unregister = null;
  useGateStore.setState({ queue: [] });
});

function renderMovie() {
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/s/src1/movie/m7']}>
          <Routes>
            <Route path="/s/:sourceId/movie/:itemId" element={<MovieDetailPage />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe('movie page parental gate (Ask mode)', () => {
  it('shows only the locked panel for a locked movie, and opens it once the PIN is accepted', async () => {
    renderMovie();
    await screen.findByRole('heading', { name: 'Enter the parental PIN' });
    expect(screen.queryByText('A film for grown-ups.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Play|Resume/ })).toBeNull();
    // The page's h1 reads the section name, not the locked title.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Movies');

    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    const req = useGateStore.getState().queue[0]!;
    expect(req.kind === 'unlock' && req.items.map((i) => i.title)).toEqual(['Late Night Feature']);

    // The PIN dialog unlocks the session and the new status arrives (as parental.changed does).
    rpcMock.handlers['parental.status'] = () => status({ unlocked: true });
    await act(async () => {
      settleGate(req.id, true);
      await queryClient.invalidateQueries({ queryKey: ['parental.status'] });
    });
    await screen.findByText('A film for grown-ups.');
    expect(screen.queryByTestId('parental-locked')).toBeNull();
  });

  it('opens a movie that is not locked without asking', async () => {
    rpcMock.handlers['parental.check'] = () => [];
    renderMovie();
    await screen.findByText('A film for grown-ups.');
    expect(useGateStore.getState().queue).toEqual([]);
  });

  it('keeps the page closed when the lock check fails, with a retry', async () => {
    rpcMock.handlers['parental.check'] = () => {
      throw new Error('database is locked');
    };
    renderMovie();
    await screen.findByRole('heading', { name: "Couldn't check parental locks" });
    expect(screen.queryByText('A film for grown-ups.')).toBeNull();
    rpcMock.handlers['parental.check'] = () => [];
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('A film for grown-ups.');
  });

  it('checks a Stalker title with its category from the details (no catalog row to look it up in)', async () => {
    // Stalker VOD is paged live from the portal: the core finds a group lock only through categoryId.
    const h = rpcMock.handlers;
    h['sources.get'] = () => makeSource('src1', 'stalker', 'Portal');
    h['sources.list'] = () => [makeSource('src1', 'stalker', 'Portal')];
    h['stalker.vodDetail'] = (): VodDetail => ({
      item: { ...item, categoryId: 'adult', plot: 'A film for grown-ups.' } as VodItem,
      cast: [],
      providerDetailsUnavailable: false,
      backdrops: [],
    });
    h['parental.check'] = (args) =>
      (args as { items: { ref: ItemRef; categoryId?: string }[] }).items.filter((i) => i.categoryId === 'adult').map((i) => i.ref);
    renderMovie();
    await screen.findByRole('heading', { name: 'Enter the parental PIN' });
    expect(screen.queryByText('A film for grown-ups.')).toBeNull();
    const checks = rpcMock.calls.filter((c) => c.cmd === 'parental.check');
    expect(checks.length).toBeGreaterThan(0);
    // Never asked without the category (that answer would be "not locked" and open the page).
    for (const c of checks) expect((c.args as { items: { categoryId?: string }[] }).items[0]!.categoryId).toBe('adult');

    // The unlock prompt carries the category too.
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(useGateStore.getState().queue).toHaveLength(1));
    const req = useGateStore.getState().queue[0]!;
    expect(req.kind === 'unlock' && req.items.map((i) => i.categoryId)).toEqual(['adult']);
  });

  it('asks nothing with parental controls off', async () => {
    rpcMock.handlers['parental.status'] = () => status({ enabled: false });
    renderMovie();
    await screen.findByText('A film for grown-ups.');
    expect(rpcMock.calls.some((c) => c.cmd === 'parental.check')).toBe(false);
  });

  it('says "Locked with its group" instead of offering a lock when its group is locked', async () => {
    rpcMock.handlers['parental.status'] = () => status({ unlocked: true });
    rpcMock.handlers['parental.check'] = () => [];
    rpcMock.handlers['parental.adultCategories'] = () => [];
    rpcMock.handlers['parental.locks'] = () => [
      { sourceId: 'src1', contentType: 'movie', kind: 'category', targetId: 'c1', name: 'Late shows', createdAt: '2026-10-15T00:00:00Z' },
    ];
    renderMovie();
    await screen.findByText('A film for grown-ups.');
    // The lock entries sit in the hero's More menu (VL-hero-actions).
    const menu = await openHeroMenu();
    const entry = await within(menu).findByRole('menuitem', { name: 'Locked with its group' });
    expect(entry.getAttribute('aria-disabled')).toBe('true');
    expect(within(menu).queryByRole('menuitem', { name: 'Lock movie' })).toBeNull();
  });
});
