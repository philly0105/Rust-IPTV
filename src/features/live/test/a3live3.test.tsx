/** Round 3 fix lane live3 (2026-11-17): the Live TV page, its ribbon and the channel list page. */

import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram } from '@/api/types';
import { EpgRibbon } from '../components/EpgRibbon';
import { ChannelName } from '../components/ChannelLogo';
import { LiveStageColumn } from '../components/LiveStageColumn';
import { StageIdle } from '../components/StageIdle';
import { channelMenuHeader, useChannelMenuItems } from '../hooks/useChannelMenuItems';
import { HOUR, MINUTE } from '../lib/epgTime';
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

const now = Date.now();
const day: EpgProgram[] = [
  program('Morning Report', now - 30 * MINUTE, now + 30 * MINUTE),
  program('Afternoon Film', now + 30 * MINUTE, now + 2 * HOUR),
  program('Late Movie', now + 6 * HOUR, now + 7 * HOUR),
];

function ribbon(extra: { compact?: boolean; guideHref?: string; guideInHeader?: boolean } = {}) {
  rpcMock.handlers['epg.programs'] = () => day;
  renderAt('/', [
    {
      path: '/',
      element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} details {...extra} />,
    },
  ]);
}

describe('the stacked stage of a portrait tablet (v-live-01)', () => {
  it('the compact ribbon is the Now card and the timeline, whole: no description, no Up next, no growing', async () => {
    ribbon({ compact: true });
    await screen.findByRole('button', { name: /^Afternoon Film/ }, { timeout: 10_000 });
    expect(screen.queryByTestId('up-next')).toBeNull();
    expect(screen.queryByTestId('ribbon-description')).toBeNull();
    expect(screen.getByTestId('epg-ribbon').className).not.toContain('md:flex-1');
    expect(screen.getByTestId('ribbon-body').className).toContain('h-[104px]');
  });

  it('keeps the list view at the timeline height, two whole rows', async () => {
    rpcMock.handlers['settings.get'] = () => settings({ epgViewMode: 'list' });
    ribbon({ compact: true });
    await screen.findByRole('list', { name: 'List' }, { timeout: 10_000 });
    expect(screen.getByTestId('ribbon-body').className).toContain('h-[104px]');
  });

  it('beside the list the ribbon keeps Up next', async () => {
    ribbon();
    expect(await screen.findByTestId('up-next', {}, { timeout: 10_000 })).toBeTruthy();
    expect(screen.getByTestId('epg-ribbon').className).toContain('md:flex-1');
  });
});

describe('a gap in the guide (v-live-06)', () => {
  it('the Now card shows what comes next, marked Up next, with no LIVE badge', async () => {
    rpcMock.handlers['epg.programs'] = () => [program('NFL Football Pregame', now + 45 * MINUTE, now + 2 * HOUR)];
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} details /> }]);
    expect((await screen.findByTestId('ribbon-up-next', {}, { timeout: 10_000 })).textContent).toBe('Up next');
    expect(screen.getByTestId('ribbon-header').textContent).toContain('NFL Football Pregame');
    expect(screen.queryByTestId('ribbon-remaining')).toBeNull();
    expect(screen.queryByTestId('ribbon-channel-name')).toBeNull();
  });
});

describe("the ribbon's TV guide link (v-vod-02)", () => {
  it('stays at every width on a channel list, whose header has no guide button', async () => {
    ribbon({ guideHref: '/epg?view=list:l1' });
    const link = await screen.findByRole('link', { name: 'TV guide' }, { timeout: 10_000 });
    expect(link.className).not.toContain('md:hidden');
  });

  it("is for phones only on Live, whose header has a labelled one", async () => {
    ribbon({ guideHref: '/epg', guideInHeader: true });
    const link = await screen.findByRole('link', { name: 'TV guide' }, { timeout: 10_000 });
    expect(link.className).toContain('md:hidden');
  });
});

function MenuProbe({ channel, programme }: { channel: Channel; programme?: EpgProgram }) {
  const items = useChannelMenuItems(channel, { source: { id: 'src1', kind: 'm3u', m3u: undefined }, favorite: false, onPlay: () => undefined, onToggleFavorite: () => undefined, onMapGuide: () => undefined, programme, now });
  const header = channelMenuHeader(channel, channel.name, 'Now on');
  return (
    <div>
      <div data-testid="probe-header">
        {header.title}
        {header.media ? <span data-testid="probe-media" /> : null}
        {header.subtitle}
      </div>
      <ul>
        {items.map((i) => ('label' in i ? <li key={i.id}>{i.label}</li> : null))}
      </ul>
    </div>
  );
}

function menuOf(channel: Channel, programme?: EpgProgram) {
  renderAt('/', [{ path: '/', element: <MenuProbe channel={channel} programme={programme} /> }]);
  return [...screen.getAllByRole('listitem')].map((li) => li.textContent);
}

describe('the channel menu (v-live-03, v-guide-07)', () => {
  it("a provider's heading row offers Hide only, headed by its caption with no logo", () => {
    const heading = { ...makeChannel(5), name: '######## ALL CHANNELS ########' };
    // (This harness loads only the live strings: the edit entry shows its key.)
    expect(menuOf(heading)).toEqual(['menuHide']);
    const header = screen.getByTestId('probe-header');
    expect(header.textContent).toBe('ALL CHANNELS');
    expect(screen.queryByTestId('probe-media')).toBeNull();
  });

  it('opened on a later programme, the play entry says it watches the channel', () => {
    const later = program('College GameDay', now + 2 * HOUR, now + 3 * HOUR);
    const labels = menuOf(makeChannel(5), later);
    expect(labels[0]).toBe('Watch channel');
    expect(labels).toContain('Add to favorites');
  });

  it('on the airing programme or the channel, it stays Play', () => {
    expect(menuOf(makeChannel(5), day[0])[0]).toBe('Play');
    cleanup();
    expect(menuOf(makeChannel(5))[0]).toBe('Play');
  });
});

describe('the stage in a short landscape window under 768 px (w-a11y-02)', () => {
  it('is capped so the list keeps its toolbar and three rows, the screen giving way', () => {
    const Stage = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
    renderAt('/', [{ path: '/', element: <LiveStageColumn label="Player" busy idle={null} ribbon={null} ribbonOnPhone stageTestId="stage" sectionTestId="column" Stage={Stage} /> }]);
    expect(screen.getByTestId('column').className).toContain('max-md:landscape:max-h-[calc(100%-15rem)]');
    expect(screen.getByTestId('stage').className).toContain('max-md:landscape:shrink');
  });
});

describe("the stage timeline's focus (w-a11y-07)", () => {
  it("a block keeps the app's focus outline, a frame apart from the playing block's inset ring", async () => {
    rpcMock.handlers['epg.programs'] = () => [program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE)];
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} details /> }]);
    const block = await screen.findByRole('button', { name: /^Midday Report,/ }, { timeout: 10_000 });
    expect(block.className).not.toContain('outline-none');
    expect(block.className).not.toContain('focus-visible:ring');
  });
});

describe('channel names for screen readers (w-a11y-03)', () => {
  const espn = { ...makeChannel(1), name: 'US| ESPN HD' };
  it("the stage's Resume says the name as the row draws it, not the provider's prefix", () => {
    renderAt('/', [{ path: '/', element: <StageIdle kind="live" last={{ channel: espn }} now={now} onResume={() => undefined} /> }]);
    expect(screen.getByTestId('stage-resume').getAttribute('aria-label')).toBe('Resume ESPN HD (US)');
  });
  it("the ribbon's live button does too", async () => {
    rpcMock.handlers['epg.programs'] = () => day;
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={espn} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} details /> }]);
    const live = await screen.findByRole('button', { name: /ESPN HD \(US\)$/ }, { timeout: 10_000 });
    expect(live.getAttribute('aria-label')).not.toContain('US|');
  });
});

describe('the idle stage while the channel last watched is looked up (w-realdata-09)', () => {
  it('shows the backdrop only, no prompt for a Resume to replace', () => {
    renderAt('/', [{ path: '/', element: <StageIdle kind="live" pending now={now} /> }]);
    expect(screen.getByTestId('stage-idle')).toBeTruthy();
    expect(screen.queryByText(/Nothing playing|Pick a channel/)).toBeNull();
    cleanup();
    renderAt('/', [{ path: '/', element: <StageIdle kind="live" now={now} /> }]);
    expect(screen.getAllByText(/Nothing playing|Pick a channel/).length).toBeGreaterThan(0);
  });
});

describe('group names (w-realdata-13)', () => {
  it("draw the place's tag after the name, quiet, as channel rows do; the provider's name stays whole for readers", () => {
    renderAt('/', [{ path: '/', element: <ChannelName name="US| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ" className="truncate" /> }]);
    expect(screen.getByTestId('channel-name-tag').textContent).toBe('US');
    expect(screen.getByText('US| PRIME ᴿᴬᵂ ⁶⁰ᶠᵖˢ').className).toContain('sr-only');
  });
});
