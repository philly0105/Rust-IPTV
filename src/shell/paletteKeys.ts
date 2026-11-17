import { useShellStore } from './store';

/**
 * Keys typed between Ctrl/Cmd+K and the palette's field taking focus (v-shell-home-04). The
 * palette is a lazy chunk that mounts on its first open, so "Ctrl+K espn" used to reach the page
 * instead of the field and open an empty palette. From the press until the palette takes them
 * (`takePaletteKeys`, as its field gets focus), printable keys and Backspace are kept here and
 * Enter is held back from the page, so none reaches a page shortcut (w-a11y-05) however slow the
 * chunk is; the palette closing first (Escape still reaches the shell) drops them.
 */
let typed = '';
let stop: (() => void) | null = null;

export function bufferPaletteKeys(): void {
  stop?.();
  typed = '';
  const onKey = (e: KeyboardEvent) => {
    if (!useShellStore.getState().paletteOpen) {
      end();
      return;
    }
    // The field has focus: what follows is its own.
    if (document.activeElement instanceof HTMLElement && document.activeElement.hasAttribute('cmdk-input')) return;
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (e.key === 'Backspace') typed = typed.slice(0, -1);
    else if (e.key.length === 1) typed += e.key;
    else if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
  };
  const end = () => {
    window.removeEventListener('keydown', onKey, true);
    stop = null;
    typed = '';
  };
  window.addEventListener('keydown', onKey, true);
  stop = end;
}

/** The keys typed since the palette was asked for; stops collecting. */
export function takePaletteKeys(): string {
  const keys = typed;
  stop?.();
  return keys;
}
