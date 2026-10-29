/**
 * The ribbon timeline (L3-live-5, L3-visual-3): a block that began before the visible edge keeps
 * its title in view (sticky text, capped to the part of the block on screen), and the now line
 * passes under the blocks' text.
 */

import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpgRibbon, RIBBON_NOW_LEAD_PX, RIBBON_PX_PER_MIN } from '../../components/EpgRibbon';
import { floorLocal, HOUR, MINUTE, nowRestLeft, lookbackMs } from '../../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from '../../test/harness';
import { usePlayerStore } from '../../test/fakes';

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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('../../test/fakes')) }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

beforeAll(installDomStubs);
beforeEach(() => {
  usePlayerStore.setState({ source: undefined, positionSeconds: 0 });
  const h = rpcMock.handlers;
  for (const k of Object.keys(h)) delete h[k];
  h['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Demo', epg: { detectedUrls: [], manualUrls: [], disabledUrls: [] } });
  h['sources.list'] = () => [h['sources.get']!({})];
  h['settings.get'] = () => settings();
  h['settings.update'] = () => settings();
});
afterEach(cleanup);

function renderRibbon() {
  renderAt('/', [
    { path: '/', element: <EpgRibbon channel={makeChannel(0)} sourceKind="m3u" watchingLive={false} onPlayLive={() => undefined} onMapEpg={() => undefined} /> },
  ]);
}

describe('ribbon timeline text', () => {
  it('opens the mini guide at catch-up playback and shows that programme in the details card', async () => {
    const now = Date.now();
    const channel = makeChannel(0);
    const past = program('Earlier show', now - 6 * HOUR, now - 5 * HOUR);
    const scrolls: number[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, _options?: ScrollToOptions | number) {
      const options = _options as ScrollToOptions;
      if (this.getAttribute('data-testid') === 'ribbon-timeline') scrolls.push(options.left ?? 0);
    });
    // XMLTV has no archive entry for this show. Playback metadata must still anchor the ribbon.
    rpcMock.handlers['epg.programs'] = () => [program('On now', now - 20 * MINUTE, now + 40 * MINUTE)];
    usePlayerStore.setState({ source: {
      url: 'http://archive/earlier', kind: 'hls', title: 'Channel 0', subtitle: past.title,
      ref: channel.ref, catchupProgramStart: past.start, durationSeconds: 3600, isLive: false, isRadio: false,
    }, positionSeconds: 15 * 60 });
    try {
      renderRibbon();
      const header = await screen.findByTestId('ribbon-header');
      await waitFor(() => expect(header.textContent).toContain('Earlier show'));
      expect(header.textContent).not.toContain('On now');
      expect(within(header).getByTestId('ribbon-playing')).toBeTruthy();
      expect(within(header).queryByText('LIVE')).toBeNull();
      expect(screen.getByRole('button', { name: /^Earlier show,/ }).hasAttribute('data-playing')).toBe(true);

      const from = Math.floor(now / (15 * MINUTE)) * 15 * MINUTE - lookbackMs(channel);
      const playbackAt = new Date(past.start).getTime() + 15 * MINUTE;
      expect(scrolls.at(-1)).toBe(nowRestLeft(playbackAt, from, RIBBON_PX_PER_MIN, 1200, RIBBON_NOW_LEAD_PX));
      fireEvent.click(screen.getByRole('button', { name: 'Now' }));
      expect(scrolls.at(-1)).toBe(nowRestLeft(now, from, RIBBON_PX_PER_MIN, 1200, RIBBON_NOW_LEAD_PX));
      fireEvent.click(screen.getByRole('button', { name: 'Go to playing' }));
      expect(scrolls.at(-1)).toBe(nowRestLeft(playbackAt, from, RIBBON_PX_PER_MIN, 1200, RIBBON_NOW_LEAD_PX));

      const next = program('Another archive show', now - 4 * HOUR, now - 3 * HOUR);
      act(() => usePlayerStore.setState({ source: {
        url: 'http://archive/next', kind: 'hls', title: 'Channel 0', subtitle: next.title,
        ref: channel.ref, catchupProgramStart: next.start, durationSeconds: 3600, isLive: false, isRadio: false,
      }, positionSeconds: 0 }));
      expect(header.textContent).toContain(next.title);
      expect(scrolls.at(-1)).toBe(nowRestLeft(new Date(next.start).getTime(), from, RIBBON_PX_PER_MIN, 1200, RIBBON_NOW_LEAD_PX));

      act(() => usePlayerStore.setState({ source: {
        url: 'http://live/channel', kind: 'hls', title: 'Channel 0', ref: channel.ref, isLive: true, isRadio: false,
      }, positionSeconds: 0 }));
      await waitFor(() => expect(header.textContent).toContain('On now'));
      expect(within(header).queryByTestId('ribbon-playing')).toBeNull();
      expect(scrolls.at(-1)).toBe(nowRestLeft(now, from, RIBBON_PX_PER_MIN, 1200, RIBBON_NOW_LEAD_PX));
    } finally {
      spy.mockRestore();
    }
  });

  it('uses the Xtream archive table for a show absent from XMLTV', async () => {
    const now = Date.now();
    const past = { ...program('Provider archive show', now - 3 * HOUR, now - 2 * HOUR), description: 'An archived programme.' };
    rpcMock.handlers['epg.programs'] = () => [program('On now', now - 20 * MINUTE, now + 40 * MINUTE)];
    rpcMock.handlers['catchup.table'] = () => [past];
    usePlayerStore.setState({ source: {
      url: 'http://archive/provider', kind: 'direct', title: 'Channel 0', subtitle: past.title,
      ref: makeChannel(0).ref, catchupProgramStart: past.start, durationSeconds: 3600, isLive: false, isRadio: false,
    } });
    renderAt('/', [{ path: '/', element: <EpgRibbon channel={makeChannel(0)} sourceKind="xtream" watchingLive={false} watchingArchive onPlayLive={() => undefined} onMapEpg={() => undefined} details /> }]);
    const header = await screen.findByTestId('ribbon-header');
    await waitFor(() => expect(screen.getByTestId('ribbon-description').textContent).toBe('An archived programme.'));
    expect(header.textContent).toContain(past.title);
    expect(screen.getByRole('button', { name: /^Provider archive show,/ }).hasAttribute('data-playing')).toBe(true);
  });

  it('marks the selected catch-up programme instead of the airing one', async () => {
    const now = Date.now();
    const past = program('Earlier show', now - 2 * HOUR, now - HOUR);
    rpcMock.handlers['epg.programs'] = () => [past, program('On now', now - 20 * MINUTE, now + 40 * MINUTE)];
    renderRibbon();
    const earlier = await screen.findByRole('button', { name: /^Earlier show,/ });
    const airing = screen.getByRole('button', { name: /^On now,/ });

    act(() => usePlayerStore.setState({ source: {
      url: 'http://archive/earlier', kind: 'hls', title: 'Channel 0', ref: makeChannel(0).ref,
      catchupProgramStart: past.start, isLive: false, isRadio: false,
    } }));
    expect(earlier.hasAttribute('data-playing')).toBe(true);
    expect(earlier.className).toContain('ring-accent-mark');
    expect(earlier.getAttribute('aria-label')).toContain('playing');
    expect(airing.hasAttribute('data-playing')).toBe(false);
  });

  it('marks the same catch-up programme in list mode', async () => {
    const now = Date.now();
    const past = program('Earlier show', now - 2 * HOUR, now - HOUR);
    rpcMock.handlers['settings.get'] = () => settings({ epgViewMode: 'list' });
    rpcMock.handlers['epg.programs'] = () => [past, program('On now', now - 20 * MINUTE, now + 40 * MINUTE)];
    usePlayerStore.setState({ source: {
      url: 'http://archive/earlier', kind: 'hls', title: 'Channel 0', ref: makeChannel(0).ref,
      catchupProgramStart: past.start, isLive: false, isRadio: false,
    } });
    renderRibbon();

    const earlier = await screen.findByRole('button', { name: /^Earlier show,.*playing$/ });
    expect(earlier.getAttribute('aria-current')).toBe('true');
    expect(earlier.getAttribute('tabindex')).toBe('0');
    expect(earlier.className).toContain('tuning-tick');
    expect(screen.getByTestId('ribbon-header').textContent).toContain('Earlier show');
    expect(screen.getByRole('button', { name: /On now/ }).className).not.toContain('tuning-tick');
  });

  it('a programme that began before the visible edge keeps its title on screen, ending inside the block', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [
      // Began 3 h ago: the timeline opens a quarter of a screen before now, past its start.
      program('Long Night Movie', now - 3 * HOUR, now + 30 * MINUTE),
      program('Late Show', now + 30 * MINUTE, now + 90 * MINUTE),
    ];
    renderRibbon();
    const block = await screen.findByRole('button', { name: /^Long Night Movie,/ });
    const text = within(block).getByTestId('ribbon-block-text');
    // The block is no scroll container, so its text sticks to the timeline's own scroll.
    expect(block.className).toContain('overflow-clip');
    expect(block.className).not.toContain('overflow-hidden');
    expect(text.className).toContain('sticky');
    await waitFor(() => expect(parseFloat(text.style.maxWidth)).toBeGreaterThan(0));
    expect(parseFloat(text.style.maxWidth)).toBeLessThan(parseFloat(block.style.width));
    expect(within(text).getByText('Long Night Movie')).toBeTruthy();
    // A block that starts in view is not capped.
    const later = within(screen.getByRole('button', { name: /^Late Show,/ })).getByTestId('ribbon-block-text');
    expect(later.style.maxWidth).toBe('');
  });

  it('draws the now line before the blocks, so it passes under their text', async () => {
    const now = Date.now();
    rpcMock.handlers['epg.programs'] = () => [program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE)];
    renderRibbon();
    const block = await screen.findByRole('button', { name: /^Midday Report,/ });
    const line = screen.getByTestId('ribbon-now-line');
    expect(line.className).not.toMatch(/(^|\s)z-/);
    expect(line.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The airing block is opaque, so the line never shows through its title (a see-through
    // block let it through every glyph gap); its stub sits at the block's foot, in the line's red.
    expect(block.getAttribute('data-when')).toBe('now');
    const classes = block.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['bg-surface', 'dark:bg-surface-3']));
    expect(block.className).not.toMatch(/(^|\s)bg-(active|hover|selected)(\s|$)/);
    expect(block.className).not.toMatch(/(^|\s)(dark:)?bg-[\w-]+\/\d+(\s|$)/);
    const tick = within(block).getByTestId('ribbon-now-tick');
    expect(tick.className.split(/\s+/)).toContain('bg-live');
  });
});

describe('the ribbon opens on the half hour (review round 2)', () => {
  it('rests on the local half hour now is in, and an hour label cut at the edge steps aside', async () => {
    const lefts: number[] = [];
    const spy = vi.spyOn(Element.prototype, 'scrollTo').mockImplementation(function (this: Element, o?: ScrollToOptions | number) {
      if (typeof o === 'object' && o.left !== undefined) lefts.push(o.left);
    });
    try {
      const now = Date.now();
      rpcMock.handlers['epg.programs'] = () => [program('Midday Report', now - 30 * MINUTE, now + 30 * MINUTE), program('Late Show', now + 30 * MINUTE, now + 2 * HOUR)];
      renderRibbon();
      await screen.findByRole('button', { name: /^Midday Report,/ });
      const left = lefts.at(-1)!;
      const line = screen.getByTestId('ribbon-now-line');
      // The visible start is the local half hour now is in (4 px a minute), or the one before when
      // now is too close to it for the line's head to clear the first label.
      const into = Number.parseFloat(line.style.left) + 1 - left;
      const past = ((now - floorLocal(now, 30)) / MINUTE) * RIBBON_PX_PER_MIN;
      expect(into).toBeCloseTo(past < RIBBON_NOW_LEAD_PX ? past + 30 * RIBBON_PX_PER_MIN : past, 0);
      expect(into).toBeGreaterThanOrEqual(RIBBON_NOW_LEAD_PX);
      // An hour label that starts before the visible edge steps aside; the others show.
      const labels = screen.getAllByTestId('ribbon-hour-label');
      expect(labels.length).toBeGreaterThan(2);
      for (const label of labels) {
        const x = Number.parseFloat((label.parentElement as HTMLElement).style.left);
        expect(label.className.includes('invisible'), `label at ${x}, edge at ${left}`).toBe(x < left);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
