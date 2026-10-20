// The component kit of the SaaS polish pass (docs/architecture/design-system.md): the form
// controls every feature shares (DS-DUPLICATE-CONTROLS), tooltips instead of native titles
// (DS-TOOLTIP-UNUSED), the page scaffold, LivePill and MetaLine, overlay exits
// (DS-MOTION-EXIT) and touch sizes (DS-TOUCH-TARGETS).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import {
  BackButton,
  Checkbox,
  Dialog,
  IconButton,
  LivePill,
  Menu,
  MetaLine,
  Page,
  PageHeader,
  RadioGroup,
  SectionHeader,
  SegmentedControl,
  Switch,
  Tabs,
  Toggle,
  Tooltip,
  buttonClass,
  useTooltip,
} from '..';
import { SWITCH_TONES } from '../Field';
import { mergeShownToasts, type ToastRecord } from '../Toast';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Switch', () => {
  it('is one switch: role, state, a knob in the state’s own tone that slides (mirrored in RTL), the solid accent when on', () => {
    function Host() {
      const [on, setOn] = useState(false);
      return <Switch aria-label="Auto refresh" checked={on} onCheckedChange={setOn} />;
    }
    render(<Host />);
    const sw = screen.getByRole('switch', { name: 'Auto refresh' });
    const knob = () => sw.querySelector<HTMLElement>('[data-switch-knob]')!;
    const classes = (el: HTMLElement) => el.className.split(/\s+/);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    // The classes contrast.test checks (SWITCH_TONES) are the ones drawn.
    expect(classes(sw)).toEqual(expect.arrayContaining(SWITCH_TONES.off.track.split(' ')));
    expect(classes(sw)).toContain('border-border');
    expect(classes(knob())).toEqual(expect.arrayContaining(SWITCH_TONES.off.knob.split(' ')));
    // A white knob all but vanished on the light off track (1.2:1).
    expect(classes(knob())).not.toContain('bg-white');
    expect(knob().className).toContain('rtl:-translate-x-0.5');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(classes(sw)).toEqual(expect.arrayContaining(SWITCH_TONES.on.track.split(' ')));
    expect(classes(sw)).toContain('bg-accent-solid');
    expect(classes(knob())).toEqual(expect.arrayContaining(SWITCH_TONES.on.knob.split(' ')));
    expect(classes(knob())).not.toContain('bg-white');
    expect(knob().className).toContain('translate-x-5.5');
    expect(knob().className).toContain('rtl:-translate-x-5.5');
  });

  it('Toggle is a labelled Switch: the label names it and a click on it toggles', () => {
    const onChange = vi.fn();
    render(<Toggle label="Delete the file too" description="It cannot be undone" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Delete the file too' });
    expect(sw.getAttribute('aria-describedby')).toBeTruthy();
    fireEvent.click(screen.getByText('Delete the file too'));
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe('Checkbox', () => {
  it('is a native checkbox drawn as the kit box, with a mixed state', () => {
    const onChecked = vi.fn();
    const { rerender } = render(
      <label>
        <Checkbox checked={false} onCheckedChange={onChecked} />
        Sports
      </label>,
    );
    const box = screen.getByRole('checkbox', { name: 'Sports' }) as HTMLInputElement;
    expect(box.className).toContain('appearance-none');
    expect(box.className).toContain('border-border');
    fireEvent.click(box);
    expect(onChecked).toHaveBeenCalledWith(true);
    rerender(
      <label>
        <Checkbox checked={false} indeterminate onCheckedChange={onChecked} />
        Sports
      </label>,
    );
    expect(box.indeterminate).toBe(true);
  });
});

describe('RadioGroup', () => {
  it('is a group of native radios in labelled rows; the chosen row takes the neutral selected fill', () => {
    const onValue = vi.fn();
    render(
      <RadioGroup
        label="Player"
        value="html5"
        onValueChange={onValue}
        options={[
          { value: 'html5', label: 'Built in', description: 'Plays in the app' },
          { value: 'vlc', label: 'VLC', note: 'Not found', disabled: true },
          { value: 'mpv', label: 'mpv', testId: 'player-mpv' },
        ]}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Player' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[1]!.disabled).toBe(true);
    expect(radios[0]!.closest('label')!.className).toContain('bg-selected');
    expect(screen.getByText('Not found').className).toContain('text-warning');
    fireEvent.click(screen.getByTestId('player-mpv'));
    expect(onValue).toHaveBeenCalledWith('mpv');
  });
});

describe('SegmentedControl', () => {
  const options = [
    { value: 'a', label: 'Comfortable' },
    { value: 'b', label: 'Compact' },
    { value: 'c', label: 'Large', content: <span aria-hidden>L</span> },
  ];

  it('draws one neutral raised thumb, moves with arrows and claims the keys', () => {
    const onChange = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <SegmentedControl label="Density" value="a" onChange={onChange} options={options} />
      </div>,
    );
    const chosen = screen.getByRole('radio', { name: 'Comfortable' });
    expect(chosen.className).toContain('bg-raised');
    expect(chosen.className).not.toMatch(/bg-accent/);
    expect(chosen.tabIndex).toBe(0);
    expect(screen.getByRole('radio', { name: 'Compact' }).tabIndex).toBe(-1);
    fireEvent.keyDown(chosen, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(chosen, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
    expect(outer).not.toHaveBeenCalled();
  });

  it('names a segment that shows a sample through its label, and pill Tabs share the thumb', () => {
    render(
      <>
        <SegmentedControl label="Size" value="a" onChange={() => {}} options={options} />
        <Tabs variant="pill" items={[{ id: 'x', label: 'All' }]} value="x" onChange={() => {}} />
      </>,
    );
    expect(screen.getByRole('radio', { name: 'Large' }).textContent).toBe('L');
    expect(screen.getByRole('tab', { name: 'All' }).className).toContain('bg-raised');
  });
});

describe('IconButton tooltip', () => {
  it('shows the themed tooltip with the shortcut as key caps instead of a native title', () => {
    vi.useFakeTimers();
    render(<IconButton label="Open command palette" shortcut="mod+k" icon={<svg />} />);
    const button = screen.getByRole('button', { name: 'Open command palette' });
    expect(button.hasAttribute('title')).toBe(false);
    fireEvent.mouseEnter(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toMatch(/^Open command palette/);
    expect([...tip.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['Ctrl', 'K']);
    // It repeats the accessible name, so it does not describe the button a second time.
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    fireEvent.mouseLeave(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('describes the button when the tooltip says more than the name, and can be turned off', () => {
    vi.useFakeTimers();
    render(
      <>
        <IconButton label="Watched" tooltip="Marked as watched. Press to undo." icon={<svg />} />
        <IconButton label="Close" tooltip={false} icon={<svg />} />
      </>,
    );
    const watched = screen.getByRole('button', { name: 'Watched' });
    fireEvent.mouseEnter(watched);
    act(() => vi.advanceTimersByTime(400));
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe('Marked as watched. Press to undo.');
    expect(watched.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.mouseLeave(watched);
    act(() => vi.advanceTimersByTime(1000));
    const close = screen.getByRole('button', { name: 'Close' });
    fireEvent.mouseEnter(close);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('ignores the mouse events a touch sends after a tap', () => {
    vi.useFakeTimers();
    render(<IconButton label="Mute" icon={<svg />} />);
    const button = screen.getByRole('button', { name: 'Mute' });
    fireEvent.pointerEnter(button, { pointerType: 'touch' });
    fireEvent.mouseEnter(button);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    fireEvent.mouseEnter(button);
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('tooltip')).toBeTruthy();
  });

  it('grows to a 44 px target on touch screens', () => {
    render(<IconButton label="Close" icon={<svg />} size="sm" />);
    const cls = screen.getByRole('button', { name: 'Close' }).className;
    expect(cls).toContain('pointer-coarse:min-h-[calc(44rem/15)]');
    expect(cls).toContain('pointer-coarse:min-w-[calc(44rem/15)]');
    expect(buttonClass('secondary', 'md')).toContain('pointer-coarse:min-h-[calc(44rem/15)]');
  });
});

describe('Tooltip', () => {
  it('adds no wrapper and keeps the child’s own handlers and ref', () => {
    vi.useFakeTimers();
    const own = vi.fn();
    const ref = { current: null as HTMLButtonElement | null };
    const { container } = render(
      <Tooltip content="Guide" side="inline-end">
        <button ref={ref} type="button" onMouseEnter={own}>
          G
        </button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'G' });
    expect(button.parentElement).toBe(container);
    expect(ref.current).toBe(button);
    fireEvent.mouseEnter(button);
    act(() => vi.advanceTimersByTime(400));
    expect(own).toHaveBeenCalled();
    expect(screen.getByRole('tooltip').textContent).toBe('Guide');
  });

  // Inline JSX is a new element every render, which re-ran the placement effect; a new position
  // object each time re-rendered without end ("Maximum update depth exceeded").
  it('useTooltip takes content built as JSX in the caller’s render', () => {
    vi.useFakeTimers();
    function Item({ n }: { n: number }) {
      const { triggerProps, tooltip } = useTooltip({ content: <span>Item {n}</span> });
      return (
        <>
          <button type="button" {...triggerProps}>
            Open
          </button>
          {tooltip}
        </>
      );
    }
    const { rerender } = render(<Item n={1} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Open' }));
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('tooltip').textContent).toBe('Item 1');
    rerender(<Item n={2} />);
    expect(screen.getByRole('tooltip').textContent).toBe('Item 2');
  });
});

describe('overlay exits (usePresence)', () => {
  it('unmounts at once where nothing animates, so closing stays instant under reduced motion and in tests', () => {
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <Dialog open={open} onClose={() => setOpen(false)} title="Rename">
          <p>Body</p>
        </Dialog>
      );
    }
    render(<Host />);
    expect(screen.getByRole('dialog').parentElement!.dataset['state']).toBe('open');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps a toast that left in its place while it plays its exit', () => {
    const rec = (id: string): ToastRecord => ({ id, title: id, variant: 'info', createdAt: 0 });
    const shown = [rec('a'), rec('b'), rec('c')].map((t) => ({ t, leaving: false }));
    const next = mergeShownToasts(shown, [rec('a'), rec('c'), rec('d')], true);
    expect(next.map((x) => `${x.t.id}${x.leaving ? '-' : ''}`)).toEqual(['a', 'b-', 'c', 'd']);
    // No exits (reduced motion, no Web Animations): the stack is the store's.
    expect(mergeShownToasts(shown, [rec('a')], false).map((x) => x.t.id)).toEqual(['a']);
    // A toast that comes back under its id is live again.
    expect(mergeShownToasts(next, [rec('a'), rec('b')], true).map((x) => `${x.t.id}${x.leaving ? '-' : ''}`)).toEqual(['a', 'b', 'c-', 'd-']);
  });

  it('the default Menu trigger is an IconButton named and tooltipped by its label', () => {
    render(<Menu label="Channel actions" items={[{ id: 'a', label: 'Play', onSelect: () => {} }]} />);
    const trigger = screen.getByRole('button', { name: 'Channel actions' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.hasAttribute('title')).toBe(false);
  });
});

describe('LivePill and MetaLine', () => {
  it('LivePill is white on the solid live red in the dial face, with a pulsing, still or no dot', () => {
    const { container } = render(
      <>
        <LivePill />
        <LivePill dot="still" />
        <LivePill size="sm" dot="none" />
      </>,
    );
    const pills = [...container.querySelectorAll<HTMLElement>('[data-live-pill]')];
    expect(pills).toHaveLength(3);
    for (const p of pills) expect(p.className).toMatch(/bg-live-solid.*text-white|text-white.*bg-live-solid/);
    expect(pills.every((p) => p.className.includes('font-numeric'))).toBe(true);
    expect(pills[0]!.querySelector('span[aria-hidden]')!.className).toContain('animate-live-pulse');
    expect(pills[1]!.querySelector('span[aria-hidden]')!.className).not.toContain('animate-live-pulse');
    expect(pills[2]!.querySelector('span[aria-hidden]')).toBeNull();
    expect(pills[2]!.className).toContain('text-2xs');
  });

  it('MetaLine drops empty items and draws one separator that is spoken as a comma', () => {
    const { container } = render(<MetaLine items={['2021', null, '1 h 52 min', false, '', 'PG-13']} />);
    const line = container.firstElementChild as HTMLElement;
    expect(line.textContent).toBe('2021·, 1 h 52 min·, PG-13');
    expect([...line.querySelectorAll('[aria-hidden]')].map((n) => n.textContent)).toEqual(['·', '·']);
    expect(render(<MetaLine items={[null, '']} />).container.firstChild).toBeNull();
  });
});

describe('page scaffold', () => {
  it('Page pads from the shared gutter and caps the width; headers carry the heading levels', () => {
    render(
      <MemoryRouter>
        <Page width="narrow" data-testid="page">
          <PageHeader title="Downloads" count="12" actions={<button type="button">Add</button>} />
          <SectionHeader title="Recent" count={3} seeAll={{ to: '/recent' }} />
        </Page>
      </MemoryRouter>,
    );
    const page = screen.getByTestId('page');
    expect(page.className).toContain('px-(--page-gutter)');
    expect(page.className).toContain('max-w-[56rem]');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Downloads12');
    expect(screen.getByRole('heading', { level: 2 }).className).toContain('text-title-sm');
    expect(screen.getByRole('link', { name: 'See all' }).getAttribute('href')).toBe('/recent');
  });

  it('BackButton names its destination and can go back in history while showing the link', () => {
    const goBack = vi.fn();
    render(
      <MemoryRouter>
        <BackButton to="/movies" label="Movies" onClick={goBack} />
        <BackButton onClick={goBack} />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: 'Movies' });
    expect(link.getAttribute('href')).toBe('/movies');
    fireEvent.click(link);
    expect(goBack).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(goBack).toHaveBeenCalledTimes(2);
  });
});

describe('features use the kit controls (DS-DUPLICATE-CONTROLS)', () => {
  const ROOT = join(__dirname, '..', '..');
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = join(dir, e.name);
      if (e.isDirectory()) return e.name === 'test' ? [] : sources(full);
      return /\.tsx$/.test(e.name) && !/\.test\.tsx$/.test(e.name) ? [full] : [];
    });
  }
  const files = [...sources(join(ROOT, 'features')), ...sources(join(ROOT, 'shell'))];
  const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

  it('draws no switch, checkbox or radio input of its own', () => {
    const own = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return [/role="switch"/, /type="checkbox"/, /type="radio"/].filter((re) => re.test(text)).map((re) => `${rel(f)}: ${re.source}`);
    });
    expect(own).toEqual([]);
  });

  // The base focus rule for text fields (globals.css) lives in @layer base, so a field's own
  // border colour utility outranks its focus border: the fullscreen channel search showed only a
  // faint glow when focused. A hand-built field takes fieldClass, or names its focus look.
  it('a hand-built text field with its own border colour also sets a focus border or ring', () => {
    const NOT_TEXT = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'button', 'submit', 'reset', 'hidden']);
    // A resting border colour: border-<x> that is not a width, side or style (variants such as
    // hover: or aria-[…]: sit after a colon, so they do not count).
    const restingColour = /(?:^|[\s'"`])border-(?!(?:[xytbselr](?:-\d+)?|\d+|solid|dashed|dotted|double|none|hidden)(?![\w/-]))[\w/[\]().-]+/;
    const focusLook = /fieldClass\(|focus(?:-visible)?:(?:border-|ring-|outline-(?!none))/;
    const bare = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      // The opening tag, attributes included (an arrow's => does not end it).
      return [...text.matchAll(/<(input|textarea|select)\b((?:=>|[^>])*?)\/?>/gs)]
        .filter((m) => {
          const attrs = m[2]!;
          const type = /\btype=["']([\w-]+)["']/.exec(attrs)?.[1];
          return !(type && NOT_TEXT.has(type)) && restingColour.test(attrs) && !focusLook.test(attrs);
        })
        .map((m) => `${rel(f)}:${text.slice(0, m.index).split('\n').length}`);
    });
    expect(bare).toEqual([]);
  });

  it('puts no native title on an IconButton', () => {
    const titled = files.filter((f) => /<IconButton\b[^>]*?\btitle=/s.test(readFileSync(f, 'utf8')));
    // IconButtonProps has no `title` (TypeScript rejects it); this keeps a cast from sneaking one in.
    expect(titled.map(rel)).toEqual([]);
  });
});
