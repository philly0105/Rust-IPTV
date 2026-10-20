/**
 * Review round 3 (kit accessibility): hoverable tooltips (WCAG 1.4.13), a keyboard tooltip that
 * no longer costs Escape-back a second press, the chosen segment's 3:1 ring, glass focus, the
 * glass progress track, and the Switch and Radio marks in forced colours. The colour pairs are
 * computed in contrast.test.ts; this file checks what the components render.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { useEscapeBack } from '@/features/vod/hooks/useBackKey';

import { Checkbox, IconButton, ProgressBar, Radio, SegmentedControl, Switch, Tabs, Tooltip } from '..';
import { SWITCH_FORCED } from '../Field';
import { GLASS_FOCUS } from '../focus';
import { PROGRESS_TRACK } from '../Misc';
import { SEGMENT_TONES } from '../Segmented';
import { TOOLTIP_CLOSE_MS } from '../Tooltip';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** jsdom guesses :focus-visible from earlier events; pin it as a keyboard user's focus. */
function keyboardFocus(el: HTMLElement): void {
  const real = el.matches.bind(el);
  vi.spyOn(el, 'matches').mockImplementation((sel: string) => (sel === ':focus-visible' ? document.activeElement === el : real(sel)));
  act(() => el.focus());
}

describe('tooltip-not-hoverable: the pointer can rest on a tooltip (WCAG 1.4.13)', () => {
  it('stays while the pointer is on the trigger or the tooltip, and goes a moment after it leaves both', () => {
    vi.useFakeTimers();
    render(<IconButton label="Add to My List" tooltip="Saves it to My List on every device" icon={<svg />} />);
    const btn = screen.getByRole('button', { name: 'Add to My List' });
    fireEvent.mouseEnter(btn);
    act(() => vi.advanceTimersByTime(400));
    const tip = screen.getByRole('tooltip');
    expect(tip.className).not.toContain('pointer-events-none');

    // Across the gap and onto the tooltip: it stays as long as the pointer rests there.
    fireEvent.mouseLeave(btn);
    act(() => vi.advanceTimersByTime(TOOLTIP_CLOSE_MS / 2));
    fireEvent.mouseEnter(tip);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole('tooltip')).toBe(tip);

    // Back to the trigger, still shown; then off both, and it goes.
    fireEvent.mouseLeave(tip);
    fireEvent.mouseEnter(btn);
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.getByRole('tooltip')).toBe(tip);
    fireEvent.mouseLeave(btn);
    act(() => vi.advanceTimersByTime(TOOLTIP_CLOSE_MS - 1));
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Escape still dismisses it with the pointer on the tooltip, and claims that press', () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) back();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<IconButton label="Mute" icon={<svg />} />);
      const btn = screen.getByRole('button', { name: 'Mute' });
      fireEvent.mouseEnter(btn);
      act(() => vi.advanceTimersByTime(400));
      const tip = screen.getByRole('tooltip');
      fireEvent.mouseLeave(btn);
      fireEvent.mouseEnter(tip);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(back).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  it('a tooltip the pointer has left lets Escape through at once', () => {
    vi.useFakeTimers();
    const back = vi.fn();
    const onKey = (e: KeyboardEvent) => {
      // Like useEscapeBack: stand aside while a tooltip is on the page.
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="tooltip"]')) back();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<IconButton label="Mute" icon={<svg />} />);
      const btn = screen.getByRole('button', { name: 'Mute' });
      fireEvent.mouseEnter(btn);
      act(() => vi.advanceTimersByTime(400));
      fireEvent.mouseLeave(btn);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(back).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  it('moving to the next control shows its tooltip at once and closes the first: one at a time', () => {
    vi.useFakeTimers();
    render(
      <>
        <IconButton label="Play" icon={<svg />} />
        <IconButton label="Next" icon={<svg />} />
      </>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Play' }));
    act(() => vi.advanceTimersByTime(400));
    fireEvent.mouseLeave(screen.getByRole('button', { name: 'Play' }));
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Next' }));
    const tips = screen.getAllByRole('tooltip');
    expect(tips.map((t) => t.textContent)).toEqual(['Next']);
  });

  it('a press on the tooltip closes it and never reaches what holds the trigger', () => {
    vi.useFakeTimers();
    const onCard = vi.fn();
    render(
      // A clickable card (or a player surface that toggles playback) around the control.
      <div onClick={onCard} onDoubleClick={onCard} onPointerDown={onCard}>
        <IconButton label="More" icon={<svg />} />
      </div>,
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'More' }));
    act(() => vi.advanceTimersByTime(400));
    const tip = screen.getByRole('tooltip');
    fireEvent.click(tip);
    fireEvent.doubleClick(tip);
    fireEvent.pointerDown(tip);
    expect(onCard).not.toHaveBeenCalled();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('keyboard-tooltip-blocks-back: one Escape goes Back from a keyboard-focused control', () => {
  function Page({ onBack }: { onBack: () => void }) {
    useEscapeBack(true, onBack);
    return (
      <Tooltip content="Open the guide" describe={false}>
        <a href="/epg">Guide</a>
      </Tooltip>
    );
  }

  it('the keyboard tooltip hides and Back runs on the same press', () => {
    const back = vi.fn();
    render(
      <MemoryRouter>
        <Page onBack={back} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Guide' });
    keyboardFocus(link);
    expect(screen.getByRole('tooltip').textContent).toBe('Open the guide');
    fireEvent.keyDown(link, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('a tooltip the pointer brought up still takes the first press, and Back the next', async () => {
    const back = vi.fn();
    render(
      <MemoryRouter>
        <Page onBack={back} />
      </MemoryRouter>,
    );
    fireEvent.mouseEnter(screen.getByRole('link', { name: 'Guide' }));
    expect(await screen.findByRole('tooltip', {}, { timeout: 2000 })).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(back).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe('segment-selection-contrast and glass-segment-focus', () => {
  function Choice({ tone }: { tone?: 'default' | 'glass' }) {
    const [v, setV] = useState<'a' | 'b'>('a');
    return (
      <SegmentedControl
        label="Size"
        tone={tone}
        value={v}
        onChange={setV}
        options={[
          { value: 'a', label: 'Small' },
          { value: 'b', label: 'Large' },
        ]}
      />
    );
  }

  it('the chosen segment carries the 3:1 ring and the system selection colours; the others do not', () => {
    render(<Choice />);
    const chosen = screen.getByRole('radio', { name: 'Small' });
    const other = screen.getByRole('radio', { name: 'Large' });
    for (const c of ['ring-1', 'ring-border', 'forced-colors:bg-[Highlight]', 'forced-colors:text-[HighlightText]']) {
      expect(chosen.className, c).toContain(c);
      expect(other.className, c).not.toContain(c);
    }
    fireEvent.click(other);
    expect(other.className).toContain('ring-border');
    expect(chosen.className).not.toContain('ring-border');
  });

  it('pill tabs draw the same ring on the chosen tab', () => {
    render(<Tabs variant="pill" items={[{ id: 'a', label: 'Grid' }, { id: 'b', label: 'List' }]} value="a" onChange={() => {}} />);
    expect(screen.getByRole('tab', { name: 'Grid' }).className).toContain('ring-border');
    expect(screen.getByRole('tab', { name: 'List' }).className).not.toContain('ring-border');
  });

  it('glass segments focus in the glass accent and ring the chosen one in the glass tone', () => {
    render(<Choice tone="glass" />);
    for (const name of ['Small', 'Large']) {
      const seg = screen.getByRole('radio', { name });
      for (const c of GLASS_FOCUS.split(' ')) expect(seg.className, `${name}: ${c}`).toContain(c);
    }
    expect(screen.getByRole('radio', { name: 'Small' }).className).toContain(SEGMENT_TONES.glass.thumb.split(' ').at(-1)!);
  });

  it('app-surface segments keep the theme focus', () => {
    render(<Choice />);
    expect(screen.getByRole('radio', { name: 'Small' }).className).not.toContain('--color-glass-accent');
  });
});

describe('glass-progress-contrast', () => {
  it('a glass bar draws on the dark glass track, a theme bar on the recessed surface', () => {
    render(
      <>
        <ProgressBar value={40} label="Watched" tone="glass" />
        <ProgressBar value={40} label="Loaded" />
      </>,
    );
    const glass = screen.getByRole('progressbar', { name: 'Watched' });
    const theme = screen.getByRole('progressbar', { name: 'Loaded' });
    expect(glass.className).toContain(PROGRESS_TRACK.glass);
    expect(glass.className).not.toContain('bg-on-glass/20');
    expect(theme.className).toContain(PROGRESS_TRACK.theme);
  });
});

describe('forced-colors-state-marks: the Switch and Radio keep their marks in forced colours', () => {
  it('the switch opts out of the forced fills and draws both states in system colours', () => {
    function Both() {
      return (
        <>
          <Switch aria-label="Off one" checked={false} onCheckedChange={() => {}} />
          <Switch aria-label="On one" checked onCheckedChange={() => {}} />
        </>
      );
    }
    render(<Both />);
    for (const [name, state] of [
      ['Off one', 'off'],
      ['On one', 'on'],
    ] as const) {
      const sw = screen.getByRole('switch', { name });
      const knob = sw.querySelector<HTMLElement>('[data-switch-knob]')!;
      expect(sw.className).toContain('forced-color-adjust-none');
      for (const c of SWITCH_FORCED[state].track.split(' ')) expect(sw.className, `${name} track ${c}`).toContain(c);
      for (const c of SWITCH_FORCED[state].knob.split(' ')) expect(knob.className, `${name} knob ${c}`).toContain(c);
    }
    // The knob differs from its track in both states, in system colours.
    expect(SWITCH_FORCED.on.knob).toContain('HighlightText');
    expect(SWITCH_FORCED.on.track).toContain('[Highlight]');
    expect(SWITCH_FORCED.off.knob).toContain('[CanvasText]');
    expect(SWITCH_FORCED.off.track).toContain('bg-[Canvas]');
  });

  it('the radio goes back to the system radio, and its drawn dot steps aside', () => {
    render(<Radio name="p" value="a" aria-label="mpv" defaultChecked />);
    const radio = screen.getByRole('radio', { name: 'mpv' });
    expect(radio.className).toContain('forced-colors:appearance-auto');
    expect(radio.parentElement!.querySelector('[data-radio-dot]')!.className).toContain('forced-colors:hidden');
  });

  it('a checked checkbox is outlined in the mark tone, so the bright light-theme fill keeps a 3:1 edge', () => {
    render(<Checkbox aria-label="Also delete the files" defaultChecked />);
    const box = screen.getByRole('checkbox', { name: 'Also delete the files' });
    expect(box.className).toContain('checked:border-accent-mark');
    expect(box.className).not.toContain('checked:border-accent-solid');
  });
});
