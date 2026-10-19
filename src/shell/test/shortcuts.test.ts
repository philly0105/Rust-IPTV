import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isActivationTarget, isArrowTarget, shortcutRegistry } from '../shortcuts';

const opts = { description: 'test', area: 'Test' };

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
}

function mount<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  return el;
}

beforeEach(() => shortcutRegistry.reset());
afterEach(() => {
  shortcutRegistry.reset();
  document.body.replaceChildren();
});

describe('shortcut dispatch', () => {
  it('queries the DOM for an open modal only once a shortcut a modal would block matches (SH-7)', () => {
    const query = vi.spyOn(document, 'querySelector');
    const seen: string[] = [];
    shortcutRegistry.register('k', () => seen.push('k'), opts);
    shortcutRegistry.register('mod+s', () => seen.push('mod+s'), opts);
    press(document.body, 'ArrowDown', { code: 'ArrowDown' });
    press(document.body, 'ArrowDown', { code: 'ArrowDown', repeat: true });
    // A mod combo fires in a modal anyway, so it needs no lookup either.
    press(document.body, 's', { code: 'KeyS', ctrlKey: true });
    expect(query.mock.calls.filter(([sel]) => sel === '[aria-modal="true"]')).toHaveLength(0);
    press(document.body, 'k', { code: 'KeyK' });
    expect(query.mock.calls.filter(([sel]) => sel === '[aria-modal="true"]')).toHaveLength(1);
    expect(seen).toEqual(['mod+s', 'k']);
    // An open modal still blocks it.
    mount('div', { 'aria-modal': 'true' });
    press(document.body, 'k', { code: 'KeyK' });
    expect(seen).toEqual(['mod+s', 'k']);
  });

  it('prevents the browser default before the handler runs', () => {
    const seen: boolean[] = [];
    shortcutRegistry.register('space', (e) => seen.push(e.defaultPrevented), opts);
    const e = press(document.body, ' ', { code: 'Space' });
    expect(seen).toEqual([true]);
    expect(e.defaultPrevented).toBe(true);
  });

  it('still prevents the default when the handler throws', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    shortcutRegistry.register(
      'f11',
      () => {
        throw new Error('boom');
      },
      opts,
    );
    const e = press(document.body, 'F11');
    expect(e.defaultPrevented).toBe(true);
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('claims `/` and mod+f so quick find never opens', () => {
    const slash = vi.fn();
    const find = vi.fn();
    shortcutRegistry.register('/', slash, opts);
    shortcutRegistry.register('mod+f', find, opts);
    expect(press(document.body, '/', { code: 'Slash' }).defaultPrevented).toBe(true);
    expect(press(document.body, 'f', { code: 'KeyF', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(slash).toHaveBeenCalledOnce();
    expect(find).toHaveBeenCalledOnce();
  });

  it('stops propagation of a handled key', () => {
    shortcutRegistry.register('k', () => {}, opts);
    const e = new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true });
    const stop = vi.spyOn(e, 'stopPropagation');
    document.body.dispatchEvent(e);
    expect(stop).toHaveBeenCalledOnce();
  });

  it('leaves unmatched keys and their defaults alone', () => {
    shortcutRegistry.register('k', vi.fn(), opts);
    const e = press(document.body, 'j', { code: 'KeyJ' });
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores keys a widget already claimed', () => {
    const fn = vi.fn();
    shortcutRegistry.register('escape', fn, opts);
    const el = mount('div');
    el.addEventListener('keydown', (e) => e.preventDefault());
    press(el, 'Escape');
    expect(fn).not.toHaveBeenCalled();
  });

  it('calls the newest registration only', () => {
    const older = vi.fn();
    const newer = vi.fn();
    shortcutRegistry.register('m', older, opts);
    const off = shortcutRegistry.register('m', newer, opts);
    press(document.body, 'm', { code: 'KeyM' });
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
    off();
    press(document.body, 'm', { code: 'KeyM' });
    expect(older).toHaveBeenCalledOnce();
  });
});

describe('shortcuts while typing', () => {
  it.each([
    ['input', () => mount('input', { type: 'text' })],
    ['textarea', () => mount('textarea')],
    [
      'contenteditable',
      () => {
        const el = mount('div', { contenteditable: 'true' });
        // jsdom does not compute isContentEditable from the attribute.
        Object.defineProperty(el, 'isContentEditable', { value: true });
        return el;
      },
    ],
  ])('ignores plain shortcuts in %s and keeps the typed key', (_name, make) => {
    const fn = vi.fn();
    shortcutRegistry.register('space', fn, opts);
    shortcutRegistry.register('/', fn, opts);
    const el = make();
    const e1 = press(el, ' ', { code: 'Space' });
    const e2 = press(el, '/', { code: 'Slash' });
    expect(fn).not.toHaveBeenCalled();
    expect(e1.defaultPrevented).toBe(false);
    expect(e2.defaultPrevented).toBe(false);
  });

  it('fires allowInInput and global shortcuts while typing', () => {
    const palette = vi.fn();
    const global = vi.fn();
    shortcutRegistry.register('mod+k', palette, { ...opts, allowInInput: true });
    shortcutRegistry.register('f1', global, { ...opts, global: true });
    const input = mount('input', { type: 'search' });
    expect(press(input, 'k', { code: 'KeyK', ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(input, 'F1').defaultPrevented).toBe(true);
    expect(palette).toHaveBeenCalledOnce();
    expect(global).toHaveBeenCalledOnce();
  });

  it('falls through to an older registration that allows input', () => {
    const page = vi.fn();
    const shell = vi.fn();
    shortcutRegistry.register('escape', shell, { ...opts, allowInInput: true });
    shortcutRegistry.register('escape', page, opts);
    press(mount('input'), 'Escape');
    expect(page).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledOnce();
  });
});

describe('shortcuts and focused controls', () => {
  it('lets Space and Enter activate a focused button', () => {
    const fn = vi.fn();
    shortcutRegistry.register('space', fn, opts);
    shortcutRegistry.register('enter', fn, opts);
    const btn = mount('button');
    expect(press(btn, ' ', { code: 'Space' }).defaultPrevented).toBe(false);
    expect(press(btn, 'Enter').defaultPrevented).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it('still fires letter shortcuts with a button focused', () => {
    const fn = vi.fn();
    shortcutRegistry.register('k', fn, opts);
    press(mount('button'), 'k', { code: 'KeyK' });
    expect(fn).toHaveBeenCalledOnce();
  });

  it('lets arrows adjust a focused slider', () => {
    const fn = vi.fn();
    shortcutRegistry.register('arrowup', fn, opts);
    const range = mount('input', { type: 'range' });
    expect(press(range, 'ArrowUp').defaultPrevented).toBe(false);
    expect(press(mount('div', { role: 'slider', tabindex: '0' }), 'ArrowUp').defaultPrevented).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    press(document.body, 'ArrowUp');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('classifies targets', () => {
    expect(isActivationTarget(mount('a', { href: '#' }))).toBe(true);
    expect(isActivationTarget(mount('a'))).toBe(false);
    expect(isActivationTarget(mount('div', { role: 'option' }))).toBe(true);
    expect(isActivationTarget(mount('div'))).toBe(false);
    expect(isArrowTarget(mount('select'))).toBe(true);
    expect(isArrowTarget(mount('input', { type: 'text' }))).toBe(false);
    expect(isArrowTarget(mount('input', { type: 'radio' }))).toBe(true);
    expect(isArrowTarget(mount('div', { role: 'radio' }))).toBe(true);
    expect(isArrowTarget(mount('div', { role: 'tab' }))).toBe(true);
    expect(isArrowTarget(mount('div', { role: 'option' }))).toBe(true);
    expect(isArrowTarget(mount('div', { role: 'listitem' }))).toBe(false);
    expect(isArrowTarget(mount('button'))).toBe(false);
  });

  it('leaves arrows and Page keys to a focused native radio group', () => {
    const fn = vi.fn();
    shortcutRegistry.register('arrowdown', fn, opts);
    shortcutRegistry.register('pagedown', fn, opts);
    const radio = mount('input', { type: 'radio', name: 'g' });
    expect(press(radio, 'ArrowDown').defaultPrevented).toBe(false);
    expect(press(radio, 'PageDown').defaultPrevented).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('shortcut conditions and priority', () => {
  it('skips an entry whose `when` says no, leaving the key to an older entry or the browser', () => {
    const older = vi.fn();
    const scoped = vi.fn();
    let ok = false;
    shortcutRegistry.register('space', older, opts);
    shortcutRegistry.register('space', scoped, { ...opts, when: () => ok });
    press(document.body, ' ', { code: 'Space' });
    expect(older).toHaveBeenCalledOnce();
    expect(scoped).not.toHaveBeenCalled();
    ok = true;
    press(document.body, ' ', { code: 'Space' });
    expect(scoped).toHaveBeenCalledOnce();

    shortcutRegistry.reset();
    shortcutRegistry.register('arrowdown', scoped, { ...opts, when: () => false });
    expect(press(document.body, 'ArrowDown').defaultPrevented).toBe(false);
  });

  it('lets a higher priority win over a newer registration', () => {
    const page = vi.fn();
    const playback = vi.fn();
    shortcutRegistry.register('l', page, { ...opts, priority: 1 });
    shortcutRegistry.register('l', playback, opts);
    press(document.body, 'l', { code: 'KeyL' });
    expect(page).toHaveBeenCalledOnce();
    expect(playback).not.toHaveBeenCalled();
  });
});

describe('shortcuts in modals', () => {
  it('only lets escape and opted-in shortcuts through, mod combos included', () => {
    mount('div', { 'aria-modal': 'true' });
    const plain = vi.fn();
    const opted = vi.fn();
    const mod = vi.fn();
    const escape = vi.fn();
    shortcutRegistry.register('m', plain, opts);
    shortcutRegistry.register('f', opted, { ...opts, allowInModal: true });
    shortcutRegistry.register('mod+r', mod, opts);
    shortcutRegistry.register('escape', escape, opts);
    expect(press(document.body, 'm', { code: 'KeyM' }).defaultPrevented).toBe(false);
    press(document.body, 'f', { code: 'KeyF' });
    expect(press(document.body, 'r', { code: 'KeyR', ctrlKey: true }).defaultPrevented).toBe(false);
    press(document.body, 'Escape');
    expect(plain).not.toHaveBeenCalled();
    expect(opted).toHaveBeenCalledOnce();
    expect(mod).not.toHaveBeenCalled();
    expect(escape).toHaveBeenCalledOnce();
  });
});
