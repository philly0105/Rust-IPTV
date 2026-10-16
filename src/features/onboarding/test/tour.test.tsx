// The tour (contract C7, check 10): three steps with Next, Back and Skip,
// Escape skips, the arrow keys step (mirrored right-to-left), focus is
// trapped and returned, no key reaches the app's shortcuts, a missing anchor
// gives a centred card, and every transition sits behind motion-safe.
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.hoisted(() => ({ current: null as null | { call: (cmd: string, args?: unknown) => Promise<unknown> } }));
vi.mock('@/api/transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/transport')>();
  const call = async (cmd: string, args?: unknown) => {
    try {
      return await rpcMock.current!.call(cmd, args);
    } catch (e) {
      throw actual.RpcError.from(e);
    }
  };
  return { ...actual, rpc: call, rpcRaw: call };
});
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));

const h = await import('./harness');
const core = h.createCore();
rpcMock.current = core;
const { Tour } = await import('../tour/Tour');
const { shortcutRegistry } = await import('@/shell/shortcuts');

const anchors: HTMLElement[] = [];
function addAnchor(name: 'live' | 'vod' | 'search', box = { top: 120, left: 8, width: 56, height: 44 }) {
  const el = document.createElement('a');
  el.href = `#${name}`;
  el.dataset.tour = name;
  el.textContent = name;
  document.body.append(el);
  h.placeAt(el, box);
  anchors.push(el);
  return el;
}

function open() {
  const onClose = vi.fn();
  const view = h.renderUi(<Tour onClose={onClose} />);
  return { onClose, view };
}

const card = () => screen.getByTestId('tour-card');
/** Where an element sits: the tour positions by transform (no layout shift), not top/left. */
const at = (el: HTMLElement) => {
  const m = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform);
  if (!m) throw new Error(`no translate in "${el.style.transform}"`);
  return { x: Number(m[1]), y: Number(m[2]) };
};
const step = () => screen.getByTestId('tour').getAttribute('data-tour-step');
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(document.activeElement ?? card(), { key: k, ...init });

beforeAll(() => h.installDomStubs());
beforeEach(() => h.resetShared());
afterEach(() => {
  cleanup();
  for (const el of anchors.splice(0)) el.remove();
});

describe('Tour', () => {
  it('opens on the first step as a labelled modal dialog with focus on Next', () => {
    open();
    const dialog = screen.getByRole('dialog', { name: 'Live TV' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const described = document.getElementById(dialog.getAttribute('aria-describedby') ?? '');
    expect(described?.textContent).toMatch(/what's on now and next/);
    expect(screen.getByTestId('tour-progress')?.textContent).toContain('Step 1 of 3');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Skip tour' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('walks forward with Next and back with Back', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('vod');
    expect(screen.getByRole('dialog', { name: 'Movies, series and My List' })).toBeTruthy();
    expect(screen.getByTestId('tour-progress')?.textContent).toContain('Step 2 of 3');
    const back = screen.getByRole('button', { name: 'Back' });
    back.focus();
    fireEvent.click(back);
    expect(step()).toBe('live');
    // Back is gone on the first step; focus moves to Next rather than the page.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
  });

  it('keeps focus on Back while stepping back from the last step', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const back = screen.getByRole('button', { name: 'Back' });
    back.focus();
    fireEvent.click(back);
    expect(step()).toBe('vod');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Back' }));
  });

  it('finishes with Done on the last step, which has the search hints and no Skip', () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(step()).toBe('search');
    expect(screen.getByRole('dialog', { name: 'Search everything' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Skip tour' })).toBeNull();
    expect(card()?.textContent).toContain('Commands');
    expect(card()?.textContent).toContain('Shortcuts');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('finished');
  });

  it('skips with Skip tour', () => {
    const { onClose } = open();
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onClose).toHaveBeenCalledWith('skipped');
  });

  it('skips with Escape on any step', () => {
    const { onClose } = open();
    key('ArrowRight');
    expect(step()).toBe('vod');
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith('skipped');
  });

  it('closes once, however many keys arrive', () => {
    const { onClose } = open();
    key('Escape');
    key('Escape');
    fireEvent.click(screen.getByRole('button', { name: 'Skip tour' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('steps with the arrow keys and finishes past the last step', () => {
    const { onClose } = open();
    key('ArrowLeft');
    expect(step()).toBe('live');
    key('ArrowRight');
    key('ArrowRight');
    expect(step()).toBe('search');
    key('ArrowLeft');
    expect(step()).toBe('vod');
    key('ArrowRight');
    key('ArrowRight');
    expect(onClose).toHaveBeenCalledWith('finished');
  });

  it('ignores arrow keys with a modifier', () => {
    open();
    key('ArrowRight', { shiftKey: true });
    key('ArrowRight', { ctrlKey: true });
    expect(step()).toBe('live');
  });

  it('mirrors the arrow keys in a right-to-left layout', () => {
    document.documentElement.dir = 'rtl';
    open();
    key('ArrowLeft');
    expect(step()).toBe('vod');
    key('ArrowRight');
    expect(step()).toBe('live');
  });

  it('wraps Tab inside the card in both directions', () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const next = screen.getByRole('button', { name: 'Next' });
    const skip = screen.getByRole('button', { name: 'Skip tour' });
    next.focus();
    key('Tab');
    expect(document.activeElement).toBe(skip);
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(next);
  });

  it('pulls focus back when it escapes to the page behind', () => {
    const outside = document.createElement('button');
    outside.textContent = 'Behind';
    document.body.append(outside);
    open();
    act(() => outside.focus());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    outside.remove();
  });

  it('returns focus to where it was when it closes', () => {
    const before = document.createElement('button');
    before.textContent = 'Opener';
    document.body.append(before);
    before.focus();
    const { view } = open();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
    view.unmount();
    expect(document.activeElement).toBe(before);
    before.remove();
  });

  it("keeps the app's shortcuts from seeing its keys", () => {
    const onEscape = vi.fn();
    const onPalette = vi.fn();
    const offA = shortcutRegistry.register('escape', onEscape, { description: 'close', area: 'test', global: true });
    const offB = shortcutRegistry.register('mod+k', onPalette, { description: 'palette', area: 'test', global: true });
    const { onClose } = open();
    key('k', { ctrlKey: true, metaKey: true });
    key('Escape');
    expect(onPalette).not.toHaveBeenCalled();
    expect(onEscape).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith('skipped');
    offA();
    offB();
  });

  // A click on the card's title or text focuses the nearest focusable ancestor. Without one the
  // browser drops focus to <body>, and Escape and the arrows stopped working (review R1).
  it('makes the card focusable but not a Tab stop, so a click on its text keeps focus in the dialog', () => {
    open();
    expect(card().tabIndex).toBe(-1);
    expect(card().className).toContain('focus-visible:outline-none');
    act(() => card().focus());
    expect(document.activeElement).toBe(card());
    key('ArrowRight');
    expect(step()).toBe('vod');
    expect(document.activeElement).toBe(card());
  });

  it('Tab from the card itself starts at the first button, Shift+Tab at the last', () => {
    open();
    key('ArrowRight');
    act(() => card().focus());
    key('Tab');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Skip tour' }));
    act(() => card().focus());
    key('Tab', { shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Next' }));
  });

  it('keeps the keyboard when focus falls to the page body, and still hides it from the shortcuts', () => {
    const onPalette = vi.fn();
    const off = shortcutRegistry.register('mod+k', onPalette, { description: 'palette', area: 'test', global: true });
    const { onClose } = open();
    act(() => (document.activeElement as HTMLElement).blur());
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(step()).toBe('vod');
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true, metaKey: true });
    expect(onPalette).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Skip tour' }));
    act(() => (document.activeElement as HTMLElement).blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledWith('skipped');
    off();
  });

  it('lets a modal that opened above it keep its own focus and keys', () => {
    const layer = document.createElement('div');
    layer.setAttribute('aria-modal', 'true');
    const inside = document.createElement('button');
    layer.append(inside);
    document.body.append(layer);
    const seen = vi.fn();
    inside.addEventListener('keydown', seen);
    const { onClose } = open();
    // Not pulled back: that would fight the other layer's own focus trap.
    act(() => inside.focus());
    expect(document.activeElement).toBe(inside);
    fireEvent.keyDown(inside, { key: 'Escape' });
    expect(seen).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    layer.remove();
  });

  it('hides the key hints when the main pointer is a finger', () => {
    open();
    key('ArrowRight');
    key('ArrowRight');
    const hints = screen.getByTestId('tour-hints');
    expect(hints.textContent).toContain('Commands');
    expect(hints.className.split(/\s+/)).toContain('pointer-coarse:hidden');
  });

  it('shows a centred card over a plain scrim when the anchor is missing', () => {
    open();
    expect(screen.getByTestId('tour-scrim')).toBeTruthy();
    expect(screen.queryByTestId('tour-spotlight')).toBeNull();
    expect(card().getAttribute('data-side')).toBe('center');
  });

  it('spotlights the anchor and opens the card beside it', () => {
    addAnchor('live');
    open();
    const spot = screen.getByTestId('tour-spotlight');
    expect(at(spot)).toEqual({ x: 2, y: 114 });
    expect(card().getAttribute('data-side')).toBe('end');
    expect(at(card()).x).toBeGreaterThan(64);
  });

  it('moves the spotlight and card by transform only, so the motion is no layout shift (L2-sources-home-11)', () => {
    addAnchor('live');
    open();
    for (const el of [screen.getByTestId('tour-spotlight'), card()]) {
      // Pinned at the corner; only the transform (and the spotlight's size) changes between steps.
      expect(el.className).toMatch(/\btop-0\b/);
      expect(el.className).toMatch(/\bleft-0\b/);
      expect(el.style.top).toBe('');
      expect(el.style.left).toBe('');
      expect(el.className).not.toMatch(/transition-\[[^\]]*\b(top|left)\b/);
    }
    expect(screen.getByTestId('tour-spotlight').className).toContain('motion-safe:transition-[transform,width,height]');
    expect(card().className).toContain('motion-safe:transition-transform');
  });

  it('moves to the next anchor, and centres again when a step has none', () => {
    addAnchor('live');
    addAnchor('vod', { top: 180, left: 8, width: 56, height: 44 });
    open();
    expect(at(screen.getByTestId('tour-spotlight')).y).toBe(114);
    key('ArrowRight');
    expect(at(screen.getByTestId('tour-spotlight')).y).toBe(174);
    key('ArrowRight');
    expect(screen.queryByTestId('tour-spotlight')).toBeNull();
    expect(card().getAttribute('data-side')).toBe('center');
  });

  it('skips anchors that are hidden or not laid out', () => {
    const hidden = addAnchor('live');
    hidden.setAttribute('aria-hidden', 'true');
    const empty = addAnchor('live', { top: 0, left: 0, width: 0, height: 0 });
    expect(empty).toBeTruthy();
    open();
    expect(screen.queryByTestId('tour-spotlight')).toBeNull();
  });

  it('finds an anchor that mounts after the tour opened', async () => {
    open();
    expect(screen.queryByTestId('tour-spotlight')).toBeNull();
    addAnchor('live');
    await waitFor(() => expect(screen.getByTestId('tour-spotlight')).toBeTruthy(), { timeout: 1500 });
  });

  it('announces each new step to screen readers', () => {
    open();
    key('ArrowRight');
    const live = card().querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Step 2 of 3. Movies, series and My List');
  });

  it('puts every transition and animation behind motion-safe (no motion under reduced motion)', () => {
    addAnchor('live');
    open();
    const layer = screen.getByTestId('tour');
    const tokens = Array.from(layer.querySelectorAll<HTMLElement>('*')).flatMap((el) =>
      typeof el.className === 'string' ? el.className.split(/\s+/) : [],
    );
    const moving = tokens.filter((t) => /(^|:)(transition|animate-|duration-|ease-)/.test(t));
    expect(moving.length).toBeGreaterThan(0);
    for (const t of moving) expect(t.startsWith('motion-safe:')).toBe(true);
  });
});
