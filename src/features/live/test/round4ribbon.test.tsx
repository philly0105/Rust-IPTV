/** Review round 4: the Now card reads eyebrow, title, then LIVE with its times, as the hero and detail pages do. */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpgRibbon } from '../components/EpgRibbon';
import { MINUTE } from '../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

const rpcMock = vi.hoisted(() => {
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const call = async (cmd: string, args?: unknown) => {
    const h = handlers[cmd];
    if (!h) throw new Error(`unmocked rpc ${cmd}`);
    return h(args);
  };
  return { handlers, call };
});

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
}));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

beforeAll(installDomStubs);
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Big 50k', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
});
afterEach(cleanup);

function renderRibbon(details: boolean, channel = makeChannel(0)) {
  renderAt('/', [
    {
      path: '/',
      element: <EpgRibbon channel={channel} sourceKind="m3u" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} details={details} />,
    },
  ]);
}

/** The title line in the card's header (the timeline's block has the same title). */
const headerTitle = (title: string) =>
  waitFor(() => {
    const p = within(screen.getByTestId('ribbon-header')).getAllByTitle(title).find((e) => e.tagName === 'P');
    expect(p).toBeTruthy();
    return p!;
  });

const follows = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('the Now card order (review round 4)', () => {
  it('puts the programme title right under the channel line and the times under the title', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [program('Morning Mix', now - 10 * MINUTE, now + 50 * MINUTE)];
    renderRibbon(true);
    const title = await headerTitle('Morning Mix');
    const channel = screen.getByTestId('ribbon-channel');
    const time = screen.getByTestId('ribbon-time');
    expect(follows(channel, title)).toBe(true);
    expect(follows(title, time)).toBe(true);
    // The times are on the caption scale beside the title.
    expect(time.parentElement!.className).toContain('text-caption');
    expect(title.className).toContain('md:text-title-sm');
  });

  it('keeps the times first on the one-line ribbon without details', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [program('Morning Mix', now - 10 * MINUTE, now + 50 * MINUTE)];
    renderRibbon(false);
    const title = await headerTitle('Morning Mix');
    expect(follows(screen.getByTestId('ribbon-time'), title)).toBe(true);
  });
});

describe('the Now card without a guide (review round 4)', () => {
  it('names the channel as the stage and the list draw it, the place tag after the name', async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    renderRibbon(true, { ...makeChannel(0), name: 'US| ESPN (Backup)' });
    await screen.findByTestId('ribbon-no-guide');
    const heading = screen.getByTestId('ribbon-channel-name');
    const tag = within(heading).getByTestId('channel-name-tag');
    expect(tag.textContent).toBe('US');
    expect(tag.previousElementSibling?.textContent).toBe('ESPN (Backup)');
    expect(within(heading).getByText('US| ESPN (Backup)').className).toContain('sr-only');
  });
});
