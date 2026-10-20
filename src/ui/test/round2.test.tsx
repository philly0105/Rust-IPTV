// Review round 2 of the redesign, kit side: progress semantics and glass bars on artwork, one
// watched mark, MetaLine wrapping, the dialog close button on the title line, hover tooltips that
// close on Escape from anywhere, the Slider, FilterChip and segmented controls with reasons.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type { Episode, PlaybackPosition, WatchlistEntry } from '@/api/types';

vi.mock('@/api/transport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/transport')>()),
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const { Dialog, FilterChip, IconButton, MetaLine, ProgressBar, SegmentedControl, Slider, Tooltip, WatchedChip } = await import('..');
const { PosterCard } = await import('@/features/vod/components/PosterCard');
const { EpisodeList } = await import('@/features/vod/components/detail/EpisodeList');
const { UpNextRail } = await import('@/features/vod/components/detail/UpNext');
const { MyListCard } = await import('@/features/mylist/components/MyListCard');

const STYLES = join(__dirname, '..', '..', 'styles');

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // jsdom has no layout: a desktop-sized box lets the episode virtualizer render its rows.
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  Element.prototype.scrollTo ??= function scrollTo() {};
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const bars = (root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>('[role="progressbar"]')];
const fill = (bar: HTMLElement) => bar.firstElementChild as HTMLElement;

describe('ProgressBar', () => {
  it('reports a percentage whatever max is, so a fraction does not read as 0 or 1 of 1', () => {
    render(
      <>
        <ProgressBar value={0.63} max={1} label="S02E04" valueText="16 minutes left" />
        <ProgressBar value={0.42} max={1} label="Poster" />
        <ProgressBar value={40} label="Import" />
      </>,
    );
    const [hero, poster, plain] = screen.getAllByRole('progressbar');
    expect(hero!.getAttribute('aria-valuenow')).toBe('63');
    expect(hero!.getAttribute('aria-valuemax')).toBe('100');
    expect(hero!.getAttribute('aria-valuemin')).toBe('0');
    expect(hero!.getAttribute('aria-valuetext')).toBe('16 minutes left');
    expect(poster!.getAttribute('aria-valuenow')).toBe('42');
    expect(plain!.getAttribute('aria-valuenow')).toBe('40');
    expect(fill(hero!).style.width).toBe('63%');
  });

  it('a decorative bar is hidden from assistive tech; the default fill is the mark tone, not the text tone', () => {
    const { container } = render(<ProgressBar value={0.5} max={1} decorative />);
    const bar = bars(container)[0]!;
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(fill(bar).className.split(' ')).toContain('bg-accent-mark');
    expect(fill(bar).className.split(' ')).not.toContain('bg-accent');
  });
});

describe('bars on artwork are glass in every theme (round 2: light posters drew a white track and a brown fill)', () => {
  const position = (id: string, positionSeconds: number, watched = false): [string, PlaybackPosition] => [
    id,
    { ref: { sourceId: 's1', contentType: 'series', itemId: 'show' }, episodeId: id, positionSeconds, durationSeconds: 1000, updatedAt: '2026-10-10T00:00:00Z', watched },
  ];
  const episode = (n: number): Episode => ({
    id: `e${n}`,
    seriesRef: { sourceId: 's1', contentType: 'series', itemId: 'show' },
    season: 1,
    episode: n,
    title: `Episode ${n}`,
    durationSeconds: 1000,
  });

  it('a poster card: glass bar on a glass band, drawn only (the link says how far)', () => {
    wrap(<PosterCard title="Halfway" href="/b" progress={0.4} />);
    const link = screen.getByRole('link', { name: /^Halfway/ });
    expect(link.getAttribute('aria-label')).toMatch(/40%/);
    const bar = bars(link)[0]!;
    expect(fill(bar).className).toContain('bg-glass-accent');
    expect(bar.className).toContain('bg-on-glass/20');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    // The band under it is glass too, not the theme's scrim (lighter in light).
    expect(bar.parentElement!.className).toContain('bg-glass/60');
    expect(bar.parentElement!.className).not.toContain('bg-scrim');
  });

  it('a My List card: glass bar, and the watched mark is the kit chip in the top-end corner', () => {
    const entry = (watched: boolean): WatchlistEntry => ({
      ref: { sourceId: 's1', contentType: 'movie', itemId: watched ? 'm2' : 'm1' },
      snapshot: { title: watched ? 'Heat' : 'Arrival', contentType: 'movie' },
      addedAt: '2026-10-01T00:00:00Z',
      watched,
    }) as WatchlistEntry;
    render(
      <>
        <MyListCard entry={entry(false)} busy={false} progress={0.25} progressLabel="90 minutes left" onRemove={() => {}} />
        <MyListCard entry={entry(true)} busy={false} onRemove={() => {}} />
      </>,
    );
    const [arrival, heat] = screen.getAllByTestId('mylist-card');
    expect(fill(bars(arrival)[0]!).className).toContain('bg-glass-accent');
    const chip = within(heat!).getByTestId('mylist-watched');
    expect(chip.getAttribute('aria-hidden')).toBe('true');
    expect(chip.className).toContain('rounded-full');
    expect(chip.className).toContain('bg-glass-strong');
    expect(chip.className).toContain('end-1.5');
    expect(chip.textContent).toBe('');
  });

  it('episode thumbnails: a glass bar while in progress, the watched chip and no bar once watched', async () => {
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const [, setMounted] = useState(false);
      useEffect(() => setMounted(true), []);
      return (
        <div ref={scrollRef}>
          <EpisodeList
            episodes={[episode(1), episode(2)]}
            positions={new Map([position('e1', 400), position('e2', 1000, true)])}
            downloads={new Map()}
            onPlay={() => undefined}
            canDownload={false}
            pendingDownload={null}
            onDownload={() => undefined}
            scrollRef={scrollRef}
          />
        </div>
      );
    }
    wrap(<Harness />);
    const [inProgress, watched] = await screen.findAllByTestId('episode-thumb');
    const bar = bars(inProgress)[0]!;
    expect(fill(bar).className).toContain('bg-glass-accent');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
    // A finished episode carried a full-width progress bar in the progress colour.
    expect(bars(watched)).toHaveLength(0);
    expect(watched!.querySelector('.bg-glass-strong.rounded-full')).not.toBeNull();
  });

  it('Up next thumbnails: a glass bar, drawn only', () => {
    wrap(<UpNextRail episodes={[episode(3)]} positions={new Map([position('e3', 300)])} onPlay={() => {}} />);
    const bar = bars()[0]!;
    expect(fill(bar).className).toContain('bg-glass-accent');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('WatchedChip', () => {
  it('is a small round glass tick, hidden from assistive tech, never amber', () => {
    render(<WatchedChip testId="w" className="absolute" />);
    const chip = screen.getByTestId('w');
    expect(chip.getAttribute('aria-hidden')).toBe('true');
    expect(chip.className).toMatch(/size-5/);
    expect(chip.className).toContain('text-on-glass');
    expect(chip.className).not.toMatch(/accent/);
    expect(chip.querySelector('svg')).not.toBeNull();
  });
});

describe('MetaLine wrapping (round 2: a separator stranded at the end of a line)', () => {
  it('keeps each separator in one unit with the item after it', () => {
    const { container } = render(<MetaLine items={['2024', '2h 14m', 'Thriller', 'MKV']} />);
    const line = container.firstElementChild as HTMLElement;
    const units = [...line.children] as HTMLElement[];
    expect(units).toHaveLength(4);
    expect(units[0]!.textContent).toBe('2024');
    for (const [i, unit] of units.slice(1).entries()) {
      // The dot, its spoken comma and the item share one flex unit, so a wrap moves all three.
      expect(unit.className).toContain('inline-flex');
      expect(unit.firstElementChild!.getAttribute('aria-hidden')).toBe('true');
      expect(unit.firstElementChild!.textContent).toBe('·');
      expect(unit.textContent).toBe(`·, ${['2h 14m', 'Thriller', 'MKV'][i]}`);
    }
  });
});

describe('Dialog header (round 2: the close button sat 8 px below the title and set the row height)', () => {
  it('puts the close button in a box one title line tall, so it centres on the title', () => {
    render(
      <Dialog open onClose={() => {}} title="What's new">
        <p>Body</p>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    const box = close.parentElement!;
    expect(box.hasAttribute('data-dialog-close-box')).toBe(true);
    expect(box.className.split(' ')).toEqual(expect.arrayContaining(['flex', 'h-[calc(24rem/15)]', 'items-center', 'shrink-0']));
    // The same line height as the title, so the two centre on each other.
    const css = readFileSync(join(STYLES, 'globals.css'), 'utf8');
    expect(css).toMatch(/--text-title-sm--line-height:\s*calc\(24rem \/ 15\)/);
    expect(screen.getByRole('heading', { name: "What's new" }).className).toContain('text-title-sm');
  });

  it('a drawer keeps its close button at the end of its header bar', () => {
    render(
      <Dialog open onClose={() => {}} title="Filters" placement="end">
        <p>Body</p>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close.parentElement!.hasAttribute('data-dialog-close-box')).toBe(false);
    expect(close.className).toContain('ms-auto');
  });
});

describe('a hover tooltip closes on Escape wherever focus is (WCAG 1.4.13)', () => {
  it('hides on the first Escape with focus on the page, and leaves Back to the next press', async () => {
    const back = vi.fn();
    // Like useEscapeBack: a document listener that goes back on an unclaimed Escape.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) back();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<IconButton label="Save to My List" icon={<svg />} />);
      const btn = screen.getByRole('button', { name: 'Save to My List' });
      fireEvent.mouseEnter(btn);
      expect(await screen.findByRole('tooltip', {}, { timeout: 2000 })).toBeTruthy();
      expect(document.activeElement).toBe(document.body);
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(back).not.toHaveBeenCalled();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(back).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  it('with focus in a field of a dialog, Escape hides the hovered tooltip first and the dialog stays', async () => {
    let closed = 0;
    render(
      <Dialog open onClose={() => closed++} title="Edit">
        <input aria-label="Name" />
        <Tooltip content="Explains the field" delay={0}>
          <button type="button">Help</button>
        </Tooltip>
      </Dialog>,
    );
    const field = screen.getByRole('textbox', { name: 'Name' });
    act(() => field.focus());
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Help' }));
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(closed).toBe(0);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('stops listening once the tooltip is gone', async () => {
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      render(
        <Tooltip content="Tip" delay={0}>
          <button type="button">Trigger</button>
        </Tooltip>,
      );
      const btn = screen.getByRole('button', { name: 'Trigger' });
      fireEvent.mouseEnter(btn);
      await act(() => new Promise((r) => setTimeout(r, 10)));
      fireEvent.mouseLeave(btn);
      expect(screen.queryByRole('tooltip')).toBeNull();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onWindow).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });
});

describe('Slider', () => {
  it('is a named native range with the kit look, a fill that follows the value, and numbers out', () => {
    const onValueChange = vi.fn();
    render(<Slider aria-label="Minimum rating" min={0} max={10} step={0.5} value={6.5} onValueChange={onValueChange} aria-valuetext="6.5 stars" />);
    const slider = screen.getByRole('slider', { name: 'Minimum rating' }) as HTMLInputElement;
    expect(slider.type).toBe('range');
    expect(slider.className.split(' ')).toContain('slider');
    expect(slider.style.getPropertyValue('--slider-fill')).toBe('65%');
    expect(slider.getAttribute('aria-valuetext')).toBe('6.5 stars');
    fireEvent.change(slider, { target: { value: '7' } });
    expect(onValueChange).toHaveBeenCalledWith(7);
  });

  it('draws its fill in the mark tone, flips it for RTL, and gives the thumb a 3:1 outline', () => {
    const css = readFileSync(join(STYLES, 'globals.css'), 'utf8');
    const block = /@utility slider \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    expect(block).not.toBe('');
    expect(block).toMatch(/appearance:\s*none/);
    expect(block).toMatch(/linear-gradient\(to var\(--slider-to\), var\(--color-accent-mark\) var\(--slider-fill/);
    expect(block).toMatch(/:dir\(rtl\)\)\s*\{\s*--slider-to:\s*left/);
    // The unfilled track has the control border; the thumb, the mark outline and a surface ring.
    expect(block).toMatch(/linear-gradient\(var\(--color-border\), var\(--color-border\)\) border-box/);
    expect(block).toMatch(/-webkit-slider-thumb \{[^}]*border: 2px solid var\(--color-accent-mark\)/);
    expect(block).toMatch(/-moz-range-thumb \{[^}]*border: 2px solid var\(--color-accent-mark\)/);
    // A 1rem thumb: the Appearance UI scale ticks place themselves for it.
    expect(block).toMatch(/--slider-thumb:\s*1rem/);
  });
});

describe('FilterChip', () => {
  it('is a toggle button; on is inverted, never amber; dot and count are optional', () => {
    const onClick = vi.fn();
    render(
      <div role="group" aria-label="Genres">
        <FilterChip pressed={false} dot="#47bd80" onClick={onClick}>
          Sports
        </FilterChip>
        <FilterChip pressed count="30+">
          News
        </FilterChip>
      </div>,
    );
    const off = screen.getByRole('button', { name: 'Sports' });
    const on = screen.getByRole('button', { name: /News\s*30\+/ });
    expect(off.getAttribute('aria-pressed')).toBe('false');
    expect(on.getAttribute('aria-pressed')).toBe('true');
    expect(on.className).toMatch(/\bbg-fg\b/);
    expect(on.className).toMatch(/\btext-bg\b/);
    for (const chip of [off, on]) {
      expect(chip.className).not.toMatch(/accent/);
      expect(chip.className).toContain('rounded-full');
      expect(chip.className).toContain('h-7');
    }
    expect(off.className).toContain('bg-surface-2');
    expect((off.querySelector('span[aria-hidden]') as HTMLElement).style.background).toBe('rgb(71, 189, 128)');
    fireEvent.click(off);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('SegmentedControl: compact size and segments that say why they are out', () => {
  const options = [
    { value: 'a', label: 'Side by side', content: <span aria-hidden>A</span>, disabledReason: 'Holds two channels. Close a tile first.', testId: 'seg-a' },
    { value: 'b', label: 'Grid', content: <span aria-hidden>B</span>, testId: 'seg-b' },
    { value: 'c', label: 'Spotlight', content: <span aria-hidden>C</span>, testId: 'seg-c' },
  ];

  it('keeps an out-of-use segment focusable with its reason as description and tooltip, and never chooses it', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Layout" value="b" onChange={onChange} options={options} size="sm" />);
    const side = screen.getByTestId('seg-a');
    expect(side.getAttribute('aria-disabled')).toBe('true');
    expect(side.hasAttribute('disabled')).toBe(false);
    expect(document.getElementById(side.getAttribute('aria-describedby')!)!.textContent).toBe('Holds two channels. Close a tile first.');
    fireEvent.click(side);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.mouseEnter(side);
    const tip = await screen.findByRole('tooltip', {}, { timeout: 2000 });
    expect(tip.textContent).toContain('Side by side');
    expect(tip.textContent).toContain('Holds two channels');
    // The arrows stop on it (so its reason is heard) without choosing it, and go on from there.
    const grid = screen.getByRole('radio', { name: 'Grid' });
    fireEvent.keyDown(grid, { key: 'ArrowLeft' });
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(side);
    fireEvent.keyDown(side, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('c');
  });

  it('the compact size tightens the track and the segments', () => {
    render(<SegmentedControl label="View" value="b" onChange={() => {}} options={options.slice(1)} size="sm" testId="view" />);
    expect(screen.getByTestId('view').className.split(' ')).toEqual(expect.arrayContaining(['p-0.5', 'gap-0.5', 'rounded-md', 'border-edge']));
    expect(screen.getByRole('radio', { name: 'Grid' }).className.split(' ')).toEqual(expect.arrayContaining(['min-h-7', 'px-2', 'rounded-sm', 'bg-raised']));
  });
});
