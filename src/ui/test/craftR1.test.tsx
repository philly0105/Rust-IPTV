/** Run 1 craft fixes in the primitives: toasts over phone-width dialogs, density-aware list rows. */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/i18n';

import { Dialog, ToastViewport, VirtualList, focusableIn, scaleRowPx, toast, useToastStore } from '..';
import { TOAST_DIALOG_GAP, toastReserveFor } from '../Dialog';
import { setUiScaleState } from '../scale';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function scrollTo() {};
});
afterEach(() => {
  cleanup();
  act(() => setUiScaleState(1, 'comfortable'));
  useToastStore.setState({ toasts: [] });
});

const viewport = () => document.querySelector<HTMLElement>('[data-toast-viewport]')!;

describe('toasts and centred dialogs', () => {
  function Harness({ open, placement }: { open: boolean; placement?: 'center' | 'end' }) {
    return (
      <>
        <ToastViewport />
        <Dialog open={open} onClose={() => {}} title="Lock groups" placement={placement} footer={<button type="button">Save locks</button>}>
          body
        </Dialog>
      </>
    );
  }

  it('flags the viewport while a centred dialog is open, and moves it to the top below sm', () => {
    const { rerender } = render(<Harness open={false} />);
    act(() => void toast({ title: 'Parental controls are on', variant: 'success' }));
    expect(viewport().hasAttribute('data-over-dialog')).toBe(false);
    rerender(<Harness open />);
    expect(screen.getByRole('dialog', { name: 'Lock groups' })).toBeTruthy();
    expect(viewport().hasAttribute('data-over-dialog')).toBe(true);
    // The layout rule itself: phone widths only, so desktop toasts stay beside the dialog.
    expect(viewport().className).toContain('max-sm:data-[over-dialog]:top-4');
    expect(viewport().className).toContain('max-sm:data-[over-dialog]:bottom-auto');
    expect(viewport().className).toMatch(/(^|\s)bottom-4(\s|$)/);
    rerender(<Harness open={false} />);
    expect(viewport().hasAttribute('data-over-dialog')).toBe(false);
  });

  it('a drawer does not move the toasts', () => {
    render(<Harness open placement="end" />);
    expect(screen.getByRole('dialog', { name: 'Lock groups' })).toBeTruthy();
    expect(viewport().hasAttribute('data-over-dialog')).toBe(false);
  });

  it('stacked dialogs keep the flag until the last one closes', () => {
    function Two({ a, b }: { a: boolean; b: boolean }) {
      return (
        <>
          <ToastViewport />
          <Dialog open={a} onClose={() => {}} title="First">
            one
          </Dialog>
          <Dialog open={b} onClose={() => {}} title="Second">
            two
          </Dialog>
        </>
      );
    }
    const { rerender } = render(<Two a b />);
    expect(viewport().hasAttribute('data-over-dialog')).toBe(true);
    rerender(<Two a={false} b />);
    expect(viewport().hasAttribute('data-over-dialog')).toBe(true);
    rerender(<Two a={false} b={false} />);
    expect(viewport().hasAttribute('data-over-dialog')).toBe(false);
  });

  describe('below sm the dialog starts under the toast stack', () => {
    const layer = () => document.querySelector<HTMLElement>('[data-dialog-layer]')!;
    const reserve = () => layer().style.getPropertyValue('--toast-reserve');
    afterEach(() => vi.restoreAllMocks());

    it('toastReserveFor: the stack bottom plus a gap, nothing without toasts', () => {
      expect(toastReserveFor(0)).toBe(0);
      expect(toastReserveFor(112)).toBe(112 + TOAST_DIALOG_GAP);
      expect(toastReserveFor(99.2)).toBe(100 + TOAST_DIALOG_GAP);
    });

    it('pads the layer by the reserve while a toast shows over it, and drops it when it goes', () => {
      // A toast at top-4 with a description, on an 844 px phone: taller than the 8vh (67 px) gap.
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const bottom = this.hasAttribute('data-toast-viewport') ? 112 : 0;
        return { x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: bottom, bottom, toJSON: () => ({}) } as DOMRect;
      });
      render(<Harness open />);
      expect(reserve()).toBe('0px');
      // The rule only applies below sm; wider windows keep the plain 8vh gap.
      expect(layer().className).toContain('pt-[8vh]');
      expect(layer().className).toContain('max-sm:pt-[max(8vh,var(--toast-reserve,0px))]');
      expect(screen.getByRole('dialog').className).toContain('max-sm:max-h-[calc(100vh-max(8vh,var(--toast-reserve,0px))-4vh-24px)]');

      act(() => void toast({ title: 'Locks saved', description: 'Two groups are locked now.', variant: 'success' }));
      expect(reserve()).toBe(`${112 + TOAST_DIALOG_GAP}px`);

      act(() => useToastStore.setState({ toasts: [] }));
      expect(reserve()).toBe('0px');
    });

    it('a toast already up when a dialog opens is reserved for, again when it reopens', () => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
        const bottom = this.hasAttribute('data-toast-viewport') ? 90 : 0;
        return { x: 0, y: 0, top: 0, left: 0, right: 0, width: 0, height: bottom, bottom, toJSON: () => ({}) } as DOMRect;
      });
      const { rerender } = render(<Harness open={false} />);
      act(() => void toast({ title: 'Imported', variant: 'success' }));
      rerender(<Harness open />);
      expect(reserve()).toBe(`${90 + TOAST_DIALOG_GAP}px`);
      rerender(<Harness open={false} />);
      rerender(<Harness open />);
      expect(reserve()).toBe(`${90 + TOAST_DIALOG_GAP}px`);
    });

    it('a drawer takes no reserve', () => {
      render(<Harness open placement="end" />);
      act(() => void toast({ title: 'Saved', variant: 'success' }));
      expect(reserve()).toBe('');
      expect(layer().className).not.toContain('--toast-reserve');
    });
  });
});

describe('focusableIn skips a roving group\'s inactive items', () => {
  it('leaves out tabindex="-1" buttons and inputs, keeps the active item', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div role="radiogroup">
        <button type="button" tabindex="-1">Mon</button>
        <button type="button" tabindex="0">Tue</button>
        <button type="button" tabindex="-1">Wed</button>
      </div>
      <input type="file" tabindex="-1" />
      <a href="#x" tabindex="-1">skipped link</a>
      <button type="button">Go</button>
      <div tabindex="0">panel</div>`;
    document.body.append(root);
    expect(focusableIn(root).map((el) => el.textContent || el.tagName)).toEqual(['Tue', 'Go', 'panel']);
    root.remove();
  });

  it("a dialog's first-focus fallback and Tab trap ignore them", () => {
    render(
      <Dialog open onClose={() => {}} title="Jump to" hideClose>
        <div role="radiogroup" aria-label="Day">
          <button type="button" tabIndex={-1}>
            Yesterday
          </button>
          <button type="button" tabIndex={0}>
            Today
          </button>
        </div>
        <button type="button">Go</button>
      </Dialog>,
    );
    expect(document.activeElement?.textContent).toBe('Today');
    const go = screen.getByRole('button', { name: 'Go' });
    go.focus();
    act(() => void go.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })));
    expect(document.activeElement?.textContent).toBe('Today');
  });
});

describe('density-aware list rows', () => {
  it('scaleRowPx shrinks only the spacing part under compact density', () => {
    // 64 px row: 28 px of padding/gaps, 36 px of text and logo.
    expect(scaleRowPx(64, 28, 1, 'comfortable')).toBe(64);
    expect(scaleRowPx(64, 28, 1, 'compact')).toBe(Math.round(36 + 28 * 0.875));
    expect(scaleRowPx(64, 28, 1.2, 'compact')).toBe(Math.round((36 + 28 * 0.875) * 1.2));
    // No spacing part: UI scale only, as before.
    expect(scaleRowPx(64, 0, 1, 'compact')).toBe(64);
    // Out-of-range spacing is clamped to the row.
    expect(scaleRowPx(40, 100, 1, 'compact')).toBe(35);
    expect(scaleRowPx(40, -5, 1, 'compact')).toBe(40);
  });

  /** Height of one slot, read off the list's sized track (three rows, no footer). */
  function rowHeight() {
    const track = screen.getByRole('listbox', { name: 'Channels' }).firstElementChild as HTMLElement;
    return `${Number.parseFloat(track.style.height) / 3}px`;
  }

  it('VirtualList rows with itemSpacing get shorter in compact density', () => {
    const items = ['a', 'b', 'c'];
    const list = (spacing?: number) => (
      <VirtualList items={items} itemHeight={64} itemSpacing={spacing} label="Channels" initialRect={{ width: 300, height: 600 }} render={(x) => <span>{x}</span>} />
    );
    const { rerender } = render(list(28));
    expect(rowHeight()).toBe('64px');
    act(() => setUiScaleState(1, 'compact'));
    rerender(list(28));
    expect(rowHeight()).toBe(`${Math.round(36 + 28 * 0.875)}px`);
    // Without itemSpacing the slot keeps following the UI scale only.
    rerender(list());
    expect(rowHeight()).toBe('64px');
  });
});
