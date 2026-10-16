/**
 * JumpToDialog (Run 2 C5) in Europe/Berlin, the week the clocks go back: day chips from two
 * days back to 13 ahead labelled with formatDay, a 30-minute time select that lists the
 * repeated hour twice, wall time kept when the day changes, the keyboard, and Now.
 */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { defaultStart } from '../../components/EpgGridPage';
import { addLocalDays, formatClock, formatDay, jumpDays, MINUTE } from '../../lib/epgTime';
import { JumpToDialog, slotOptions } from '../JumpToDialog';
import { installDomStubs, renderGuide } from './harness';

vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => await import('../../test/fakes'));
vi.mock('@/features/player', async () => await import('../../test/fakes'));
vi.mock('@/features/player/remote', async () => await import('../../test/fakes'));

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  // Before any formatter is built: the cached Intl formatters keep the zone they were made in.
  process.env.TZ = 'Europe/Berlin';
  installDomStubs();
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});
afterEach(cleanup);

function setup(over: { start?: number; now?: number } = {}) {
  const now = over.now ?? new Date(2026, 9, 21, 10, 10).getTime(); // Wed 21 Oct, 10:10 CEST
  const start = over.start ?? defaultStart(now);
  const onJump = vi.fn();
  const onNow = vi.fn();
  const onClose = vi.fn();
  renderGuide(<JumpToDialog open onClose={onClose} start={start} now={now} onJump={onJump} onNow={onNow} />);
  const dialog = screen.getByTestId('guide-jump');
  const chips = () => within(dialog).getAllByTestId('guide-jump-day');
  const time = () => within(dialog).getByRole('combobox', { name: 'Time' }) as HTMLSelectElement;
  return { now, start, onJump, onNow, onClose, dialog, chips, time };
}

describe('JumpToDialog', () => {
  it('shows 16 day chips labelled by formatDay, with the window day selected', () => {
    const { now, chips, dialog } = setup();
    expect(within(dialog).getByRole('heading', { name: 'Jump to date and time' })).toBeTruthy();
    const days = jumpDays(now);
    expect(chips()).toHaveLength(16);
    chips().forEach((c, i) => expect(c.textContent).toContain(formatDay(days[i]!, 'en')));
    const selected = chips().filter((c) => c.getAttribute('aria-checked') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.textContent?.toLowerCase()).toContain('today');
    expect(chips()[1]!.textContent?.toLowerCase()).toContain('yesterday');
    expect(chips()[3]!.textContent?.toLowerCase()).toContain('tomorrow');
    // Roving tab stop: only the selected chip is in the Tab order.
    expect(chips().filter((c) => c.tabIndex === 0)).toEqual(selected);
  });

  it('a day keeps the wall time and Jump moves there, across the DST change (25 h day)', () => {
    const { chips, time, onJump, onClose, start } = setup();
    expect(new Date(Number(time().value)).getHours()).toBe(9);
    expect(new Date(Number(time().value)).getMinutes()).toBe(30);
    // Sun 25 Oct is the fall-back day (index 6: two days back, then today, then 4 ahead).
    fireEvent.click(chips()[6]!);
    expect(chips()[6]!.getAttribute('aria-checked')).toBe('true');
    expect(time().options).toHaveLength(50);
    fireEvent.click(screen.getByTestId('guide-jump-go'));
    const at = onJump.mock.calls[0]![0] as number;
    expect(at).toBe(new Date(2026, 9, 25, 9, 30).getTime());
    // Four calendar days later, plus the extra hour.
    expect(at - start).toBe((4 * 24 + 1) * 60 * MINUTE);
    expect(onClose).toHaveBeenCalled();
  });

  it('the repeated hour is listed twice with its zone, and each picks its own instant', () => {
    const { chips, time, onJump } = setup();
    fireEvent.click(chips()[6]!);
    // Only the repeated hour carries a zone: its four slots (02:00, 02:30, each twice).
    const zoned = [...time().options].filter((o) => o.textContent !== formatClock(Number(o.value), 'en'));
    expect(zoned).toHaveLength(4);
    const twos = zoned.filter((o) => new Date(Number(o.value)).getMinutes() === 0);
    expect(twos).toHaveLength(2);
    expect(twos[0]!.textContent).not.toBe(twos[1]!.textContent);
    fireEvent.change(time(), { target: { value: twos[1]!.value } });
    fireEvent.click(screen.getByTestId('guide-jump-go'));
    expect(new Date(onJump.mock.calls[0]![0] as number).toISOString()).toBe('2026-10-25T01:00:00.000Z');
  });

  it('slotOptions only adds the zone where a label repeats', () => {
    const day = new Date(2026, 9, 25).getTime();
    const opts = slotOptions(
      Array.from({ length: 6 }, (_, i) => day + (i + 3) * 30 * MINUTE),
      'en',
    );
    const labels = opts.map((o) => o.label);
    expect(labels.filter((l) => /[A-Z]{3,}|GMT/.test(l))).toHaveLength(4);
  });

  it('arrow keys, Home and End move the day; Enter jumps', () => {
    const { chips, onJump } = setup();
    const today = chips()[2]!;
    today.focus();
    fireEvent.keyDown(today, { key: 'ArrowRight' });
    expect(chips()[3]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(chips()[3]);
    fireEvent.keyDown(chips()[3]!, { key: 'End' });
    expect(document.activeElement).toBe(chips()[15]);
    fireEvent.keyDown(chips()[15]!, { key: 'Home' });
    expect(document.activeElement).toBe(chips()[0]);
    fireEvent.keyDown(chips()[0]!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(chips()[0]);
    fireEvent.keyDown(chips()[0]!, { key: 'Enter' });
    expect(onJump).toHaveBeenCalledWith(new Date(2026, 9, 19, 9, 30).getTime());
  });

  it('Now goes back to the live window', () => {
    const { onNow, onJump, onClose } = setup();
    fireEvent.click(screen.getByTestId('guide-jump-now'));
    expect(onNow).toHaveBeenCalledTimes(1);
    expect(onJump).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a window outside the chips opens on today at the same wall time', () => {
    const now = new Date(2026, 9, 21, 10, 10).getTime();
    const { chips, time } = setup({ now, start: new Date(2026, 10, 30, 18, 0).getTime() });
    expect(chips()[2]!.getAttribute('aria-checked')).toBe('true');
    expect(Number(time().value)).toBe(new Date(2026, 9, 21, 18, 0).getTime());
  });
  // Review round 1: the chips are a roving radio group, so the dialog must open on the checked
  // chip. The kit's fallback (first tabbable) also matched the tabindex=-1 chips, so focus landed
  // on the chip two days back and Space selected it.
  it('opens with focus on the selected day, not on the first chip', () => {
    const { chips } = setup();
    expect(document.activeElement).toBe(chips()[2]);
    expect(chips()[2]!.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(document.activeElement!);
    expect(chips()[2]!.getAttribute('aria-checked')).toBe('true');
  });

  it('each opening focuses that opening’s day, even when the window moved while it was closed', () => {
    const now = new Date(2026, 9, 21, 10, 10).getTime();
    const control: { show?(start: number): void; hide?(): void } = {};
    function Host() {
      const [state, setState] = useState({ open: false, start: defaultStart(now) });
      control.show = (start) => setState({ open: true, start });
      control.hide = () => setState((s) => ({ ...s, open: false }));
      return <JumpToDialog open={state.open} onClose={() => control.hide!()} start={state.start} now={now} onJump={() => undefined} onNow={() => undefined} />;
    }
    renderGuide(<Host />);
    expect(screen.queryByTestId('guide-jump')).toBeNull();

    act(() => control.show!(addLocalDays(defaultStart(now), 3)));
    const chips = () => within(screen.getByTestId('guide-jump')).getAllByTestId('guide-jump-day');
    expect(chips()[5]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(chips()[5]);

    act(() => control.hide!());
    act(() => control.show!(addLocalDays(defaultStart(now), -1)));
    expect(chips()[1]!.getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(chips()[1]);
  });
});
