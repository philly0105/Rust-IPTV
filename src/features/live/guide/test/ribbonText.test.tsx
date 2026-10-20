/**
 * The ribbon timeline (L3-live-5, L3-visual-3): a block that began before the visible edge keeps
 * its title in view (sticky text, capped to the part of the block on screen), and the now line
 * passes under the blocks' text.
 */

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { EpgRibbon } from '../../components/EpgRibbon';
import { HOUR, MINUTE } from '../../lib/epgTime';
import { installDomStubs, makeChannel, program, renderAt, settings } from '../../test/harness';

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
      // The now line sits within one half hour (120 px at 4 px a minute) of the visible start.
      const into = Number.parseFloat(line.style.left) + 1 - left;
      expect(into).toBeGreaterThanOrEqual(0);
      expect(into).toBeLessThanOrEqual(120);
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
