import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { RpcError } from '@/api/transport';

import { Dialog, ErrorState, Menu, Tabs, ToastViewport, VirtualList, toast, useToastStore } from '..';
import { pageWindow } from '../Pagination';
import { aspectRatio, gridLayout } from '../VirtualGrid';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 400 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 600 });
  Element.prototype.scrollTo ??= function scrollTo() {};
});
afterEach(() => {
  cleanup();
  useToastStore.setState({ toasts: [] });
});

describe('layout helpers', () => {
  it('pageWindow keeps first, last, and neighbours with gaps', () => {
    expect(pageWindow(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(pageWindow(10, 40)).toEqual([0, null, 9, 10, 11, null, 39]);
    expect(pageWindow(0, 40)).toEqual([0, 1, 2, 3, null, 39]);
  });
  it('gridLayout fits columns to the width', () => {
    expect(gridLayout(1000, 160, 16)).toEqual({ columns: 5, cellWidth: (1000 - 64) / 5 });
    expect(gridLayout(100, 160, 16).columns).toBe(1);
    expect(aspectRatio('poster')).toBeCloseTo(2 / 3);
  });
});

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>open</button>
        <Dialog open={open} onClose={() => setOpen(false)} title="Rename" footer={<button>Save</button>}>
          <input aria-label="Name" data-autofocus="" />
        </Dialog>
      </>
    );
  }
  it('focuses initial field, traps Tab, closes on Escape, restores focus', () => {
    render(<Harness />);
    const opener = screen.getByText('open');
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Rename' });
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    // Shift+Tab from the first focusable wraps to the last.
    const focusables = dialog.querySelectorAll<HTMLElement>('button, input');
    focusables[0]!.focus();
    fireEvent.keyDown(focusables[0]!, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Tabs', () => {
  it('moves with arrow keys and activates', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Kind"
        value="a"
        onChange={onChange}
        items={[
          { id: 'a', label: 'Live' },
          { id: 'b', label: 'Movies' },
          { id: 'c', label: 'Series' },
        ]}
      />,
    );
    const live = screen.getByRole('tab', { name: 'Live' });
    expect(live.tabIndex).toBe(0);
    expect(screen.getByRole('tab', { name: 'Movies' }).tabIndex).toBe(-1);
    live.focus();
    fireEvent.keyDown(live, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith('c');
  });
});

describe('Menu', () => {
  it('opens from the keyboard and runs an item', () => {
    const onSelect = vi.fn();
    render(
      <Menu
        label="Channel actions"
        items={[
          { id: 'fav', label: 'Add to favorites', onSelect },
          { id: 'sep', type: 'separator' },
          { id: 'hide', label: 'Hide channel', onSelect: () => {} },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Channel actions' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    const first = screen.getByRole('menuitem', { name: 'Add to favorites' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Hide channel' }));
    fireEvent.click(first);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('ErrorState', () => {
  it('maps RpcError codes to a next-step hint and retries', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={new RpcError('auth', 'bad creds')} onRetry={onRetry} />);
    expect(screen.getByText('Sign-in was rejected')).toBeTruthy();
    expect(screen.getByText(/Check the username, password, or MAC address/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalled();
  });
});

describe('VirtualList', () => {
  const items = Array.from({ length: 5000 }, (_, i) => `Row ${i}`);
  it('renders a window, navigates by keyboard, selects, and pages', () => {
    const onSelect = vi.fn();
    const onEndReached = vi.fn();
    render(
      <div style={{ height: 400 }}>
        <VirtualList
          items={items}
          itemHeight={40}
          label="Rows"
          onSelect={onSelect}
          onEndReached={onEndReached}
          initialRect={{ width: 600, height: 400 }}
          render={(item) => <span>{item}</span>}
        />
      </div>,
    );
    const list = screen.getByRole('listbox', { name: 'Rows' });
    expect(screen.getAllByRole('option').length).toBeLessThan(40);
    list.focus();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('Row 1', 1);
    expect(onEndReached).not.toHaveBeenCalled();
    act(() => {
      fireEvent.keyDown(list, { key: 'End' });
    });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onSelect).toHaveBeenLastCalledWith('Row 4999', 4999);
  });
});

describe('Toast', () => {
  it('upserts by id and works outside React', () => {
    render(<ToastViewport />);
    act(() => {
      toast({ id: 'imp', title: 'Importing' });
    });
    expect(screen.getByText('Importing')).toBeTruthy();
    act(() => {
      toast({ id: 'imp', title: 'Done', variant: 'success' });
    });
    expect(screen.queryByText('Importing')).toBeNull();
    expect(screen.getByText('Done')).toBeTruthy();
  });
});
