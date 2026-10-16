/** Review round 1 (B7): pressed states, toast stack hit-testing, error copy and codes. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import '@/i18n';
import { RpcError } from '@/api/transport';

import { Button, ErrorState, IconButton, Menu, Tabs, ToastViewport, buttonClass, toast, useToastStore } from '..';
import { BUTTON_VARIANTS } from '../Button';
import { ERROR_HINT_KEYS, ERROR_TITLE_KEYS } from '../States';
import { evictOverflow, type ToastRecord } from '../Toast';

const globalsCss = readFileSync(join(__dirname, '..', '..', 'styles', 'globals.css'), 'utf8');

afterEach(() => {
  cleanup();
  act(() => useToastStore.getState().clear());
});

const activeBg = (cls: string) => cls.split(/\s+/).filter((c) => c.startsWith('active:'));
const hoverBg = (cls: string) => cls.split(/\s+/).find((c) => c.startsWith('hover:bg-') || c.startsWith('hover:opacity-'));

describe('pressed states', () => {
  it('every button variant has a pressed style that differs from hover', () => {
    for (const [variant, cls] of Object.entries(BUTTON_VARIANTS)) {
      const pressed = activeBg(cls);
      expect(pressed.length, variant).toBeGreaterThan(0);
      expect(pressed.map((c) => c.slice('active:'.length)), variant).not.toContain(hoverBg(cls)!.slice('hover:'.length));
    }
  });

  it('Button, IconButton and buttonClass carry the pressed classes and a motion-safe push', () => {
    render(
      <>
        <Button variant="primary">Go</Button>
        <IconButton label="Close" icon={<span />} />
      </>,
    );
    const primary = screen.getByRole('button', { name: 'Go' }).className;
    expect(primary).toContain('active:bg-accent-pressed');
    expect(primary).toContain('motion-safe:active:translate-y-px');
    const icon = screen.getByRole('button', { name: 'Close' }).className;
    expect(icon).toContain('active:bg-surface-3');
    expect(icon).toContain('motion-safe:active:translate-y-px');
    expect(buttonClass('secondary')).toContain('active:bg-pressed');
    // Disabled buttons don't move.
    expect(buttonClass()).toContain('disabled:active:translate-y-0');
  });

  it('menu items press darker than their hover and focus fills', () => {
    render(<Menu label="Row actions" items={[{ id: 'a', label: 'Rename', onSelect: () => {} }]} />);
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    expect(trigger.className).toContain('active:bg-surface-3');
    fireEvent.click(trigger);
    expect(screen.getByRole('menuitem', { name: 'Rename' }).className).toContain('active:bg-pressed');
  });

  it('globals.css presses palette items and stops the push under the in-app reduced-motion switch', () => {
    expect(globalsCss).toMatch(/\[cmdk-item\]\[data-selected='true'\]:active\s*\{\s*background:\s*var\(--color-pressed\)/);
    expect(globalsCss).toMatch(/html\[data-reduced-motion='true'\] \*:active\s*\{[^}]*translate:\s*none !important/);
  });
});

describe('toast stack', () => {
  it('lets clicks through the empty viewport, keeps toasts clickable, and caps the stack', () => {
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'Saved' });
    });
    const list = document.querySelector<HTMLOListElement>('[data-toast-list]')!;
    expect(list.className).toContain('pointer-events-none');
    // Half the window, less any room kept clear above the mini player (L3-desktop-4).
    expect(list.className).toContain('max-h-[min(50vh,calc(100vh_-_var(--toast-clear,0px)_-_2rem))]');
    expect(list.className).toContain('overflow-y-auto');
    const item = within(list).getAllByRole('listitem')[0]!;
    expect(item.className).toContain('pointer-events-auto');
    let el: HTMLElement | null = list.parentElement;
    while (el && !el.className.includes('pointer-events-none')) el = el.parentElement;
    expect(el, 'viewport is pointer-events-none').not.toBeNull();
  });
});

describe('error state', () => {
  it('maps every RpcErrorCode, including engine_missing and server', () => {
    for (const code of ['engine_missing', 'server'] as const) {
      render(<ErrorState error={new RpcError(code, 'x')} />);
      const alert = screen.getByRole('alert');
      expect(alert.textContent).not.toContain(ERROR_TITLE_KEYS[code]);
      expect(alert.textContent).not.toContain(ERROR_HINT_KEYS[code]);
      cleanup();
    }
    render(<ErrorState error={new RpcError('engine_missing', 'x')} />);
    expect(screen.getByText('The video player engine (mpv) is missing or could not start.')).toBeTruthy();
    cleanup();
    render(<ErrorState error={new RpcError('server', 'x')} />);
    expect(screen.getByText('The server is busy or having trouble. Try again later.')).toBeTruthy();
  });

  it('uses one "Couldn\'t ..." / "Try again" voice and takes a caller hint', () => {
    render(<ErrorState error={new RpcError('network', 'down')} hint="Local hint" onRetry={() => {}} />);
    expect(screen.getByRole('heading', { name: "Couldn't reach the server" })).toBeTruthy();
    expect(screen.getByText('Local hint')).toBeTruthy();
    expect(screen.queryByText(/provider URL/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('offers no Try again for not_found and its hint does not ask for a refresh', () => {
    render(<ErrorState error={new RpcError('not_found', 'gone')} onRetry={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    const hint = screen.getByText('It may have been removed, or this link is out of date.');
    expect(hint.textContent).not.toMatch(/refresh|reload|try again/i);
  });

  it('keeps the unreachable-server hint over a caller hint', () => {
    render(<ErrorState error={new RpcError('network', 'Failed to fetch', true, { transport: 'unreachable' })} hint="Local hint" />);
    expect(screen.queryByText('Local hint')).toBeNull();
    expect(screen.getByText(/server is still running/)).toBeTruthy();
  });
});

describe('review round 2', () => {
  const rec = (id: string, over: Partial<ToastRecord> = {}): ToastRecord => ({ id, title: id, variant: 'info', createdAt: 0, ...over });

  it('toasts never shrink inside the capped list', () => {
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'Saved' });
    });
    const li = within(document.querySelector<HTMLElement>('[data-toast-list]')!).getAllByRole('listitem')[0]!;
    expect(li.className).toContain('shrink-0');
  });

  it('a new toast scrolls the list to the bottom; an update to a showing toast does not', () => {
    render(<ToastViewport />);
    const list = document.querySelector<HTMLElement>('[data-toast-list]')!;
    Object.defineProperty(list, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 0, writable: true, configurable: true });
    act(() => {
      toast({ id: 'p', title: 'Importing', duration: 0 });
    });
    expect(list.scrollTop).toBe(900);
    list.scrollTop = 120; // the user scrolled up to read an older toast
    act(() => {
      toast({ id: 'p', title: 'Importing', description: '40%', duration: 0 });
    });
    expect(list.scrollTop).toBe(120);
    act(() => {
      toast({ title: 'Saved' });
    });
    expect(list.scrollTop).toBe(900);
  });

  it('never evicts a toast with an action; older plain toasts go first', () => {
    const undo = rec('undo', { action: { label: 'Undo', onClick: () => {} } });
    const list = [undo, rec('a'), rec('b'), rec('c'), rec('d'), rec('e')];
    expect(evictOverflow(list).map((t) => t.id)).toEqual(['undo', 'b', 'c', 'd', 'e']);
    const allUndo = ['u1', 'u2', 'u3', 'u4', 'u5'].map((id) => rec(id, { action: { label: 'Undo', onClick: () => {} } }));
    // Only actions and the newest left: the stack goes over the cap (the list scrolls).
    expect(evictOverflow([...allUndo, rec('new')]).map((t) => t.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'new']);
  });

  it('the toast action button and unselected pill tabs have pressed fills', () => {
    render(
      <>
        <ToastViewport />
        <Tabs
          variant="pill"
          label="View"
          value="a"
          onChange={() => {}}
          items={[
            { id: 'a', label: 'Grid' },
            { id: 'b', label: 'List' },
          ]}
        />
      </>,
    );
    act(() => {
      toast({ title: 'Removed', action: { label: 'Undo', onClick: () => {} } });
    });
    expect(screen.getByRole('button', { name: 'Undo' }).className).toContain('active:bg-pressed');
    const list = screen.getByRole('tab', { name: 'List' });
    expect(list.className).toContain('active:bg-surface-3');
    // The pill tablist itself is bg-surface-2, so a surface-2 press would not show.
    expect(list.className).not.toContain('active:bg-surface-2');
  });
});

describe('review round 3', () => {
  it('the toast list leaves room for card shadows and fades its top edge only while scrolled', () => {
    render(<ToastViewport />);
    act(() => {
      toast({ title: 'Saved' });
    });
    const list = document.querySelector<HTMLElement>('[data-toast-list]')!;
    // Padding inside the scroll clip, offset by a negative margin so the stack stays put.
    for (const c of ['-mx-6', 'px-6', '-mt-6', 'pt-6', '-mb-4', 'pb-4']) expect(list.className.split(/\s+/)).toContain(c);
    expect(list.className).toMatch(/data-\[scrolled\]:\[mask-image:linear-gradient\(to_bottom,transparent,/);
    expect(list.hasAttribute('data-scrolled')).toBe(false);
    Object.defineProperty(list, 'scrollTop', { value: 40, writable: true, configurable: true });
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-scrolled')).toBe(true);
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(list.hasAttribute('data-scrolled')).toBe(false);
    // Static fade: no transition that reduced motion would have to switch off.
    expect(list.className).not.toMatch(/transition/);
  });
});
