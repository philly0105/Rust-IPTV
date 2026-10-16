import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { Dialog, Menu, Select, ToastViewport, toast, useToastStore } from '..';

/** Stands in for the Fullscreen API, which jsdom lacks. */
function setFullscreen(el: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { value: el, configurable: true });
  document.dispatchEvent(new Event('fullscreenchange'));
}

/**
 * A mousedown as a browser handles it: unless a handler prevents the default, focus then moves
 * to the pressed element's nearest focusable ancestor, or to <body> when there is none (also
 * when the pressed element is already gone, like a scrim that closed its dialog).
 */
function press(el: Element): boolean {
  const proceeded = fireEvent.mouseDown(el);
  if (proceeded) {
    const to = el.isConnected ? el.closest<HTMLElement>('a[href], button:not([disabled]), input, select, textarea, [tabindex]') : null;
    if (to) to.focus();
    else (document.activeElement as HTMLElement | null)?.blur();
  }
  return proceeded;
}

function scrimOf(title: string): Element {
  const panel = screen.getByRole('dialog', { name: title });
  return panel.parentElement!.firstElementChild!;
}

afterEach(() => {
  cleanup();
  setFullscreen(null);
  useToastStore.setState({ toasts: [] });
  document.body.querySelectorAll('[data-test-stage]').forEach((n) => n.remove());
});

function makeStage(tag: 'div' | 'video' = 'div'): HTMLElement {
  const el = document.createElement(tag);
  el.dataset['testStage'] = '';
  return document.body.appendChild(el);
}

describe('overlays in element fullscreen (L1-live-9)', () => {
  it('moves the toast stack into the fullscreen element, so the multi-view Undo can be seen and pressed', () => {
    render(<ToastViewport />);
    const wall = makeStage();
    setFullscreen(wall);
    const undo = vi.fn();
    act(() => {
      toast({ title: 'Closed BBC One', action: { label: 'Undo', onClick: undo } });
    });
    const viewport = document.querySelector('[data-toast-viewport]')!;
    expect(wall.contains(viewport)).toBe(true);
    // Fixed, and stacked above the wall's own chrome (its overlay toolbar is z-50).
    expect(viewport.className).toMatch(/\bfixed\b/);
    expect(viewport.className).toContain('z-[80]');
    fireEvent.click(within(wall).getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();

    setFullscreen(null);
    expect(wall.contains(viewport)).toBe(false);
    expect(document.body.contains(viewport)).toBe(true);
  });

  it('keeps an open dialog, its typed text and its focus when fullscreen ends', () => {
    const stage = makeStage();
    setFullscreen(stage);
    function Rename() {
      const [name, setName] = useState('');
      return (
        <Dialog open onClose={() => {}} title="Rename">
          <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        </Dialog>
      );
    }
    render(<Rename />);
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(stage.contains(input)).toBe(true);
    fireEvent.change(input, { target: { value: 'News' } });
    expect(document.activeElement).toBe(input);

    setFullscreen(null);
    expect(stage.contains(input)).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Name' })).toBe(input);
    expect(input.value).toBe('News');
    expect(document.activeElement).toBe(input);
  });

  it('opens a menu inside the fullscreen element', () => {
    const stage = makeStage();
    setFullscreen(stage);
    render(<Menu label="Tile actions" items={[{ id: 'a', label: 'Swap', onSelect: () => {} }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tile actions' }));
    expect(stage.contains(screen.getByRole('menu'))).toBe(true);
  });

  it('stays on <body> when a <video> itself is fullscreen (it paints no children)', () => {
    render(<ToastViewport />);
    setFullscreen(makeStage('video'));
    act(() => {
      toast({ title: 'Saved' });
    });
    expect(document.querySelector('[data-toast-viewport]')!.parentElement!.parentElement).toBe(document.body);
  });
});

describe('focus after closing from outside (L1-shell-12)', () => {
  function Opener({ dismissible = true }: { dismissible?: boolean }) {
    const [open, setOpen] = useState(false);
    return (
      <main id="main" tabIndex={-1}>
        <button type="button" onClick={() => setOpen(true)}>
          Search
        </button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Palette" dismissible={dismissible}>
          <button type="button">inside</button>
        </Dialog>
      </main>
    );
  }

  it('a press on the scrim closes the dialog and focus stays on the opener, not <body>', () => {
    render(<Opener />);
    const opener = screen.getByRole('button', { name: 'Search' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.textContent).toBe('inside');
    expect(press(scrimOf('Palette'))).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('a press on the scrim of a dialog that cannot be dismissed keeps focus inside it', () => {
    render(<Opener dismissible={false} />);
    const opener = screen.getByRole('button', { name: 'Search' });
    opener.focus();
    fireEvent.click(opener);
    press(scrimOf('Palette'));
    expect(screen.getByRole('dialog', { name: 'Palette' })).toBeTruthy();
    expect(document.activeElement?.textContent).toBe('inside');
  });

  function MenuPage() {
    return (
      <main id="main" tabIndex={-1}>
        <p>Some text</p>
        <Menu label="Poster actions" items={[{ id: 'a', label: 'Add to My List', onSelect: () => {} }]} />
        <button type="button">Other</button>
      </main>
    );
  }

  function openMenu(): HTMLElement {
    const trigger = screen.getByRole('button', { name: 'Poster actions' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
    return trigger;
  }

  it('a menu closed by a press on empty page gives focus back to its trigger', () => {
    render(<MenuPage />);
    const trigger = openMenu();
    expect(press(document.body)).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a menu closed by a press on text in #main gives focus to the trigger, not to #main', () => {
    render(<MenuPage />);
    const trigger = openMenu();
    press(screen.getByText('Some text'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('a menu closed by a press on another control leaves focus on that control', () => {
    render(<MenuPage />);
    openMenu();
    const other = screen.getByRole('button', { name: 'Other' });
    expect(press(other)).toBe(true);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(other);
  });
});

describe('focus after a prompt and its dialog close together (L2-settings-11)', () => {
  /** The Lock groups shape: the discard prompt is a sibling of the dialog it guards; Discard unmounts both. */
  function SiblingLocks({ onDone }: { onDone: () => void }) {
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <Dialog open onClose={() => setConfirm(true)} title="Lock groups">
          <button type="button" onClick={() => setConfirm(true)}>
            Cancel
          </button>
        </Dialog>
        {confirm ? (
          <Dialog open onClose={() => setConfirm(false)} title="Discard changes?">
            <button type="button" data-autofocus="" onClick={() => setConfirm(false)}>
              Keep editing
            </button>
            <button type="button" onClick={onDone}>
              Discard
            </button>
          </Dialog>
        ) : null}
      </>
    );
  }

  /** The prompt rendered inside the parent's children; the parent closes through its open prop. */
  function NestedLocks({ open, onDone }: { open: boolean; onDone: () => void }) {
    const [confirm, setConfirm] = useState(false);
    return (
      <Dialog open={open} onClose={() => setConfirm(true)} title="Lock groups">
        <button type="button" onClick={() => setConfirm(true)}>
          Cancel
        </button>
        {confirm ? (
          <Dialog open onClose={() => setConfirm(false)} title="Discard changes?">
            <button type="button" onClick={onDone}>
              Discard
            </button>
          </Dialog>
        ) : null}
      </Dialog>
    );
  }

  function Page({ shape, keepOpener = true }: { shape: 'sibling' | 'nested' | 'nested-unmount'; keepOpener?: boolean }) {
    const [open, setOpen] = useState(false);
    const [opener, setOpener] = useState(true);
    const done = () => {
      setOpen(false);
      if (!keepOpener) setOpener(false);
    };
    return (
      <main id="main" tabIndex={-1}>
        {opener ? (
          <button type="button" onClick={() => setOpen(true)}>
            Choose groups
          </button>
        ) : null}
        {shape === 'sibling' && open ? <SiblingLocks onDone={done} /> : null}
        {shape === 'nested' ? <NestedLocks open={open} onDone={done} /> : null}
        {shape === 'nested-unmount' && open ? <NestedLocks open onDone={done} /> : null}
      </main>
    );
  }

  function discardFrom(opener: HTMLElement): void {
    opener.focus();
    fireEvent.click(opener);
    const cancel = within(screen.getByRole('dialog', { name: 'Lock groups' })).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    const discard = within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', { name: 'Discard' });
    discard.focus();
    fireEvent.click(discard);
    expect(screen.queryByRole('dialog')).toBeNull();
  }

  it.each(['sibling', 'nested', 'nested-unmount'] as const)('lands on the original opener (%s prompt)', (shape) => {
    render(<Page shape={shape} />);
    const opener = screen.getByRole('button', { name: 'Choose groups' });
    discardFrom(opener);
    expect(document.activeElement).toBe(opener);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('lands on #main, never <body>, when the opener went away in the same commit', () => {
    render(<Page shape="sibling" keepOpener={false} />);
    discardFrom(screen.getByRole('button', { name: 'Choose groups' }));
    expect(document.activeElement?.id).toBe('main');
  });

  it('a prompt closing alone returns focus inside the dialog under it', () => {
    render(<Page shape="sibling" />);
    const opener = screen.getByRole('button', { name: 'Choose groups' });
    opener.focus();
    fireEvent.click(opener);
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.click(cancel);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    expect(document.activeElement).toBe(cancel);
    expect(document.documentElement.style.overflow).toBe('hidden');
  });
});

describe('Select width (L1-visual-20)', () => {
  it('lets a toolbar caller size the select to its options (w-auto replaces the base w-full)', () => {
    render(<Select aria-label="Sort by" options={[{ value: 'added', label: 'Recently added' }]} className="h-8 w-auto" />);
    const select = screen.getByRole('combobox', { name: 'Sort by' });
    expect(select.className.split(' ')).toContain('w-auto');
    expect(select.className.split(' ')).not.toContain('w-full');
  });
});
