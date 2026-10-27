// The component kit of the SaaS polish pass (docs/architecture/design-system.md): the form
// controls every feature shares (DS-DUPLICATE-CONTROLS), tooltips instead of native titles
// (DS-TOOLTIP-UNUSED), the page scaffold, LivePill and MetaLine, overlay exits
// (DS-MOTION-EXIT) and touch sizes (DS-TOUCH-TARGETS).
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Check, House } from 'lucide-react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import {
  BackButton,
  Checkbox,
  Dialog,
  FilterChip,
  IconButton,
  Input,
  LivePill,
  Menu,
  MetaLine,
  Page,
  PageHeader,
  RadioGroup,
  SEE_ALL_LINK,
  SearchInput,
  SectionHeader,
  SegmentedControl,
  Select,
  SourceMonogram,
  Switch,
  Tabs,
  Toggle,
  Tooltip,
  buttonClass,
  fieldClass,
  useTooltip,
} from '..';
import { SWITCH_TONES } from '../Field';
import { Poster } from '../Poster';
import { TINT_THEME, hueOf, nameHue, tintFill, tintOf } from '../tint';
import { mergeShownToasts, type ToastRecord } from '../Toast';
import { TOOLTIP_CLOSE_MS } from '../Tooltip';

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
    // It stays a moment, so the pointer can reach it (WCAG 1.4.13), then goes.
    act(() => vi.advanceTimersByTime(TOOLTIP_CLOSE_MS));
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

  it('gives fields, segmented controls and pill tabs the same 44 px floor, so a touch toolbar lines up', () => {
    const floor = 'pointer-coarse:min-h-[calc(44rem/15)]';
    render(
      <>
        <Input aria-label="Name" />
        <SearchInput size="sm" value="q" onChange={() => {}} label="Filter" />
        <Select aria-label="Sort" options={[{ value: 'a', label: 'A' }]} />
        <SegmentedControl size="sm" label="View" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />
        <Tabs variant="pill" label="Kind" value="all" onChange={() => {}} items={[{ id: 'all', label: 'All' }, { id: 'movies', label: 'Movies' }]} />
        <Tabs label="Section" value="one" onChange={() => {}} items={[{ id: 'one', label: 'One' }]} />
      </>,
    );
    expect(fieldClass('sm')).toContain(floor);
    expect(screen.getByRole('textbox', { name: 'Name' }).className).toContain(floor);
    expect(screen.getByRole('searchbox', { name: 'Filter' }).className).toContain(floor);
    expect(screen.getByRole('combobox', { name: 'Sort' }).className).toContain(floor);
    // The clear button grows inside the taller field, and the text's end padding grows past it
    // (end-1 plus 36 px is 39.75 px; pe-11 is 41.25 px), so the button never covers the query.
    expect(screen.getByRole('button', { name: 'Clear search' }).className).toContain('pointer-coarse:size-[calc(36rem/15)]');
    expect(screen.getByRole('searchbox', { name: 'Filter' }).className).toContain('pointer-coarse:pe-11');
    // The track takes the floor and its segments stretch to fill it.
    expect(screen.getByRole('radiogroup', { name: 'View' }).className).toContain(floor);
    const pills = screen.getByRole('tablist', { name: 'Kind' });
    expect(pills.className).toContain(floor);
    expect(within(pills).getByRole('tab', { name: 'All' }).className).toContain('pointer-coarse:self-stretch');
    expect(within(screen.getByRole('tablist', { name: 'Section' })).getByRole('tab', { name: 'One' }).className).toContain(floor);
  });

  it('grows a filter chip to 36 px on touch and takes its target to 44 px with an invisible band', () => {
    render(
      <FilterChip pressed={false} onClick={() => {}}>
        Sports
      </FilterChip>,
    );
    const cls = screen.getByRole('button', { name: 'Sports' }).className;
    expect(cls).toContain('h-8');
    expect(cls).toContain('pointer-coarse:min-h-[calc(36rem/15)]');
    expect(cls).toContain('relative');
    expect(cls).toContain('pointer-coarse:before:-inset-y-[calc(4rem/15)]');
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

  it('Menu fills an item for keyboard focus only, and hides key hints from a finger', () => {
    render(
      <Menu
        label="Source actions"
        items={[
          { id: 'a', label: 'Refresh all', hint: 'mod+r', onSelect: () => {} },
          { id: 'b', label: 'Remove', danger: true, onSelect: () => {} },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Source actions' }));
    const [first, danger] = screen.getAllByRole('menuitem');
    // Opened by a click, the first item has focus: a plain focus fill made it look already chosen.
    for (const item of [first!, danger!]) {
      const cls = item.className.split(/\s+/);
      expect(cls.some((c) => c.startsWith('focus:bg-'))).toBe(false);
      expect(cls.some((c) => c.startsWith('focus-visible:bg-'))).toBe(true);
    }
    expect(within(first!).getByText('mod+r').className).toContain('pointer-coarse:hidden');
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
    const seeAll = screen.getByRole('link', { name: 'See all' });
    expect(seeAll.getAttribute('href')).toBe('/recent');
    // A 44 px touch target around the 19 px link, drawn by nothing. The classes are the exported
    // SEE_ALL_LINK, which a rail that builds its own heading row uses too.
    expect(seeAll.className).toBe(SEE_ALL_LINK);
    expect(SEE_ALL_LINK).toContain('relative');
    expect(SEE_ALL_LINK).toContain('pointer-coarse:after:-inset-y-[calc(12.5rem/15)]');
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

describe('Dialog sheet and header row', () => {
  const classes = () => screen.getByRole('dialog').className.split(/\s+/);

  it("`sheet` makes a bottom sheet below sm, and a caller's max-sm height cap wins over the sheet's", () => {
    const { rerender } = render(
      <Dialog open onClose={() => {}} title="Sort and filter" sheet>
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).toEqual(
      expect.arrayContaining([
        'max-sm:fixed',
        'max-sm:inset-x-0',
        'max-sm:bottom-0',
        'max-sm:rounded-b-none',
        'max-sm:max-h-[calc(100dvh-max(1.5rem,var(--toast-reserve,0px)))]',
        'max-sm:motion-safe:animate-sheet-in',
        // A narrower gutter on a phone, for the header, body and footer alike.
        'max-sm:[--dialog-gutter:1rem]',
      ]),
    );
    // The floating card's phone height cap gives way to the sheet's, not the other way round.
    expect(classes().filter((c) => c.startsWith('max-sm:max-h-'))).toEqual(['max-sm:max-h-[calc(100dvh-max(1.5rem,var(--toast-reserve,0px)))]']);
    rerender(
      <Dialog open onClose={() => {}} title="Sort and filter" sheet className="max-sm:max-h-[70dvh]">
        <p>Body</p>
      </Dialog>,
    );
    expect(classes().filter((c) => c.startsWith('max-sm:max-h-'))).toEqual(['max-sm:max-h-[70dvh]']);
  });

  it('is a sheet by default for sm, md and lg dialogs with a header row, and a card otherwise', () => {
    const { rerender } = render(
      <Dialog open onClose={() => {}} title="Rename" size="sm">
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).toContain('max-sm:fixed');
    expect(classes()).toContain('max-sm:motion-safe:animate-sheet-in');
    for (const size of ['md', 'lg'] as const) {
      rerender(
        <Dialog open onClose={() => {}} title="Rename" size={size}>
          <p>Body</p>
        </Dialog>,
      );
      expect(classes()).toContain('max-sm:fixed');
    }
    // A wide dialog, a headerless one (the command palette) and an explicit opt-out stay cards.
    rerender(
      <Dialog open onClose={() => {}} title="Trailer" size="xl">
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).not.toContain('max-sm:fixed');
    rerender(
      <Dialog open onClose={() => {}} title="Command palette" hideTitle hideClose>
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).not.toContain('max-sm:fixed');
    rerender(
      <Dialog open onClose={() => {}} title="Rename" sheet={false}>
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).not.toContain('max-sm:fixed');
    expect(classes()).toContain('motion-safe:animate-pop-in');
    rerender(
      <Dialog open onClose={() => {}} title="Details" placement="end" sheet>
        <p>Body</p>
      </Dialog>,
    );
    expect(classes()).not.toContain('max-sm:fixed');
    expect(classes()).toContain('motion-safe:animate-drawer-in');
  });

  it('draws no header row with neither a visible title nor a close button, and keeps its name and description', () => {
    render(
      <Dialog open onClose={() => {}} title="Command palette" description="Search commands and pages" hideTitle hideClose>
        <input aria-label="Query" />
      </Dialog>,
    );
    // The command palette's name and description come from the hidden title.
    const dialog = screen.getByRole('dialog', { name: 'Command palette' });
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent).toBe('Search commands and pages');
    // The body comes first: the only element before it is the visually hidden title, with no padding.
    const first = dialog.firstElementChild as HTMLElement;
    expect(first.className).toBe('sr-only');
    expect(within(first).getByRole('heading', { level: 2, name: 'Command palette' })).toBeTruthy();
    expect(dialog.querySelector('.pt-5')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });

  it('keeps the row, with its close button, when only the title is hidden', () => {
    render(
      <Dialog open onClose={() => {}} title="Rename" hideTitle>
        <p>Body</p>
      </Dialog>,
    );
    const row = screen.getByRole('dialog', { name: 'Rename' }).firstElementChild as HTMLElement;
    expect(row.className).toContain('pt-5');
    expect(within(row).getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('SourceMonogram', () => {
  it("draws the source's initials on its name's hue, hidden from screen readers, with the caller's size and testId", () => {
    render(
      <>
        <SourceMonogram name="Night Portal HD" className="size-9 rounded-md" testId="mark">
          <span data-testid="error-dot" />
        </SourceMonogram>
        <SourceMonogram name="Night Portal HD" testId="same" />
        <SourceMonogram name="Riverside" testId="other" />
      </>,
    );
    const mark = screen.getByTestId('mark');
    expect(mark.textContent).toBe('NP');
    expect(screen.getByTestId('other').textContent).toBe('RI');
    expect(mark.getAttribute('aria-hidden')).toBe('true');
    expect(mark.className).toContain('size-9');
    expect(within(mark).getByTestId('error-dot')).toBeTruthy();
    // One name, one look, wherever it is drawn; another name gets its own hue.
    expect(nameHue('Night Portal HD')).not.toBe(nameHue('Riverside'));
    expect(mark.getAttribute('style')).toBe(screen.getByTestId('same').getAttribute('style'));
    expect(mark.getAttribute('style')).not.toBe(screen.getByTestId('other').getAttribute('style'));
    // The shared tint, pale with deep ink in the light theme, as the rail's other fallbacks.
    expect(mark.style.getPropertyValue('--tint-light')).toBe(tintFill('Night Portal HD', 'light'));
    for (const c of TINT_THEME.split(' ')) expect(mark.className.split(' ')).toContain(c);
  });
});

describe('artwork fallback tint (src/ui/tint.ts)', () => {
  const tile = (props: { tint?: 'theme' | 'dark' } = {}) => {
    const { container } = render(<Poster src={undefined} alt="" label="Harbor Lights" {...props} />);
    return container.querySelector<HTMLElement>('[data-poster-fallback]')!;
  };

  it('a poster without artwork takes its title tint, pale with deep ink in the light theme', () => {
    const el = tile();
    expect(el.style.getPropertyValue('--tint-dark')).toBe(tintFill('Harbor Lights', 'dark'));
    expect(el.style.getPropertyValue('--tint-light')).toBe(tintFill('Harbor Lights', 'light'));
    expect(el.style.getPropertyValue('--tint-ink')).toBe(tintOf('Harbor Lights').ink);
    const classes = el.className.split(' ');
    expect(classes).toContain('[background-image:var(--tint-dark)]');
    expect(classes).toContain('light:not-in-data-player-stage:[background-image:var(--tint-light)]');
    expect(classes).toContain('light:not-in-data-player-stage:[color:var(--tint-ink)]');
  });

  it("keeps the deep stops inside the player's stage, which is black in every theme, except as a phone's idle bar", () => {
    const light = TINT_THEME.split(' ').filter((c) => c.startsWith('light:'));
    // Every pale class stops at the stage's edge, or applies below md only, where Live's idle stage
    // is a bar on the page surface: none of them reaches a tile on the black stage from md up.
    expect(light.length).toBeGreaterThan(0);
    for (const c of light) expect(c.startsWith('light:not-in-data-player-stage:') || c.startsWith('light:max-md:')).toBe(true);
    for (const v of ['[background-image:var(--tint-light)]', '[color:var(--tint-ink)]']) {
      expect(light).toContain(`light:not-in-data-player-stage:${v}`);
      expect(light).toContain(`light:max-md:${v}`);
    }
    // Under them, in every theme and so on the stage, the deep stops and white initials.
    expect(TINT_THEME.split(' ')).toEqual(expect.arrayContaining(['[background-image:var(--tint-dark)]', 'text-white/90']));
  });

  it('a tile on glass keeps the deep stops in every theme', () => {
    const classes = tile({ tint: 'dark' }).className;
    expect(classes).toContain('[background-image:var(--tint-dark)]');
    expect(classes).not.toContain('light:');
  });

  it('gives one name the same colour in every recipe', () => {
    expect(tintFill('US| ESPN HD')).toBe(`linear-gradient(160deg, ${tintOf('US| ESPN HD').dark[0]}, ${tintOf('US| ESPN HD').dark[1]})`);
    expect(tintOf('US| ESPN HD')).toBe(tintOf('US| ESPN HD'));
    expect(hueOf('Harbor Lights') % 12).toBe((nameHue('Harbor Lights') - 15) / 30);
  });
});

describe('type scale (DS-TYPE-SCALE)', () => {
  const globals = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
  const token = (name: string) => new RegExp(`--text-${name}:\\s*([^;]+);`).exec(globals)?.[1]?.replace(/\/\*.*?\*\//g, '').trim();

  it('draws the stock text-xs and text-sm at the scale’s caption and body-sm sizes', () => {
    expect(token('caption')).toBe('calc(12rem / 15)');
    expect(token('xs')).toBe(token('caption'));
    expect(token('xs--line-height')).toBe(token('caption--line-height'));
    expect(token('body-sm')).toBe('calc(13.5rem / 15)');
    expect(token('sm')).toBe(token('body-sm'));
    expect(token('sm--line-height')).toBe(token('body-sm--line-height'));
  });
});

describe('icon stroke (DS-ICON-STROKE)', () => {
  const globals = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
  // The selector list of the rule that sets this stroke, as the browser reads it.
  const selectorFor = (stroke: string) => {
    const m = [...globals.matchAll(/([^{}]+)\{\s*stroke-width:\s*([\d.]+);\s*\}/g)].find((r) => r[2] === stroke);
    return (m?.[1] ?? '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  };
  const strokeOf = (el: Element) => (el.matches(selectorFor('1.5')) ? '1.5' : el.matches(selectorFor('1.75')) ? '1.75' : 'own');

  it('draws icons from 18 px with a lighter line, and leaves small icons, own strokes and the player alone', () => {
    const { container } = render(
      <>
        <House data-i="16" size={16} />
        <House data-i="18" size={18} />
        <House data-i="24" size={24} />
        <House data-i="32" size={32} />
        <House data-i="class-4" className="size-4" />
        <House data-i="class-5" className="size-5" />
        <Check data-i="own" size={18} strokeWidth={2.25} />
        <div data-player-host="">
          <House data-i="player" size={20} />
        </div>
      </>,
    );
    const icon = (k: string) => container.querySelector(`[data-i="${k}"]`)!;
    expect(strokeOf(icon('16'))).toBe('own');
    expect(strokeOf(icon('18'))).toBe('1.75');
    expect(strokeOf(icon('24'))).toBe('1.75');
    expect(strokeOf(icon('32'))).toBe('1.5');
    // A size class renders at its own size whatever Lucide's 24 px width attribute says.
    expect(strokeOf(icon('class-4'))).toBe('own');
    expect(strokeOf(icon('class-5'))).toBe('1.75');
    expect(strokeOf(icon('own'))).toBe('own');
    expect(strokeOf(icon('player'))).toBe('own');
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

  // Round 2: settings drew Chromium's own grey range control. A page slider is the kit Slider. The
  // level sliders over video keep their own look: the player's white `.player-range` (player.css)
  // and the multi-view wall's volume, which sits on glass in full screen.
  it('draws no range input of its own outside the level sliders over video', () => {
    const OVER_VIDEO = new Set(['features/multiview/components/WallToolbar.tsx']);
    const own = files.flatMap((f) => {
      if (OVER_VIDEO.has(rel(f))) return [];
      const text = readFileSync(f, 'utf8');
      return [...text.matchAll(/<input\b((?:=>|[^>])*?)\/?>/gs)]
        .filter((m) => /type="range"/.test(m[1]!) && !/\bplayer-range\b/.test(m[1]!))
        .map((m) => `${rel(f)}:${text.slice(0, m.index).split('\n').length}`);
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
