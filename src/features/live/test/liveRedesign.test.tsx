/**
 * The Live redesign (stage 1): compact clock formats, the coloured monogram (LG-14), channel rows
 * with three lines and a ⋮ menu that touch can reach (LG-03, LG-04), the long press, the shared
 * idle stage with Resume (CB-AUTOPLAY-LAST), the ribbon's hover preview and pick (LG-06), Up next
 * (LG-02), the phone's folded ribbon (LG-17), the guide link that names the group and the playing
 * channel (LG-01), and catch-up downloads only for archive links that end (FW-ARCHIVE-DOWNLOAD-UNBOUNDED).
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Channel, EpgProgram, Page, PageQuery } from '@/api/types';

import { ChannelLogo } from '../components/ChannelLogo';
import { resetChannelListMemory } from '../components/ChannelList';
import { ChannelRow } from '../components/ChannelRow';
import { EpgRibbon, RIBBON_PREVIEW_LINGER_MS } from '../components/EpgRibbon';
import { guideLink, LivePage } from '../components/LivePage';
import { StageIdle } from '../components/StageIdle';
import { upNextRows, UP_NEXT_MAX } from '../components/UpNext';
import { LONG_PRESS_MS } from '../hooks/useLongPress';
import { m3uCatchupEnds } from '../lib/catchup';
import { formatClock, formatClockBare, formatTimeRange, HOUR, MINUTE } from '../lib/epgTime';
import { canDownloadCatchup, catchupDownloadArgs } from '../lib/playback';
import { i18n, installDomStubs, makeChannel, program, renderAt, settings } from './harness';

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

vi.mock('@/api/transport', () => ({
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
vi.mock('@/features/player/remote', async () => await import('./fakes'));

const fakes = await import('./fakes');

function serve(all: Channel[]) {
  return (a: unknown) => {
    const q = (a as { query: PageQuery }).query;
    return { items: all.slice(q.offset, q.offset + q.limit), total: all.length, offset: q.offset, limit: q.limit } satisfies Page<Channel>;
  };
}

beforeAll(() => {
  configure({ asyncUtilTimeout: 3000 });
  installDomStubs();
});
beforeEach(() => {
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  rpcMock.calls.length = 0;
  h['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Demo portal', channelCount: 20, movieCount: 0, seriesCount: 0, epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
  h['catalog.categories'] = () => [{ id: 'g1', sourceId: 'src1', contentType: 'live', name: 'News', hidden: false, itemCount: 20, position: 0 }];
  h['catalog.channels'] = serve(Array.from({ length: 20 }, (_, i) => makeChannel(i)));
  h['epg.nowNext'] = () => ({});
  h['epg.programs'] = () => [];
  h['favorites.contains'] = () => [];
  h['recent.list'] = () => [];
  h['remote.status'] = () => ({ running: false, port: 7310 });
  h['catalog.item'] = (a) => makeChannel(Number((a as { ref: { itemId: string } }).ref.itemId.slice(1)));
  resetChannelListMemory();
  fakes.usePlayerStore.setState({ source: undefined } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('clock formats (compact times)', () => {
  const at = (h: number, m: number) => new Date(2026, 9, 20, h, m).getTime();

  it('drops the leading zero and names a shared AM/PM once', () => {
    expect(formatClock(at(8, 5), 'en')).toBe('8:05 AM');
    expect(formatTimeRange(at(8, 0), at(8, 30), 'en')).toBe('8:00 – 8:30 AM');
    expect(formatTimeRange(at(11, 30), at(13, 0), 'en')).toBe('11:30 AM – 1:00 PM');
    expect(formatClockBare(at(20, 30), 'en')).toBe('8:30');
  });

  it("follows the locale: 24-hour clocks stay whole, a leading period stays on the range's start", () => {
    expect(formatTimeRange(at(8, 0), at(20, 30), 'de')).toBe(`${formatClock(at(8, 0), 'de')} – ${formatClock(at(20, 30), 'de')}`);
    expect(formatClockBare(at(20, 30), 'de')).toBe(formatClock(at(20, 30), 'de'));
    const ko = formatTimeRange(at(20, 0), at(20, 30), 'ko');
    expect(ko.startsWith(formatClock(at(20, 0), 'ko'))).toBe(true);
    expect(ko.split(' – ')[1]).toBe('8:30');
  });

  it('keeps two-digit hours on a 24-hour clock and drops the zero only on a 12-hour one', () => {
    for (const lang of ['de', 'fr', 'ru', 'ja', 'zh']) expect(formatClock(at(8, 5), lang)).toBe('08:05');
    expect(formatTimeRange(at(8, 0), at(9, 30), 'de')).toBe('08:00 – 09:30');
    expect(formatClockBare(at(8, 0), 'de')).toBe('08:00');
    expect(formatClock(at(20, 5), 'en')).toBe('8:05 PM');
    expect(formatClock(at(8, 5), 'ko')).toBe('오전 8:05');
  });
});

describe('channel logos (LG-14)', () => {
  it('a channel without a logo gets a coloured monogram sized to the tile, the same for the same name', () => {
    const { container } = render(<ChannelLogo name="Ringside Fight" size={64} />);
    const tile = container.querySelector<HTMLElement>('[data-monogram]')!;
    expect(tile.textContent).toBe('RF');
    expect(tile.style.background).toContain('linear-gradient');
    expect(tile.style.fontSize).toBe('23px');
    const again = render(<ChannelLogo name="Ringside Fight" size={20} />).container.querySelector<HTMLElement>('[data-monogram]')!;
    expect(again.style.background).toBe(tile.style.background);
    const other = render(<ChannelLogo name="Meridian News HD" />).container.querySelector<HTMLElement>('[data-monogram]')!;
    expect(other.textContent).toBe('MN');
  });

  it('a logo sits on a plate that does not follow the theme', () => {
    const { container } = render(<ChannelLogo src="https://x/logo.png" name="Alpha" />);
    const plate = container.firstElementChild as HTMLElement;
    expect(plate.dataset.plate).toBe('dark');
    expect(plate.className).not.toMatch(/bg-surface/);
  });
});

describe('channel rows (LG-03, LG-04)', () => {
  const now = Date.now();
  const nn = { now: program('Morning News', now - 10 * MINUTE, now + 20 * MINUTE), next: program('Weather', now + 20 * MINUTE, now + HOUR) };
  function row(props: Partial<Parameters<typeof ChannelRow>[0]> = {}) {
    const onMenuAt = vi.fn();
    const onActivate = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ChannelRow
          index={3}
          channel={makeChannel(3)}
          nowNext={nn}
          favorite={false}
          playing={false}
          active
          now={now}
          onActivate={onActivate}
          onToggleFavorite={() => undefined}
          onContextMenu={() => undefined}
          onMenuAt={onMenuAt}
          {...props}
        />
      </I18nextProvider>,
    );
    return { onMenuAt, onActivate };
  }

  it('shows the name, what is on with its time left and the bar, and no next line', () => {
    row();
    expect(screen.getByTestId('row-now-title').textContent).toBe('Morning News');
    expect(screen.getByTestId('row-now').textContent).toContain('20m');
    expect(screen.queryByText('Weather')).toBeNull();
  });

  it('the ⋮ button opens the channel menu at the button', () => {
    const { onMenuAt } = row();
    fireEvent.click(screen.getByRole('button', { name: 'Channel options' }));
    expect(onMenuAt).toHaveBeenCalledTimes(1);
    expect(onMenuAt.mock.calls[0]![1]).toEqual(makeChannel(3));
    expect(onMenuAt.mock.calls[0]![2]).toBe(3);
  });

  it('touch screens see the row actions without hovering, and a favorite carries its mark at rest', () => {
    row({ favorite: true });
    const actions = screen.getByTestId('row-actions');
    expect(actions.className).toContain('pointer-coarse:opacity-100');
    expect(actions.className).toContain('group-hover/row:opacity-100');
    // Only the ⋮ in the row's flow on touch: the star is in its menu, and the title keeps the room.
    expect(within(actions).getByRole('button', { name: 'Remove from favorites' }).className).toContain('pointer-coarse:hidden');
    expect(within(actions).getByRole('button', { name: 'Channel options' }).className).not.toContain('pointer-coarse:hidden');
    expect(screen.getByTestId('row-favorite')).toBeTruthy();
    expect(screen.getByRole('button', { name: /^4, Channel 3, Favorite/ })).toBeTruthy();
  });

  it('a long press opens the menu where the finger is and does not play the channel', () => {
    vi.useFakeTimers();
    const { onMenuAt, onActivate } = row();
    const target = screen.getByRole('button', { name: /^4, Channel 3/ });
    fireEvent.pointerDown(target, { pointerType: 'touch', isPrimary: true, clientX: 40, clientY: 50 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    expect(onMenuAt).toHaveBeenCalledWith({ x: 40, y: 50 }, makeChannel(3), 3);
    fireEvent.pointerUp(target);
    fireEvent.click(target);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it('a press that moves (a scroll) or a mouse never counts as a long press', () => {
    vi.useFakeTimers();
    const { onMenuAt } = row();
    const target = screen.getByRole('button', { name: /^4, Channel 3/ });
    fireEvent.pointerDown(target, { pointerType: 'touch', isPrimary: true, clientX: 40, clientY: 50 });
    fireEvent.pointerMove(target, { pointerType: 'touch', isPrimary: true, clientX: 40, clientY: 80 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    fireEvent.pointerDown(target, { pointerType: 'mouse', isPrimary: true, clientX: 40, clientY: 50 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS + 10));
    expect(onMenuAt).not.toHaveBeenCalled();
  });
});

describe('the idle stage (CB-AUTOPLAY-LAST)', () => {
  it('offers the last channel with what is on and Resume, and starts nothing by itself', () => {
    const now = Date.now();
    const onResume = vi.fn();
    const channel = makeChannel(2);
    render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="live" now={now} last={{ channel, nowNext: { now: program('Midday Report', now - 10 * MINUTE, now + 50 * MINUTE) } }} onResume={onResume} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Last watched')).toBeTruthy();
    expect(screen.getByTestId('stage-idle-now').textContent).toBe('Now: Midday Report · 50 min left');
    expect(onResume).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('stage-resume'));
    expect(onResume).toHaveBeenCalledWith(channel);
  });

  it('without a channel to offer, asks for one (radio says station)', () => {
    render(
      <I18nextProvider i18n={i18n}>
        <StageIdle kind="radio" now={Date.now()} />
      </I18nextProvider>,
    );
    expect(screen.getByText('Pick a station')).toBeTruthy();
    expect(screen.queryByTestId('stage-resume')).toBeNull();
  });

  it('Live offers the channel last watched on this source and plays it on Resume', async () => {
    rpcMock.handlers['recent.list'] = () => [
      { ref: { sourceId: 'src1', contentType: 'movie', itemId: 'm1' }, viewedAt: '', snapshot: { title: 'A film', contentType: 'movie' } },
      { ref: makeChannel(7).ref, viewedAt: '', snapshot: { title: 'Channel 7', contentType: 'live' } },
    ];
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    const resume = await screen.findByTestId('stage-resume');
    expect(resume.textContent).toContain('Resume Channel 7');
    expect((rpcMock.calls.find((c) => c.cmd === 'recent.list')!.args as { sourceId: string }).sourceId).toBe('src1');
    fireEvent.click(resume);
    await waitFor(() => expect(fakes.recorded.playItem.at(-1)).toMatchObject({ ref: makeChannel(7).ref }));
  });
});

describe('the Live page header and guide link', () => {
  it('names the group and its count once, in the header', async () => {
    renderAt('/s/src1/live', [{ path: '/s/:sourceId/live', element: <LivePage /> }]);
    await screen.findByText('Channel 0');
    await waitFor(() => expect(fakes.lastHeader()?.subtitle).toBe('All channels · 20 channels'));
  });

  it('the guide link carries the group and the channel to open at (LG-01)', () => {
    expect(guideLink('src 1', 'g/1', 'c7')).toBe('/epg?source=src+1&category=g%2F1&focus=c7');
    expect(guideLink('src1')).toBe('/epg?source=src1');
  });
});

describe('the ribbon (LG-02, LG-06, LG-17)', () => {
  const now = Date.now();
  const list: EpgProgram[] = [
    program('Morning Report', now - 30 * MINUTE, now + 30 * MINUTE),
    program('Afternoon Film', now + 30 * MINUTE, now + 2 * HOUR),
    program('Evening News', now + 2 * HOUR, now + 3 * HOUR),
  ];
  function ribbon(details = true) {
    rpcMock.handlers['epg.programs'] = () => list;
    renderAt('/', [
      {
        path: '/',
        element: <EpgRibbon channel={makeChannel(1)} sourceKind="xtream" watchingLive onPlayLive={() => undefined} onMapEpg={() => undefined} details={details} />,
      },
    ]);
  }
  const title = () => screen.getByTestId('ribbon-header').querySelector('p.text-sm.font-semibold')?.textContent;

  it('the pointer previews a programme and the header goes back once it leaves the timeline', async () => {
    ribbon();
    const film = await screen.findByRole('button', { name: /^Afternoon Film/ });
    expect(title()).toBe('Morning Report');
    fireEvent.mouseEnter(film);
    expect(title()).toBe('Afternoon Film');
    vi.useFakeTimers();
    fireEvent.pointerLeave(screen.getByTestId('ribbon-timeline'));
    act(() => vi.advanceTimersByTime(RIBBON_PREVIEW_LINGER_MS + 10));
    expect(title()).toBe('Morning Report');
  });

  it('a click picks a programme: it stays, its block is ringed, and Back to now returns', async () => {
    ribbon();
    const film = await screen.findByRole('button', { name: /^Afternoon Film/ });
    fireEvent.click(film);
    expect(title()).toBe('Afternoon Film');
    expect(film.getAttribute('aria-current')).toBe('true');
    fireEvent.pointerLeave(screen.getByTestId('ribbon-timeline'));
    expect(title()).toBe('Afternoon Film');
    fireEvent.click(screen.getByTestId('ribbon-back-to-now'));
    expect(title()).toBe('Morning Report');
  });

  it('a hovered programme stays while the pointer goes up to the header, and a press there picks it', async () => {
    ribbon();
    const film = await screen.findByRole('button', { name: /^Afternoon Film/ });
    fireEvent.mouseEnter(film);
    expect(title()).toBe('Afternoon Film');
    vi.useFakeTimers();
    const header = screen.getByTestId('ribbon-header');
    fireEvent.pointerLeave(screen.getByTestId('ribbon-timeline'));
    fireEvent.pointerEnter(header);
    act(() => vi.advanceTimersByTime(RIBBON_PREVIEW_LINGER_MS * 3));
    // Record, Remind and Watch live there act on what the header shows.
    expect(title()).toBe('Afternoon Film');
    fireEvent.pointerDown(header);
    fireEvent.pointerLeave(header);
    act(() => vi.advanceTimersByTime(RIBBON_PREVIEW_LINGER_MS * 3));
    expect(title()).toBe('Afternoon Film');
    expect(film.getAttribute('aria-current')).toBe('true');
  });

  it('the Now card names its channel, Watch live names what it starts, and the card lays out by its column', async () => {
    rpcMock.handlers['epg.programs'] = () => list;
    renderAt('/', [
      {
        path: '/',
        element: <EpgRibbon channel={makeChannel(4)} sourceKind="xtream" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} details />,
      },
    ]);
    const line = await screen.findByTestId('ribbon-channel');
    expect(within(line).getByText('5')).toBeTruthy();
    expect(within(line).getByText('Channel 4')).toBeTruthy();
    const live = screen.getByTestId('ribbon-back-to-live');
    expect(live.getAttribute('aria-label')).toBe('Watch live, Channel 4');
    // A narrow stage column (1280 px, a tablet) drops the art, then wraps the buttons under the text.
    expect(screen.getByTestId('epg-ribbon').className).toContain('@container/now');
    expect((screen.getByTestId('ribbon-header').firstElementChild as HTMLElement).className).toContain('@max-[26rem]/now:basis-full');
  });

  it('lists what comes next under the timeline, and a row puts it in the header', async () => {
    ribbon();
    const next = await screen.findByTestId('up-next');
    const rows = within(next).getAllByRole('listitem');
    expect(rows.map((r) => within(r).getAllByRole('button')[0]!.textContent)).toEqual([
      expect.stringContaining('Afternoon Film'),
      expect.stringContaining('Evening News'),
    ]);
    expect(within(rows[0]!).getByText('90 min')).toBeTruthy();
    fireEvent.click(within(rows[1]!).getAllByRole('button')[0]!);
    expect(title()).toBe('Evening News');
  });

  it('shows as many Up next rows as fit, none in a short column', () => {
    expect(upNextRows(0)).toBe(3);
    expect(upNextRows(30)).toBe(0);
    expect(upNextRows(32 + 44 * 2)).toBe(2);
    expect(upNextRows(2000)).toBe(UP_NEXT_MAX);
  });

  it('folds to one line on a phone until it is opened', async () => {
    ribbon();
    const line = await screen.findByTestId('ribbon-phone-line');
    expect(line.className).toContain('md:hidden');
    expect(screen.getByTestId('ribbon-header').className).toContain('max-md:hidden');
    expect(screen.getByTestId('ribbon-body').className).toContain('max-md:hidden');
    fireEvent.click(within(line).getByRole('button', { name: "Show what's on" }));
    expect(screen.queryByTestId('ribbon-phone-line')).toBeNull();
    expect(screen.getByTestId('ribbon-body').className).not.toContain('max-md:hidden');
  });

  it('without details (the old callers) keeps one plain header and no Up next', async () => {
    ribbon(false);
    await screen.findByRole('button', { name: /^Afternoon Film/ });
    expect(screen.queryByTestId('up-next')).toBeNull();
    expect(screen.queryByTestId('ribbon-phone-line')).toBeNull();
  });
});

describe('catch-up downloads (FW-ARCHIVE-DOWNLOAD-UNBOUNDED)', () => {
  const m3u = (catchup: Channel['catchup'], url = 'http://host/live/ch1.ts'): Channel => ({ ...makeChannel(1), url, archive: { enabled: true, durationHours: 24 }, catchup });

  it('offers a download only for archive links that end by themselves', () => {
    expect(m3uCatchupEnds(m3u(undefined))).toBe(false); // shift: ?utc=&lutc= runs on into live
    expect(m3uCatchupEnds(m3u({ type: 'shift' }))).toBe(false);
    expect(m3uCatchupEnds(m3u({ type: 'default', source: 'http://arc/x?start={utc}&end={utcend}' }))).toBe(true);
    expect(m3uCatchupEnds(m3u({ type: 'default', source: 'http://arc/x?start={utc}' }))).toBe(false);
    expect(m3uCatchupEnds(m3u({ type: 'append', source: '?utc={utc}&duration={duration:60}' }))).toBe(true);
    expect(m3uCatchupEnds(m3u({ type: 'xc' }, 'http://host:8080/live/user/pass/101.ts'))).toBe(true);
    expect(m3uCatchupEnds(m3u({ type: 'flussonic' }, 'http://fl.example/ch1/mpegts'))).toBe(false);
    expect(m3uCatchupEnds(m3u({ type: 'flussonic' }, 'http://fl.example/ch1/index.m3u8'))).toBe(true);
    expect(canDownloadCatchup(makeChannel(1), 'xtream')).toBe(true);
    expect(canDownloadCatchup(m3u(undefined), 'm3u')).toBe(false);
  });

  it('never queues a link that would stream on, whatever the caller offered', async () => {
    rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'hide', unlocked: false, hasPin: false });
    const now = Date.now();
    await expect(
      catchupDownloadArgs(m3u(undefined), 'm3u', program('Old', now - 2 * HOUR, now - HOUR), { now, subtitle: 'Old', notFileMessage: 'not a file' }),
    ).rejects.toThrow('not a file');
  });
});
