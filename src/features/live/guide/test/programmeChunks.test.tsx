import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EpgProgram } from '@/api/types';
import { buildScheduleIndex, slotKey, type ScheduleIndex } from '@/features/recording';

import { HOUR, MINUTE, layoutBlocks } from '../../lib/epgTime';
import { GuideRow, type GuideRowProps } from '../GuideRow';
import type { GuideHydrator, HydrationTicket } from '../hydration';
import { programmeChunks, sameProgrammeChunk } from '../programmeChunks';
import { i18n, makeChannel, program } from './harness';

vi.mock('../../components/ChannelLogo', () => ({ ChannelLogo: () => null }));

afterEach(cleanup);

const at = Date.UTC(2026, 9, 24, 0);
function programmes(start = 0, end = 24): EpgProgram[] {
  return Array.from({ length: (end - start) * 4 }, (_, i) => {
    const time = at + start * HOUR + i * 15 * MINUTE;
    return program(`P${start * 4 + i}`, time, time + 15 * MINUTE);
  });
}

function props(): GuideRowProps {
  return {
    index: 0, top: 0, height: 56, channel: makeChannel(0), programs: programmes(),
    origin: at - 7 * 24 * HOUR, now: at + 30 * HOUR, pxPerMin: 5, channelCol: 220,
    compact: false, rtl: false, kind: 'xtream', highlighted: false, playing: false,
    genreFilter: null, genreNames: { movie: 'Movies', sports: 'Sports', news: 'News', kids: 'Kids', series: 'Series' },
    labels: { onNow: 'On now', archive: 'Archive', playingNow: 'Playing now', noGuideShort: 'No guide', playChannel: (name) => `Play ${name}` },
    cursorStart: null, lang: 'en', stripCountryPrefix: false, schedule: buildScheduleIndex(),
    handlers: { play: vi.fn(), open: vi.fn(), focusCell: vi.fn(), menu: vi.fn(),
      fitText: vi.fn(() => vi.fn()), press: vi.fn(), hover: vi.fn() },
  };
}

function row(p: GuideRowProps) {
  return <I18nextProvider i18n={i18n}><GuideRow {...p} /></I18nextProvider>;
}

/** Like EpgGridPage, the parent reveals a keyboard target in its own layout effect. */
function FocusOnCommit({ value }: { value: GuideRowProps }) {
  useLayoutEffect(() => {
    if (value.cursorStart) document.querySelector<HTMLElement>(`button[data-start="${value.cursorStart}"]`)?.focus();
  });
  return row(value);
}

describe('programme time groups', () => {
  it('keeps long programmes whole, with the same native coordinates in both directions', () => {
    const list = [program('Long', at + 30 * MINUTE, at + 5 * HOUR), program('Next', at + 5 * HOUR, at + 6 * HOUR)];
    const chunks = programmeChunks(layoutBlocks(list, at, Infinity, 5, at));
    expect(chunks).toHaveLength(2);
    expect(chunks.flatMap((chunk) => chunk.blocks.map((block) => block.program))).toEqual(list);
    expect(chunks[0]).toMatchObject({ left: 150, width: 1350 });
    const p = { ...props(), programs: list };
    const view = render(row(p));
    for (const rtl of [false, true]) {
      view.rerender(row({ ...p, rtl }));
      const cell = screen.getByRole('button', { name: /^Long,/ });
      const chunk = cell.closest<HTMLElement>('[data-programme-chunk]')!;
      const side = rtl ? 'right' : 'left';
      const text = cell.querySelector<HTMLElement>('[data-pad-left]')!;
      expect(Number.parseFloat(chunk.style[side]) + 4 + Number.parseFloat(cell.style[side])).toBe(Number(text.dataset.padLeft) + 1);
      expect(Number.parseFloat(chunk.style.width)).toBe(1358);
      expect(Number.parseFloat(cell.style.width)).toBe(1348);
      expect(chunk.style.contain).toBe('strict');
      expect(chunk.style.top).toBe('-4px'); // space for the focus ring outside programme edges
    }
  });

  it('recognises cloned programmes but updates every field that actions or labels consume', () => {
    const blocks = layoutBlocks(programmes(0, 2), at, Infinity, 5, at - HOUR);
    const before = programmeChunks(blocks)[0]!;
    const clone = () => programmeChunks(blocks.map((block) => ({ ...block, program: { ...block.program } })))[0]!;
    expect(sameProgrammeChunk(before, clone())).toBe(true);
    for (const [key, value] of Object.entries({ channelId: 'other', start: 'other', end: 'other', title: 'other',
      description: 'changed', category: 'News', icon: 'image', fromProvider: true })) {
      const next = clone();
      Object.assign(next.blocks[0]!.program, { [key]: value });
      expect(sameProgrammeChunk(before, next), key).toBe(false);
    }
    const resized = clone();
    resized.blocks[0]!.width--;
    expect(sameProgrammeChunk(before, resized)).toBe(false);
  });

  it('mounts only the new six-hour edge when a cloned 24-hour answer replaces the buffer', () => {
    const p = props();
    const view = render(row(p));
    const retained = [...view.container.querySelectorAll<HTMLElement>('button[data-start]')]
      .filter((cell) => Date.parse(cell.dataset.start!) >= at + 6 * HOUR);
    vi.mocked(p.handlers.fitText).mockClear();
    view.rerender(row({ ...p, programs: programmes(6, 30) }));
    expect(retained.every((cell) => cell.isConnected)).toBe(true);
    expect(view.container.querySelectorAll('button[data-start]')).toHaveLength(96);
    expect(p.handlers.fitText).toHaveBeenCalledTimes(3);
    expect(vi.mocked(p.handlers.fitText).mock.calls.every(([chunk]) =>
      Number(chunk.getAttribute('data-programme-chunk')) >= Math.floor((at + 24 * HOUR) / (2 * HOUR)))).toBe(true);
  });

  it('keeps initial and visible programmes immediate while mounting new offscreen groups one grant at a time', () => {
    const pending: { activate: (ticket: HydrationTicket) => void; ticket: HydrationTicket }[] = [];
    const hydration: GuideHydrator = {
      isVisible: () => false,
      enqueue: vi.fn((_bounds, activate) => {
        const ticket = { cancel: vi.fn(), committed: vi.fn() };
        pending.push({ activate, ticket });
        return ticket;
      }),
      setViewport: vi.fn(), reset: vi.fn(), dispose: vi.fn(),
    };
    const p = props();
    p.handlers.hydration = hydration;
    const view = render(<FocusOnCommit value={p} />);
    expect(view.container.querySelectorAll('button[data-start]')).toHaveLength(96);
    expect(hydration.enqueue).not.toHaveBeenCalled();
    const next = { ...p, programs: programmes(6, 30) };
    view.rerender(<FocusOnCommit value={next} />);
    expect(view.container.querySelectorAll('button[data-start]')).toHaveLength(72);
    const reserved = [...view.container.querySelectorAll('[data-programme-chunk]')];
    expect(reserved).toHaveLength(12);
    expect(pending).toHaveLength(3);
    act(() => pending[0]!.activate(pending[0]!.ticket));
    expect([...view.container.querySelectorAll('[data-programme-chunk]')]).toEqual(reserved);
    expect(view.container.querySelectorAll('button[data-start]')).toHaveLength(80);
    expect(pending[0]!.ticket.committed).toHaveBeenCalledTimes(1);
    // A keyboard reveal must not wait behind the remaining offscreen groups.
    const focused = next.programs[80]!;
    view.rerender(<FocusOnCommit value={{ ...next, cursorStart: focused.start }} />);
    const target = screen.getByRole('button', { name: new RegExp(`^${focused.title},`) });
    expect(target.tabIndex).toBe(0);
    expect(document.activeElement).toBe(target);
    expect(view.container.querySelectorAll('button[data-start]')).toHaveLength(88);
    expect(pending[1]!.ticket.cancel).toHaveBeenCalled();
    view.unmount();
    expect(pending[2]!.ticket.cancel).toHaveBeenCalled();
  });

  it('updates only affected groups for keyboard focus, recording marks, and programme corrections', () => {
    const p = props();
    const view = render(row(p));
    vi.mocked(p.handlers.fitText).mockClear();
    const first = p.programs![0]!;
    const later = p.programs![16]!;
    view.rerender(row({ ...p, cursorStart: first.start }));
    expect(p.handlers.fitText).toHaveBeenCalledTimes(1);
    vi.mocked(p.handlers.fitText).mockClear();
    view.rerender(row({ ...p, cursorStart: later.start }));
    expect(p.handlers.fitText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: /^P16,/ }).tabIndex).toBe(0);

    const schedule: ScheduleIndex = { ...p.schedule, reminders: new Map(p.schedule.reminders) };
    vi.mocked(p.handlers.fitText).mockClear();
    view.rerender(row({ ...p, cursorStart: later.start, schedule }));
    expect(p.handlers.fitText).not.toHaveBeenCalled();
    const marked: ScheduleIndex = { ...schedule, reminders: new Map([[slotKey(p.channel!.ref, later.start), {
      id: 'reminder', ref: p.channel!.ref, channelName: p.channel!.name, title: later.title,
      start: later.start, end: later.end, status: 'pending',
    }]]) };
    view.rerender(row({ ...p, cursorStart: later.start, schedule: marked }));
    expect(p.handlers.fitText).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /^P16,/ }).querySelector('[data-testid="mark-reminder"]')).not.toBeNull();

    vi.mocked(p.handlers.fitText).mockClear();
    const corrected = p.programs!.map((item, i) => i === 40 ? { ...item, title: 'Corrected', description: 'Latest details' } : { ...item });
    view.rerender(row({ ...p, programs: corrected, cursorStart: later.start, schedule: marked }));
    expect(p.handlers.fitText).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /^Corrected,/ }));
    expect(p.handlers.open).toHaveBeenCalledWith(0, p.channel, corrected[40], expect.any(HTMLElement));
  });
});
