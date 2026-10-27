import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { Dialog, ErrorState, Kbd, Menu, Tooltip, ToastViewport, toast, useToastStore, type ToastRecord } from '..';
import { evictOverflow } from '../Toast';
import { placeTooltip } from '../Tooltip';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useToastStore.setState({ toasts: [] });
});

describe('Kbd', () => {
  it('speaks the combo through hidden text, not a prohibited aria-label on a span', () => {
    const { container } = render(<Kbd combo="mod+shift+l" />);
    const wrap = container.firstElementChild as HTMLElement;
    expect(wrap.hasAttribute('aria-label')).toBe(false);
    expect(wrap.querySelector('.sr-only')?.textContent).toBe('Ctrl + Shift + L');
    expect([...wrap.querySelectorAll('kbd')].every((k) => k.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('comes in a compact size for caps inside a 30 px control, keeping the lip', () => {
    const { container } = render(
      <>
        <Kbd combo="mod+k" />
        <Kbd combo="mod+k" size="sm" />
      </>,
    );
    const [md, sm] = [...container.children].map((w) => w.querySelector('kbd')!.className.split(' '));
    expect(md).toEqual(expect.arrayContaining(['h-6', 'min-w-6', 'text-xs', 'border-b-2']));
    expect(sm).toEqual(expect.arrayContaining(['h-5', 'min-w-5', 'text-2xs', 'border-b-2']));
    expect(sm).not.toContain('h-6');
  });
});

describe('placeTooltip', () => {
  const vp = { width: 1000, height: 800 };
  const anchor = (left: number, top: number, w = 40, h = 40) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });

  it('centres above the anchor when there is room', () => {
    expect(placeTooltip(anchor(480, 400), { width: 80, height: 24 }, 'top', vp)).toEqual({ left: 460, top: 368, side: 'top' });
  });
  it('flips below when a top tooltip would leave the viewport (header buttons)', () => {
    const p = placeTooltip(anchor(480, 10), { width: 80, height: 24 }, 'top', vp);
    expect(p.side).toBe('bottom');
    expect(p.top).toBe(58);
  });
  it('clamps along the cross axis at the screen edge', () => {
    const p = placeTooltip(anchor(980, 400, 20), { width: 120, height: 24 }, 'top', vp);
    expect(p.left).toBe(1000 - 120 - 8);
    const q = placeTooltip(anchor(0, 400, 20), { width: 120, height: 24 }, 'bottom', vp);
    expect(q.left).toBe(8);
  });
  it('flips a right tooltip to the left near the inline-end edge', () => {
    expect(placeTooltip(anchor(950, 400), { width: 100, height: 24 }, 'right', vp).side).toBe('left');
  });
});

describe('Tooltip', () => {
  it('shows after the delay, hides on pointer press, then warms up the next one', () => {
    vi.useFakeTimers();
    render(
      <>
        <Tooltip content="First tip">
          <button type="button">one</button>
        </Tooltip>
        <Tooltip content="Second tip">
          <button type="button">two</button>
        </Tooltip>
      </>,
    );
    // No wrapper: the handlers sit on the trigger itself, so it keeps its place in the layout.
    const one = screen.getByText('one');
    expect(one.parentElement?.tagName).not.toBe('SPAN');
    fireEvent.mouseEnter(one);
    expect(screen.queryByRole('tooltip')).toBeNull();
    act(() => vi.advanceTimersByTime(400));
    expect(screen.getByRole('tooltip').textContent).toBe('First tip');
    expect(screen.getByText('one').getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    fireEvent.pointerDown(one);
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Within the warm window the next tooltip shows with no delay.
    fireEvent.mouseEnter(screen.getByText('two'));
    expect(screen.getByRole('tooltip').textContent).toBe('Second tip');
  });

  it('hides when the page scrolls', () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Tip" delay={0}>
        <button type="button">btn</button>
      </Tooltip>,
    );
    fireEvent.mouseEnter(screen.getByText('btn'));
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('tooltip')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});

describe('Toast stack', () => {
  const rec = (id: string, duration?: number): ToastRecord => ({ id, title: id, variant: 'info', createdAt: 0, duration });

  it('evicts the oldest short-lived toast before a persistent one', () => {
    const list = [rec('progress', 0), rec('a'), rec('b'), rec('c'), rec('d'), rec('e')];
    expect(evictOverflow(list).map((t) => t.id)).toEqual(['progress', 'b', 'c', 'd', 'e']);
  });
  it('falls back to the oldest when every toast is persistent', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => rec(id, 0));
    expect(evictOverflow(list).map((t) => t.id)).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('pauses every toast while the pointer is over the stack', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'first' });
      toast({ title: 'second' });
    });
    const list = document.querySelector('[data-toast-viewport] ol')!;
    fireEvent.mouseEnter(list);
    act(() => vi.advanceTimersByTime(20_000));
    expect(useToastStore.getState().toasts).toHaveLength(2);
    fireEvent.mouseLeave(list);
    act(() => vi.advanceTimersByTime(5_000));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('still auto-dismisses when nothing hovers it', () => {
    vi.useFakeTimers();
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'solo' });
    });
    act(() => vi.advanceTimersByTime(5_000));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('design tokens', () => {
  const css = readFileSync(join(__dirname, '..', '..', 'styles', 'tokens.css'), 'utf8');
  const globals = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');
  const block = (sel: RegExp) => {
    const m = sel.exec(css);
    const out: Record<string, string> = {};
    for (const x of (m?.[1] ?? '').matchAll(/--color-([\w-]+):\s*(#[0-9a-f]{6})/gi)) out[x[1]!] = x[2]!;
    return out;
  };
  const lum = (h: string) => {
    const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const themes = {
    dark: block(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/),
    light: block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/),
  };

  for (const [name, c] of Object.entries(themes)) {
    it(`${name}: every text colour meets AA on every surface`, () => {
      expect(Object.keys(c).length).toBeGreaterThan(10);
      for (const fg of ['fg', 'fg-muted', 'fg-subtle', 'accent', 'danger', 'success', 'warning', 'live']) {
        for (const bg of ['bg', 'surface', 'surface-2', 'surface-3']) {
          expect(ratio(c[fg]!, c[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
      expect(ratio(c['accent-fg']!, c['accent']!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c['accent-fg']!, c['accent-hover']!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(c['focus']!, c['bg']!)).toBeGreaterThanOrEqual(3);
    });
  }

  it('the Tailwind @theme defaults mirror the dark tokens', () => {
    for (const [k, v] of Object.entries(themes.dark)) {
      const m = new RegExp(`--color-${k}:\\s*(#[0-9a-f]{6})`, 'i').exec(globals.split('@layer base')[0]!);
      if (m) expect(m[1]!.toLowerCase(), k).toBe(v.toLowerCase());
    }
  });

  it('reduced motion stops animations, transitions, and their delays', () => {
    const media = /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/.exec(globals)?.[1] ?? '';
    for (const rule of ['animation-duration', 'animation-delay', 'transition-duration', 'transition-delay', 'scroll-behavior']) {
      expect(media, rule).toContain(rule);
      expect(globals, rule).toMatch(new RegExp(`html\\[data-reduced-motion='true'\\][\\s\\S]*${rule}`));
    }
  });
});

describe('hit targets and retry feedback', () => {
  it('toast dismiss is a 32 px target', () => {
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'sized', action: { label: 'Undo', onClick: () => {} } });
    });
    const dismiss = document.querySelector('[data-toast-dismiss]')!;
    expect(dismiss.className).toContain('h-8');
    expect(dismiss.className).toContain('w-8');
    expect(screen.getByRole('button', { name: 'Undo' }).className).toContain('min-h-8');
  });

  it('ErrorState shows a busy Retry while retrying and ignores presses', () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState error={new Error('nope')} onRetry={onRetry} retrying />);
    const btn = screen.getByRole('button', { name: 'Try again' });
    expect(btn.getAttribute('aria-busy')).toBe('true');
    fireEvent.click(btn);
    expect(onRetry).not.toHaveBeenCalled();
    rerender(<ErrorState error={new Error('nope')} onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe('Dialog focus restore', () => {
  it('lands on #main when the element that opened it is gone', () => {
    function Harness({ open, opener }: { open: boolean; opener: boolean }) {
      return (
        <div>
          <main id="main" tabIndex={-1}>
            {opener && <button type="button">opener</button>}
          </main>
          <Dialog open={open} onClose={() => {}} title="Edit">
            <button type="button">inside</button>
          </Dialog>
        </div>
      );
    }
    const { rerender } = render(<Harness open={false} opener />);
    screen.getByText('opener').focus();
    rerender(<Harness open opener />);
    expect(document.activeElement?.textContent).toBe('inside');
    rerender(<Harness open opener={false} />);
    rerender(<Harness open={false} opener={false} />);
    expect(document.activeElement?.id).toBe('main');
  });

  it('returns focus to a still-mounted opener', () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <>
          <button type="button">opener</button>
          <Dialog open={open} onClose={() => {}} title="Edit">
            <button type="button">inside</button>
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<Harness open={false} />);
    screen.getByText('opener').focus();
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    expect(document.activeElement?.textContent).toBe('opener');
  });

  it('lands on #main when the opener is still there but became disabled', () => {
    function Harness({ open, disabled }: { open: boolean; disabled: boolean }) {
      return (
        <main id="main" tabIndex={-1}>
          <button type="button" disabled={disabled}>
            opener
          </button>
          <Dialog open={open} onClose={() => {}} title="Clear">
            <button type="button">inside</button>
          </Dialog>
        </main>
      );
    }
    const { rerender } = render(<Harness open={false} disabled={false} />);
    screen.getByText('opener').focus();
    rerender(<Harness open disabled={false} />);
    // Clearing empties the list, so the opener turns disabled as the dialog closes.
    rerender(<Harness open={false} disabled />);
    expect(document.activeElement?.id).toBe('main');
  });

  it('leaves focus on <body> when the dialog opened from it (startup dialogs)', () => {
    function Harness({ open }: { open: boolean }) {
      return (
        <main id="main" tabIndex={-1}>
          <Dialog open={open} onClose={() => {}} title="Welcome">
            <button type="button">inside</button>
          </Dialog>
        </main>
      );
    }
    (document.activeElement as HTMLElement | null)?.blur();
    const { rerender } = render(<Harness open={false} />);
    expect(document.activeElement).toBe(document.body);
    rerender(<Harness open />);
    rerender(<Harness open={false} />);
    expect(document.activeElement).toBe(document.body);
  });
});

describe('Dialog body', () => {
  it('draws no body band for a confirm with only a description and a footer', () => {
    render(
      <Dialog open onClose={() => {}} title="Clear?" description="This removes everything." footer={<button type="button">Clear</button>} testId="d" />,
    );
    const panel = screen.getByTestId('d');
    expect(panel.children).toHaveLength(2);
    expect(panel.querySelector('.pb-6')).toBeNull();
    expect(panel.lastElementChild!.textContent).toBe('Clear');
  });

  it('keeps the body for content, including a 0', () => {
    const { rerender } = render(
      <Dialog open onClose={() => {}} title="Edit" footer={<button type="button">Save</button>} testId="d">
        <p>Fields</p>
      </Dialog>,
    );
    expect(screen.getByTestId('d').children).toHaveLength(3);
    rerender(
      <Dialog open onClose={() => {}} title="Count" testId="d">
        {0}
      </Dialog>,
    );
    expect(screen.getByTestId('d').children).toHaveLength(2);
    expect(screen.getByTestId('d').lastElementChild!.textContent).toBe('0');
  });
});

describe('Menu focus', () => {
  it('menu items draw a focus ring for keyboard focus, not just a faint background', () => {
    render(<Menu label="Actions" items={[{ id: 'a', label: 'Alpha', onSelect: () => {} }]} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Actions' }), { key: 'ArrowDown' });
    const item = screen.getByRole('menuitem', { name: 'Alpha' });
    expect(document.activeElement).toBe(item);
    for (const c of ['focus-visible:ring-2', 'focus-visible:ring-inset', 'focus-visible:ring-focus']) expect(item.className).toContain(c);
  });
});

describe('tokens.css header', () => {
  it('states the border contract that contrast.test.ts enforces', () => {
    const head = readFileSync(join(__dirname, '..', '..', 'styles', 'tokens.css'), 'utf8').split(':root')[0]!;
    expect(head).toMatch(/--color-border marks the edge of a component/);
    expect(head).toMatch(/reaches 3:1/);
    expect(head).toMatch(/contrast\.test\.ts/);
  });
});
