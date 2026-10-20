import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CatchupInfo, CatchupOverride, Channel, ItemRef } from '@/api/types';
import { buildCatchupOverride, catchupDraftFrom, emptyCatchup, type CatchupDraft, type DraftErrors } from '@/features/sources/lib/draft';

import { ArchivePage } from '../components/ArchivePage';
import { loadArchiveDay } from '../hooks/useArchiveDay';
import {
  archiveDayCount,
  archiveDays,
  archiveHourSlots,
  archivePath,
  archiveProgramState,
  canBrowseArchive,
  dayRange,
  dayStart,
  initialProgramIndex,
  MAX_ARCHIVE_DAYS,
  programsInDay,
} from '../lib/archive';
import { type CatchupChannel, resolveM3uCatchupUrl } from '../lib/catchup';
import { HOUR, MINUTE } from '../lib/epgTime';
import { hasAiring, markFromProvider, needsFallback, shortEpgEnabled } from '../lib/shortEpg';
import { recorded } from './fakes';
import { installDomStubs, makeChannel, program, renderAt, settings } from './harness';

configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

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
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined }));
vi.mock('@/ui', async (orig) => ({ ...(await orig<object>()), ...(await import('./fakes')) }));
vi.mock('@/shell', async () => await import('./fakes'));
vi.mock('@/features/player', async () => await import('./fakes'));
// The archive download asks the parental gate first; nothing is locked here.
vi.mock('@/features/parental/gate', async (orig) => ({ ...(await orig<object>()), ensureUnlocked: async () => true }));

// ---------------------------------------------------------------------------
// Shared catch-up URL table (core runs the same file in catchup::m3u::tests)
// ---------------------------------------------------------------------------

interface UrlCase {
  name: string;
  url: string;
  archive: boolean;
  catchup: CatchupInfo | null;
  override?: CatchupOverride;
  effective?: { archive: boolean; catchup: CatchupInfo | null };
  start: number;
  end: number;
  now: number;
  expected: string | null;
}

const CASES: UrlCase[] = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', '..', 'fixtures', 'catchup-url-cases.json'), 'utf8'));

describe('shared catch-up URL table', () => {
  it('has plain and override cases', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(10);
    expect(CASES.some((c) => c.override)).toBe(true);
  });

  it.each(CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    // Core applies overrides when channels are read; the UI gets the effective channel.
    const shape = c.effective ?? { archive: c.archive, catchup: c.catchup };
    const channel: CatchupChannel = {
      url: c.url,
      archive: shape.archive ? { enabled: true } : undefined,
      catchup: shape.catchup ?? undefined,
    };
    expect(resolveM3uCatchupUrl(channel, { start: c.start, end: c.end, now: c.now })).toBe(c.expected);
  });

  it('round-trips every override through the edit dialog draft', () => {
    for (const c of CASES) {
      if (!c.override) continue;
      const errors: DraftErrors = {};
      expect(buildCatchupOverride(catchupDraftFrom(c.override), errors)).toEqual(c.override);
      expect(errors).toEqual({});
    }
  });
});

describe('catch-up override draft', () => {
  const build = (type: CatchupDraft['type'], template = '', days = '') => {
    const errors: DraftErrors = {};
    return { value: buildCatchupOverride({ ...emptyCatchup(), type, template, days }, errors), errors };
  };

  it('keeps the playlist when no type is chosen', () => {
    expect(build('').value).toBeUndefined();
  });

  it('none carries nothing else', () => {
    expect(build('none', 'http://x/{utc}', '4').value).toEqual({ type: 'none' });
  });

  it('trims the template and parses days', () => {
    expect(build('shift', '  ?utc={utc}  ', ' 7 ').value).toEqual({ type: 'shift', template: '?utc={utc}', days: 7 });
  });

  it('rejects days outside 1..366 and control characters', () => {
    expect(build('shift', '', '0').errors).toEqual({ 'm3u.catchup.days': 'errorCatchupDays' });
    expect(build('shift', '', '367').errors).toEqual({ 'm3u.catchup.days': 'errorCatchupDays' });
    expect(build('shift', '', '2.5').errors).toEqual({ 'm3u.catchup.days': 'errorCatchupDays' });
    expect(build('shift', 'a\tb').errors).toEqual({ 'm3u.catchup.template': 'errorCatchupTemplate' });
    expect(build('shift', 'x'.repeat(2049)).errors).toEqual({ 'm3u.catchup.template': 'errorCatchupTemplate' });
  });
});

// ---------------------------------------------------------------------------
// Day and programme logic
// ---------------------------------------------------------------------------

const ch = (patch: Partial<Channel> = {}): Channel => ({ ...makeChannel(0), ...patch });

describe('archive days', () => {
  const now = new Date(2026, 9, 12, 15, 30).getTime();

  it('counts whole days from the archive length, the playlist, or a default', () => {
    expect(archiveDayCount(ch({ archive: { enabled: true, durationHours: 72 } }))).toBe(3);
    expect(archiveDayCount(ch({ archive: { enabled: true, durationHours: 49 } }))).toBe(3);
    expect(archiveDayCount(ch({ archive: { enabled: true }, catchup: { type: 'shift', days: 5 } }))).toBe(5);
    expect(archiveDayCount(ch({ archive: { enabled: true } }))).toBe(1);
    expect(archiveDayCount(ch({ archive: { enabled: true, durationHours: 24 * 400 } }))).toBe(MAX_ARCHIVE_DAYS);
  });

  it('lists today first, then back to the oldest day the archive reaches', () => {
    const days = archiveDays(now, 2);
    expect(days).toEqual([new Date(2026, 9, 12).getTime(), new Date(2026, 9, 11).getTime(), new Date(2026, 9, 10).getTime()]);
    expect(dayStart(now)).toBe(days[0]);
    expect(dayRange(days[1]!)).toEqual({ start: new Date(2026, 9, 11).getTime(), end: new Date(2026, 9, 12).getTime() });
  });

  it('orders, dedupes and clips programmes to the day', () => {
    const { start, end } = dayRange(dayStart(now));
    const a = program('A', start + HOUR, start + 2 * HOUR);
    const dup = program('A again', start + HOUR, start + 2 * HOUR);
    const before = program('Yesterday', start - 2 * HOUR, start - HOUR);
    const across = program('Across midnight', start - HOUR, start + HOUR);
    const empty = program('Empty', start + 3 * HOUR, start + 3 * HOUR);
    expect(programsInDay([a, before, empty, dup, across], start, end).map((p) => p.title)).toEqual(['Across midnight', 'A']);
  });

  it('builds an encoded route and hides the archive for radio or channels without one', () => {
    expect(archivePath({ sourceId: 'a b', itemId: '1/2' })).toBe('/live/archive/a%20b/1%2F2');
    expect(canBrowseArchive(ch(), 'xtream')).toBe(true);
    expect(canBrowseArchive(ch({ isRadio: true }), 'xtream')).toBe(false);
    expect(canBrowseArchive(ch({ archive: undefined }), 'xtream')).toBe(false);
    expect(canBrowseArchive(ch(), undefined)).toBe(false);
  });
});

describe('archive hour slots', () => {
  const now = new Date(2026, 9, 12, 15, 30).getTime();
  const title = (t: number) => `slot ${new Date(t).getHours()}`;

  it('covers the day up to the airing hour, inside the archive window', () => {
    const { start, end } = dayRange(dayStart(now));
    const slots = archiveHourSlots(start, end, now, ch({ archive: { enabled: true, durationHours: 5 } }), title);
    // 10:30 is the window's start: 11:00 is the first whole hour in it; 15:00 airs now.
    expect(slots.map((s) => s.title)).toEqual(['slot 11', 'slot 12', 'slot 13', 'slot 14', 'slot 15']);
    expect(slots[0]).toMatchObject({ start: new Date(start + 11 * HOUR).toISOString(), end: new Date(start + 12 * HOUR).toISOString() });
  });

  it('uses whole archive days without a length, and offers nothing past the window', () => {
    const yesterday = dayRange(archiveDays(now, 2)[1]!);
    const older = dayRange(archiveDays(now, 2)[2]!);
    const playlist = ch({ archive: { enabled: true }, catchup: { type: 'shift', days: 1 } });
    expect(archiveHourSlots(yesterday.start, yesterday.end, now, playlist, title)).toHaveLength(8); // 16:00 to 23:00
    expect(archiveHourSlots(older.start, older.end, now, playlist, title)).toEqual([]);
  });
});

describe('archive programme states', () => {
  const now = new Date(2026, 9, 12, 15, 30).getTime();
  const arch = ch({ archive: { enabled: true, durationHours: 48 } });

  it('past in the window plays, airing starts over, future and expired are disabled', () => {
    expect(archiveProgramState(program('past', now - 2 * HOUR, now - HOUR), arch, 'xtream', now)).toBe('playable');
    expect(archiveProgramState(program('now', now - 10 * MINUTE, now + 20 * MINUTE), arch, 'xtream', now)).toBe('airing');
    expect(archiveProgramState(program('later', now + HOUR, now + 2 * HOUR), arch, 'xtream', now)).toBe('future');
    expect(archiveProgramState(program('old', now - 50 * HOUR, now - 49 * HOUR), arch, 'xtream', now)).toBe('expired');
  });

  it('an airing programme the archive cannot replay is watched live', () => {
    expect(archiveProgramState(program('now', now - 10 * MINUTE, now + 20 * MINUTE), ch({ archive: undefined }), 'xtream', now)).toBe('live');
  });

  it('focuses the airing programme, else the latest playable one', () => {
    expect(initialProgramIndex(['playable', 'airing', 'future'])).toBe(1);
    expect(initialProgramIndex(['expired', 'live', 'future'])).toBe(1);
    expect(initialProgramIndex(['expired', 'playable', 'playable'])).toBe(2);
    expect(initialProgramIndex(['future'])).toBe(0);
    expect(initialProgramIndex([])).toBe(-1);
  });
});

describe('short EPG helpers', () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const p = program('News', now - HOUR, now + HOUR);

  it('runs only for Xtream while the setting is on', () => {
    expect(shortEpgEnabled('xtream', undefined)).toBe(true);
    expect(shortEpgEnabled('xtream', settings())).toBe(true);
    expect(shortEpgEnabled('xtream', settings({ epgShortFallback: false }))).toBe(false);
    expect(shortEpgEnabled('stalker', settings())).toBe(false);
    expect(shortEpgEnabled('m3u', settings())).toBe(false);
  });

  it('tags provider programmes and spots the gaps', () => {
    expect(markFromProvider([p])[0]).toEqual({ ...p, fromProvider: true });
    expect(hasAiring([p], now)).toBe(true);
    expect(hasAiring([p], now + 2 * HOUR)).toBe(false);
    expect(hasAiring(undefined, now)).toBe(false);
    expect(needsFallback(undefined)).toBe(true);
    expect(needsFallback({ next: p })).toBe(true);
    expect(needsFallback({ now: p })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Where a day's programmes come from
// ---------------------------------------------------------------------------

const REF: ItemRef = { sourceId: 'src1', contentType: 'live', itemId: 'c0' };

describe('loadArchiveDay', () => {
  const day = new Date(2026, 9, 11).getTime();
  const { start, end } = dayRange(day);
  const inDay = program('Evening news', start + 18 * HOUR, start + 19 * HOUR);
  const base = { ref: REF, start, end, offsetMinutes: 0, isToday: false, shortEpg: true } as const;

  beforeEach(() => {
    for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
    rpcMock.calls.length = 0;
  });
  const cmds = () => rpcMock.calls.map((c) => c.cmd);

  it('uses XMLTV when it has the day', async () => {
    rpcMock.handlers['epg.programs'] = () => [inDay];
    const list = await loadArchiveDay({ ...base, kind: 'xtream' });
    expect(list).toEqual([inDay]);
    expect(cmds()).toEqual(['epg.programs']);
  });

  it('falls back to the Xtream archive table, tagged as the provider', async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    rpcMock.handlers['catchup.programs'] = () => [inDay];
    const list = await loadArchiveDay({ ...base, kind: 'xtream' });
    expect(list).toEqual([{ ...inDay, fromProvider: true }]);
    expect(cmds()).toEqual(['epg.programs', 'catchup.programs']);
  });

  it("asks the short EPG only for today and only while it is on", async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    rpcMock.handlers['catchup.programs'] = () => [];
    rpcMock.handlers['epg.shortEpg'] = () => [inDay];
    expect(await loadArchiveDay({ ...base, kind: 'xtream' })).toEqual([]);
    expect(await loadArchiveDay({ ...base, kind: 'xtream', isToday: true, shortEpg: false })).toEqual([]);
    expect(cmds()).not.toContain('epg.shortEpg');
    expect(await loadArchiveDay({ ...base, kind: 'xtream', isToday: true })).toEqual([{ ...inDay, fromProvider: true }]);
  });

  it('reads the Stalker portal from the start of the day', async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    rpcMock.handlers['stalker.epg'] = () => [inDay];
    expect(await loadArchiveDay({ ...base, kind: 'stalker' })).toEqual([{ ...inDay, fromProvider: true }]);
    expect(rpcMock.calls[1]).toEqual({ cmd: 'stalker.epg', args: { ref: REF, limit: 50, from: new Date(start).toISOString() } });
  });

  it('M3U has only XMLTV', async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    expect(await loadArchiveDay({ ...base, kind: 'm3u' })).toEqual([]);
    expect(cmds()).toEqual(['epg.programs']);
  });

  it('applies the guide offset to the request and the answer', async () => {
    rpcMock.handlers['epg.programs'] = () => [];
    rpcMock.handlers['catchup.programs'] = () => [program('Late', start + 17 * HOUR, start + 18 * HOUR)];
    const list = await loadArchiveDay({ ...base, kind: 'xtream', offsetMinutes: 60 });
    expect(rpcMock.calls[0]?.args).toEqual({ ref: REF, from: new Date(start - HOUR).toISOString(), to: new Date(end - HOUR).toISOString() });
    expect(list[0]?.start).toBe(new Date(start + 18 * HOUR).toISOString());
  });
});

// ---------------------------------------------------------------------------
// Archive page
// ---------------------------------------------------------------------------

describe('ArchivePage', () => {
  const NOW = new Date(2026, 9, 12, 15, 30).getTime();
  const today = dayStart(NOW);
  const yesterday = archiveDays(NOW, 1)[1]!;
  const ROUTE = [{ path: '/live/archive/:sourceId/:channelId', element: <ArchivePage /> }];

  beforeAll(() => installDomStubs());
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    for (const k of Object.keys(rpcMock.handlers)) delete rpcMock.handlers[k];
    rpcMock.calls.length = 0;
    recorded.playSource.length = 0;
    recorded.playItem.length = 0;
    rpcMock.handlers['settings.get'] = () => settings();
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'xtream', name: 'Panel' });
    rpcMock.handlers['catalog.item'] = () => ch({ archive: { enabled: true, durationHours: 30 } });
    rpcMock.handlers['epg.programs'] = (a) => {
      const from = new Date((a as { from: string }).from).getTime();
      if (from !== today) return [];
      return [
        program('Morning show', NOW - 3 * HOUR, NOW - 2 * HOUR),
        program('Matinee', NOW - 30 * MINUTE, NOW + 30 * MINUTE),
        program('Late film', NOW + 2 * HOUR, NOW + 4 * HOUR),
      ];
    };
    rpcMock.handlers['catchup.programs'] = () => [program('Old match', yesterday + 20 * HOUR, yesterday + 22 * HOUR)];
    rpcMock.handlers['epg.shortEpg'] = () => [];
    rpcMock.handlers['xtream.catchupUrl'] = () => ({ url: 'http://arc/x.ts', kind: 'mpegts', title: 'x', isLive: false, isRadio: false });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  // The programme rows (a finished programme also has its Download button).
  const rows = async () =>
    within(await screen.findByTestId('archive-programs'))
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-state'));

  it('lists the days and today’s programmes with their states', async () => {
    renderAt('/live/archive/src1/c0', ROUTE);
    const tabs = within(await screen.findByTestId('archive-days')).getAllByRole('tab');
    // 30 h of archive: today plus two days back.
    expect(tabs.map((t) => t.textContent)).toEqual(['Today', 'Yesterday', expect.any(String)]);
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true');
    const list = await rows();
    expect(list.map((r) => r.getAttribute('data-state'))).toEqual(['playable', 'airing', 'future']);
    expect(list[2]?.getAttribute('aria-disabled')).toBe('true');
    expect(within(list[1]!).getByText('Play from start')).toBeTruthy();
    // The airing programme holds the roving tab stop.
    expect(list[1]?.getAttribute('tabindex')).toBe('0');
  });

  it('opens on the airing programme by scrolling only its list (L1-live-11, L1-visual-5)', async () => {
    const rect = (top: number, height: number) =>
      ({ top, height, bottom: top + height, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    const tops = new Map<Element, number>();
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: Element) {
        return tops.get(this) ?? 0;
      },
      set(this: Element, v: number) {
        tops.set(this, v);
      },
    });
    const intoView = vi.spyOn(Element.prototype, 'scrollIntoView');
    const box = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'archive-panel') return rect(100, 300);
      if (this.dataset.state === 'airing') return rect(700, 40);
      return rect(0, 0);
    });
    try {
      renderAt('/live/archive/src1/c0', ROUTE);
      await rows();
      const panel = screen.getByTestId('archive-panel');
      // The airing row lands in the middle of the list's own scroller: 700 - 100 - (300 - 40) / 2.
      await waitFor(() => expect(panel.scrollTop).toBe(470));
      // Nothing scrolls the page, so the channel header and day tabs stay in view.
      expect(intoView).not.toHaveBeenCalled();
      expect(panel.className).toContain('overflow-y-auto');
      expect(panel.contains(screen.getByTestId('archive-days'))).toBe(false);
    } finally {
      box.mockRestore();
      intoView.mockRestore();
      delete (HTMLElement.prototype as { scrollTop?: number }).scrollTop;
    }
  });

  it('plays a past programme from the archive and ignores future ones', async () => {
    renderAt('/live/archive/src1/c0', ROUTE);
    const list = await rows();
    fireEvent.click(list[2]!);
    fireEvent.click(list[0]!);
    await waitFor(() => expect(recorded.playSource).toHaveLength(1));
    expect(recorded.playSource[0]).toMatchObject({ url: 'http://arc/x.ts', subtitle: 'Morning show', isLive: false });
    const call = rpcMock.calls.find((c) => c.cmd === 'xtream.catchupUrl');
    expect(call?.args).toMatchObject({ ref: REF, start: new Date(NOW - 3 * HOUR).toISOString(), durationMinutes: 60 });
  });

  it('downloads a finished programme from its archive URL, under the channel', async () => {
    rpcMock.handlers['downloads.start'] = () => ({ id: 1 });
    renderAt('/live/archive/src1/c0', ROUTE);
    await rows();
    // Only the finished programme offers it: the airing one is still growing.
    const buttons = within(screen.getByTestId('archive-programs')).getAllByTestId('archive-download');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('Download Morning show');
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'downloads.start')).toBe(true));
    const args = rpcMock.calls.find((c) => c.cmd === 'downloads.start')!.args as Record<string, unknown>;
    expect(args).toMatchObject({
      ref: REF,
      episodeId: `catchup:${new Date(NOW - 3 * HOUR).toISOString()}`,
      url: 'http://arc/x.ts',
    });
    expect(String(args.subtitle)).toMatch(/^Morning show · /);
    expect(String(args.fileNameHint)).toMatch(/ - Morning show - .*\.ts$/);
    expect(recorded.playSource).toHaveLength(0);
  });

  it('moves through programmes with the arrows and days with the tab keys', async () => {
    renderAt('/live/archive/src1/c0', ROUTE);
    const list = await rows();
    list[1]!.focus();
    fireEvent.keyDown(list[1]!, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(list[0]);
    fireEvent.keyDown(list[0]!, { key: 'End' });
    expect(document.activeElement).toBe(list[2]);

    const tabs = within(screen.getByTestId('archive-days')).getAllByRole('tab');
    tabs[0]!.focus();
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs[1]);
    // Yesterday has no XMLTV: the panel's archive table fills it, marked as the provider's.
    expect(await screen.findByText('Old match')).toBeTruthy();
    expect(screen.getByText("These programmes come from the provider's own guide.")).toBeTruthy();
  });

  it('offers hourly slots on a day without any guide, played from their start (F-ARCHIVE-SLOTS)', async () => {
    rpcMock.handlers['catchup.programs'] = () => [];
    renderAt('/live/archive/src1/c0', ROUTE);
    await rows();
    fireEvent.click(within(screen.getByTestId('archive-days')).getAllByRole('tab')[1]!);
    expect(await screen.findByTestId('archive-slots-note')).toBeTruthy();
    const list = await rows();
    // 30 h of archive from 15:30: yesterday from 10:00 (09:00 starts before the window) to 23:00.
    expect(list).toHaveLength(14);
    expect(list.every((r) => r.getAttribute('data-state') === 'playable')).toBe(true);
    fireEvent.click(list[0]!);
    await waitFor(() => expect(rpcMock.calls.some((c) => c.cmd === 'xtream.catchupUrl')).toBe(true));
    expect(rpcMock.calls.find((c) => c.cmd === 'xtream.catchupUrl')!.args).toEqual({
      ref: REF,
      start: new Date(yesterday + 10 * HOUR).toISOString(),
      durationMinutes: 60,
    });
  });

  it('says when a day has nothing, not even archive hours', async () => {
    rpcMock.handlers['catchup.programs'] = () => [];
    renderAt('/live/archive/src1/c0', ROUTE);
    await rows();
    // Two days back is past the 30 h window: no slot can play there.
    fireEvent.click(within(screen.getByTestId('archive-days')).getAllByRole('tab')[2]!);
    expect(await screen.findByText('Nothing listed for this day')).toBeTruthy();
  });

  it('plays catch-up in its own full player and marks the programme it plays (LG-09)', async () => {
    renderAt('/live/archive/src1/c0', ROUTE);
    expect(within(await screen.findByTestId('archive-stage')).getByTestId('player-stage')).toBeTruthy();
    const list = await rows();
    fireEvent.click(list[0]!);
    await waitFor(() => expect(recorded.playSource).toHaveLength(1));
    // The fake player now holds the catch-up: its row says so.
    await waitFor(async () => expect((await rows())[0]!.getAttribute('aria-current')).toBe('true'));
    expect(within((await rows())[0]!).getByTestId('archive-playing')).toBeTruthy();
    // Navigation back is "Live TV", not "Back to live" (the stream), LG-08.
    expect(screen.getByRole('link', { name: 'Live TV' }).getAttribute('href')).toBe('/s/src1/live');
  });

  it('offers no download for an M3U archive that would stream on into live (FW-ARCHIVE-DOWNLOAD-UNBOUNDED)', async () => {
    rpcMock.handlers['sources.get'] = () => ({ id: 'src1', kind: 'm3u', name: 'Playlist' });
    // No catch-up type: the `shift` form, ?utc=<start>&lutc=<now>, which has no end.
    rpcMock.handlers['catalog.item'] = () => ch({ url: 'http://host/live/c0.ts', archive: { enabled: true, durationHours: 30 } });
    renderAt('/live/archive/src1/c0', ROUTE);
    const list = await rows();
    expect(list[0]!.getAttribute('data-state')).toBe('playable');
    expect(screen.queryByTestId('archive-download')).toBeNull();
  });

  it('explains a channel without an archive and a missing channel', async () => {
    rpcMock.handlers['catalog.item'] = () => ch({ archive: undefined });
    renderAt('/live/archive/src1/c0', ROUTE);
    expect(await screen.findByText('No catch-up for this channel')).toBeTruthy();
    cleanup();

    rpcMock.handlers['catalog.item'] = () => {
      throw Object.assign(new Error('gone'), { code: 'not_found' });
    };
    renderAt('/live/archive/src1/c0', ROUTE);
    expect(await screen.findByText('Channel not found')).toBeTruthy();
  });
});
