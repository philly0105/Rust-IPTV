import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { RpcError } from '@/api/transport';

import { Dialog, ErrorState, IconButton, Menu, Tabs, ToastViewport, Tooltip, comboKeys, toast, useToastStore } from '..';
import { placeMenu } from '../Menu';
import { toastsToAnnounce, type ToastRecord } from '../Toast';

afterEach(() => {
  cleanup();
  act(() => useToastStore.getState().clear());
});

const rec = (id: string, title: string, variant: ToastRecord['variant'] = 'info'): ToastRecord => ({ id, title, variant, createdAt: 0 });

describe('toast announcements', () => {
  it('announces new toasts and retitled ones, not progress ticks', () => {
    const prev = new Map<string, unknown>([
      ['a', 'Importing'],
      ['b', 'Downloading'],
    ]);
    const next = [rec('a', 'Imported'), { ...rec('b', 'Downloading'), description: '40%' }, rec('c', 'Saved')];
    expect(toastsToAnnounce(prev as Map<string, string>, next).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('keeps the list a plain list and speaks through persistent live regions', () => {
    render(<ToastViewport />);
    const polite = document.querySelector('[data-toast-live="polite"]')!;
    const assertive = document.querySelector('[data-toast-live="assertive"]')!;
    // The regions exist before any toast, so the first message is not lost.
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(assertive.getAttribute('aria-live')).toBe('assertive');
    act(() => void toast({ id: 'ok', title: 'Saved', description: 'All set' }));
    act(() => void toast({ id: 'bad', title: 'Failed', variant: 'error' }));
    expect(polite.textContent).toBe('Saved. All set');
    expect(assertive.textContent).toBe('Failed');
    const li = document.querySelector('[data-toast-id="ok"]')!;
    expect(li.getAttribute('role')).toBeNull();
    expect(li.getAttribute('aria-live')).toBeNull();
    // No role=alert/status anywhere inside the <ol>.
    expect(document.querySelector('ol [role="status"], ol [role="alert"]')).toBeNull();
    act(() => useToastStore.getState().dismiss('bad'));
    expect(assertive.textContent).toBe('');
    expect(polite.textContent).toBe('Saved. All set');
  });
});

/**
 * jsdom guesses :focus-visible from the events earlier tests sent, so pin it per element: true
 * for a control reached from the keyboard, false for one focused by a click or by a dialog that
 * a click opened.
 */
function pinFocusVisible(el: HTMLElement, visible: boolean): void {
  const real = el.matches.bind(el);
  vi.spyOn(el, 'matches').mockImplementation((sel: string) => (sel === ':focus-visible' ? visible && document.activeElement === el : real(sel)));
}

/** Focus `el` as a keyboard user would (fresh focus event, :focus-visible matching). */
function keyboardFocus(el: HTMLElement): void {
  pinFocusVisible(el, true);
  if (document.activeElement === el) act(() => el.blur());
  act(() => el.focus());
}

describe('Tooltip inside a dialog', () => {
  // A tooltip the pointer brought up: dismissing it must not also close the dialog under it.
  it('Escape hides a hover tooltip and leaves the dialog open', async () => {
    let closed = 0;
    render(
      <Dialog open onClose={() => closed++} title="Edit">
        <Tooltip content="Explains the field" delay={0}>
          <button type="button">Help</button>
        </Tooltip>
      </Dialog>,
    );
    const btn = screen.getByRole('button', { name: 'Help' });
    // The dialog put focus here when a click opened it: no keyboard focus ring.
    pinFocusVisible(btn, false);
    fireEvent.mouseEnter(btn);
    await act(() => new Promise((r) => setTimeout(r, 10)));
    expect(screen.getByRole('tooltip').textContent).toBe('Explains the field');
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(closed).toBe(0);
    // With the tooltip gone, Escape is the dialog's again.
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  // Keyboard focus shows the tooltip at once; it only follows focus, so Escape hides it and goes
  // on to the dialog in the same press. Claiming it cost an extra Escape on every icon control.
  it('Escape on a keyboard-focused control hides its tooltip and closes the dialog in one press', () => {
    let closed = 0;
    render(
      <Dialog open onClose={() => closed++} title="Edit">
        <IconButton label="Row actions" icon={<svg />} />
      </Dialog>,
    );
    const btn = screen.getByRole('button', { name: 'Row actions' });
    keyboardFocus(btn);
    expect(screen.getByRole('tooltip').textContent).toBe('Row actions');
    fireEvent.keyDown(btn, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(closed).toBe(1);
  });

  it('the dialog’s own close button, whose tooltip says Esc, closes on the first Escape', () => {
    let closed = 0;
    render(
      <Dialog open onClose={() => closed++} title="Edit">
        <p>Body</p>
      </Dialog>,
    );
    const close = screen.getByRole('button', { name: 'Close' });
    keyboardFocus(close);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(close, { key: 'Escape' });
    expect(closed).toBe(1);
  });

  it('a Menu in a dialog: Escape closes the menu, and the next one closes the dialog despite the trigger’s tooltip', () => {
    let closed = 0;
    render(
      <Dialog open onClose={() => closed++} title="Edit">
        <Menu label="Row actions" items={[{ id: 'a', label: 'Rename', onSelect: () => {} }]} />
      </Dialog>,
    );
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    keyboardFocus(trigger);
    fireEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: 'Rename' });
    fireEvent.keyDown(item, { key: 'Escape' });
    expect(screen.queryByRole('menuitem')).toBeNull();
    expect(closed).toBe(0);
    // Focus is back on the trigger and its tooltip shows again; still one Escape closes the dialog.
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('Row actions');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(closed).toBe(1);
  });
});

describe('Tooltip and window shortcuts', () => {
  it('Escape on a keyboard-focused icon control reaches an ancestor handler and window listeners on the first press', () => {
    const onAncestor = vi.fn();
    const onWindow = vi.fn();
    window.addEventListener('keydown', onWindow);
    try {
      render(
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') onAncestor();
          }}
        >
          <IconButton label="Picture in picture" icon={<svg />} />
        </div>,
      );
      const btn = screen.getByRole('button', { name: 'Picture in picture' });
      keyboardFocus(btn);
      expect(screen.getByRole('tooltip')).toBeTruthy();
      fireEvent.keyDown(btn, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).toBeNull();
      expect(onAncestor).toHaveBeenCalledTimes(1);
      expect(onWindow).toHaveBeenCalledTimes(1);
      expect((onWindow.mock.calls[0]![0] as KeyboardEvent).defaultPrevented).toBe(false);
    } finally {
      window.removeEventListener('keydown', onWindow);
    }
  });
});

describe('Dialog with nothing focusable', () => {
  it('focuses the panel without drawing a ring around the whole dialog', () => {
    render(
      <Dialog open onClose={() => {}} title="Info" hideClose>
        <p>Read only</p>
      </Dialog>,
    );
    const panel = screen.getByRole('dialog');
    expect(document.activeElement).toBe(panel);
    expect(panel.className).toContain('focus-visible:outline-none');
  });
});

describe('Menu placement', () => {
  const vp = { width: 1000, height: 700 };
  const size = { width: 200, height: 300 };

  it('drops below the trigger when it fits', () => {
    const p = placeMenu({ top: 100, bottom: 130, left: 600, right: 640 }, size, vp, { align: 'end', rtl: false });
    expect(p).toEqual({ top: 136, left: 440, side: 'below' });
  });

  it('opens upward near the bottom edge', () => {
    const p = placeMenu({ top: 600, bottom: 630, left: 600, right: 640 }, size, vp, { align: 'end', rtl: false });
    expect(p.side).toBe('above');
    expect(p.top).toBe(600 - 6 - 300);
  });

  it('clamps inside the viewport and mirrors align in RTL', () => {
    const start = placeMenu({ top: 100, bottom: 130, left: 900, right: 940 }, size, vp, { align: 'start', rtl: false });
    expect(start.left).toBe(1000 - 8 - 200);
    const rtlEnd = placeMenu({ top: 100, bottom: 130, left: 20, right: 60 }, size, vp, { align: 'end', rtl: true });
    expect(rtlEnd.left).toBe(20);
    const tall = placeMenu({ top: 300, bottom: 330, left: 20, right: 60 }, { width: 200, height: 900 }, vp, { align: 'start', rtl: false });
    expect(tall.top).toBe(8);
  });

  it('Tab closes the menu and puts focus back on the trigger so Tab continues from there', () => {
    render(
      <>
        <Menu label="Row actions" items={[{ id: 'a', label: 'Rename', onSelect: () => {} }]} />
        <button type="button">After</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Row actions' });
    fireEvent.click(trigger);
    const item = screen.getByRole('menuitem', { name: 'Rename' });
    expect(document.activeElement).toBe(item);
    fireEvent.keyDown(item, { key: 'Tab' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Tabs with a value outside the enabled tabs', () => {
  function Harness({ initial }: { initial: string }) {
    const [v, setV] = useState(initial);
    return (
      <Tabs
        label="Sections"
        value={v}
        onChange={setV}
        items={[
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
          { id: 'c', label: 'C' },
          { id: 'd', label: 'D', disabled: true },
        ]}
      />
    );
  }

  it('ArrowLeft goes to the last enabled tab, ArrowRight to the first', () => {
    render(<Harness initial="d" />);
    const list = screen.getByRole('tablist');
    fireEvent.keyDown(list, { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'C' }).getAttribute('aria-selected')).toBe('true');
    cleanup();
    render(<Harness initial="d" />);
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'A' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('ErrorState error code', () => {
  it('shows the error code in the technical details', () => {
    render(<ErrorState error={new RpcError('auth', 'bad creds')} />);
    const code = document.querySelector('[data-error-code]')!;
    expect(code.getAttribute('data-error-code')).toBe('auth');
    expect(code.textContent).toBe('Error code: auth');
    expect(code.closest('details')).toBeTruthy();
  });
});

describe('Kbd labels', () => {
  it('prints Delete and the Menu key readably', () => {
    expect(comboKeys('delete')).toEqual(['Del']);
    expect(comboKeys('shift+f10')).toEqual(['Shift', 'F10']);
    expect(comboKeys('contextmenu')).toEqual(['Menu']);
  });
});
