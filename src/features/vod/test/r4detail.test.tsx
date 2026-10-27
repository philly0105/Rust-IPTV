/**
 * Round 4 of the UI pass on the detail pages: a hero without artwork paints the title's tint, and
 * on a phone the title is the largest type on the page.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ItemRef, VodDetail } from '@/api/types';
import { tintFill, tintOf, useToastStore } from '@/ui';

import { heroWash } from '../components/detail/DetailHero';
import { MovieDetailPage } from '../pages/MovieDetailPage';
import { installDomStubs, makeSource, played, renderAt, settings, usePlayerStore } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(undefined);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  return { ...actual, rpc: (cmd: string) => rpcMock.call(cmd), rpcRaw: (cmd: string) => rpcMock.call(cmd) };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

const OFF = { enabled: false, mode: 'hide', autoAdult: false, unlockMinutes: 15, unlocked: false, failedAttempts: 0 };
const mref: ItemRef = { sourceId: 'src1', contentType: 'movie', itemId: 'm7' };
const detail = (extra: Partial<VodDetail['item']> = {}): VodDetail => ({
  item: { ref: mref, title: 'Harbor Lights', categoryId: 'c1', containerExtension: 'mkv', durationSeconds: 3600, ...extra },
  cast: [],
  backdrops: [],
  providerDetailsUnavailable: false,
});
const detailRoute = [{ path: '/s/:sourceId/movie/:itemId', element: <MovieDetailPage /> }];

beforeAll(installDomStubs);
beforeEach(() => {
  localStorage.clear();
  played.length = 0;
  usePlayerStore.getState().stop();
  useToastStore.setState({ toasts: [] });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  const src = makeSource('src1', 'xtream', 'Alpha IPTV');
  h['sources.get'] = () => src;
  h['sources.list'] = () => [src];
  h['settings.get'] = () => settings();
  h['parental.status'] = () => OFF;
  h['catalog.categories'] = () => [];
  h['positions.watchedContains'] = () => [];
  h['watchlist.list'] = () => [];
  h['xtream.vodDetail'] = () => detail();
  h['favorites.contains'] = () => [];
  h['downloads.list'] = () => [];
  h['catalog.sameTitle'] = () => [];
  h['catalog.movies'] = () => ({ items: [], total: 0, offset: 0, limit: 0 });
  h['positions.get'] = () => null;
});
afterEach(() => cleanup());

describe('a detail hero without artwork', () => {
  it("paints the title's tint in the poster fallback's hue, pale in light and deep in dark", async () => {
    renderAt('/s/src1/movie/m7', detailRoute);
    await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' });
    const backdrop = screen.getByTestId('vod-detail-backdrop');
    const wash = within(backdrop).getByTestId('vod-detail-wash');
    const tint = tintOf('Harbor Lights');
    expect(wash.style.getPropertyValue('--wash-dark')).toBe(heroWash('Harbor Lights', true));
    expect(wash.style.getPropertyValue('--wash-light')).toBe(heroWash('Harbor Lights', false));
    // The poster tile's own tint: its deep stops in dark, its pale ones in light.
    expect(heroWash('Harbor Lights', true)).toContain(tint.dark[0]);
    expect(heroWash('Harbor Lights', false)).toContain(tint.light[1]);
    expect(wash.className).toContain('dark:[background-image:var(--wash-dark)]');
    // Under the two fades to the page, so the title and the buttons keep their contrast.
    const layers = Array.from(backdrop.children);
    expect(layers.indexOf(wash)).toBe(0);
    expect(layers.length).toBe(3);
  });

  it("takes the tint of the title the rails show, not the provider's name with its year", async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => detail({ title: 'Harbor Lights (2021)', titleBase: 'Harbor Lights' });
    // The two names fall on different hues, so a hero tinted from the provider's name would fail below.
    expect(tintOf('Harbor Lights (2021)').hue).not.toBe(tintOf('Harbor Lights').hue);
    renderAt('/s/src1/movie/m7', detailRoute);
    await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' });
    const wash = within(screen.getByTestId('vod-detail-backdrop')).getByTestId('vod-detail-wash');
    expect(wash.style.getPropertyValue('--wash-dark')).toBe(heroWash('Harbor Lights', true));
    expect(wash.style.getPropertyValue('--wash-light')).toBe(heroWash('Harbor Lights', false));
    // The poster tile carries the tint a rail's card for the title has (PosterCard's label is titleBase).
    const tile = screen.getByTestId('vod-detail-poster').querySelector<HTMLElement>('[data-poster-fallback]')!;
    expect(tile.style.getPropertyValue('--tint-dark')).toBe(tintFill('Harbor Lights', 'dark'));
    expect(tile.style.getPropertyValue('--tint-light')).toBe(tintFill('Harbor Lights', 'light'));
    expect(tile.style.getPropertyValue('--tint-ink')).toBe(tintOf('Harbor Lights').ink);
    expect(tile.textContent).toBe('HL');
  });

  it('leaves the wash out while there is artwork to show', async () => {
    rpcMock.handlers['xtream.vodDetail'] = () => detail({ posterUrl: 'https://img.example/harbor.jpg' });
    renderAt('/s/src1/movie/m7', detailRoute);
    await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' });
    const backdrop = screen.getByTestId('vod-detail-backdrop');
    expect(backdrop.querySelector('img')).not.toBeNull();
    expect(within(backdrop).queryByTestId('vod-detail-wash')).toBeNull();
  });
});

describe('the hero title on a phone', () => {
  it('is set at the headline size, the largest type on the screen, under a header that is just Back', async () => {
    renderAt('/s/src1/movie/m7', detailRoute);
    const h1 = await screen.findByRole('heading', { level: 1, name: 'Harbor Lights' });
    expect(h1.className).toContain('text-display');
    expect(h1.className).toContain('max-sm:text-headline');
  });
});
