/** Run 1 craft fixes in the primitives: toasts over phone-width dialogs, density-aware list rows. */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import '@/i18n';

import { Dialog, ToastViewport, VirtualList, scaleRowPx, toast, useToastStore } from '..';
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
