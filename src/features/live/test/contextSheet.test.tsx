/** The channel context menu as a bottom sheet on a phone, and its key hints on touch. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu } from '../components/ContextMenu';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Makes the phone query (below sm, coarse pointer) match or not. */
function phone(on: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: on && q.includes('pointer: coarse'),
    media: q,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function open(onClose = vi.fn(), onPlay = vi.fn()) {
  render(
    <>
      <button type="button">Row</button>
      <ContextMenu
        pos={{ x: 300, y: 200 }}
        label="US| ESPN HD"
        header={{ title: 'US| ESPN HD', subtitle: 'College GameDay' }}
        items={[
          { id: 'play', label: 'Play', onSelect: onPlay },
          { id: 'rename', label: 'Rename…', hint: 'F2', onSelect: () => undefined },
        ]}
        onClose={onClose}
      />
    </>,
  );
  return { menu: screen.getByRole('menu', { name: 'US| ESPN HD' }), onClose, onPlay };
}

describe('channel context menu on a phone', () => {
  it('is a bottom sheet over a scrim, focused as a whole, with the items in their order', () => {
    phone(true);
    const { menu } = open();
    expect(menu.hasAttribute('data-sheet')).toBe(true);
    expect(menu.className).toContain('inset-x-0');
    expect(menu.className).toContain('bottom-0');
    // No cursor position: the sheet is placed by its classes alone.
    expect(menu.style.left).toBe('');
    expect(document.activeElement).toBe(menu);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual(['Play', 'Rename…F2']);
    expect(document.querySelector('[data-context-scrim]')).not.toBeNull();
    // The arrows still start at the first item.
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play' }));
  });

  it('closes on a tap on the scrim, not on its press, so the tap never reaches the page', () => {
    phone(true);
    const { onClose } = open();
    const scrim = document.querySelector<HTMLElement>('[data-context-scrim]')!;
    fireEvent.mouseDown(scrim);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores the release of the long press that opened it, and takes a tap that starts inside', () => {
    phone(true);
    const { onPlay, onClose } = open();
    const play = screen.getByRole('menuitem', { name: 'Play' });
    // The finger went down on the row, so the click it ends with does not choose Play.
    fireEvent.click(play, { detail: 1 });
    expect(onPlay).not.toHaveBeenCalled();
    fireEvent.pointerDown(play);
    fireEvent.click(play, { detail: 1 });
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('takes Enter on an item at once', () => {
    phone(true);
    const { onPlay } = open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Play' }), { detail: 0 });
    expect(onPlay).toHaveBeenCalledTimes(1);
  });

  it('stays a popover at the cursor with a mouse, its first item focused, and draws no scrim', () => {
    phone(false);
    const { menu } = open();
    expect(menu.hasAttribute('data-sheet')).toBe(false);
    expect(menu.style.left).not.toBe('');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Play' }));
    expect(document.querySelector('[data-context-scrim]')).toBeNull();
  });

  it('hides key hints under a coarse pointer and keeps them out of the name', () => {
    phone(false);
    open();
    const hint = screen.getByText('F2');
    expect(hint.className).toContain('pointer-coarse:hidden');
    expect(screen.getByRole('menuitem', { name: 'Rename…' })).toBeTruthy();
  });
});
