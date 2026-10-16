/**
 * public/theme-boot.js (L2-visual-6): index.html runs it before the first
 * paint, so a light or OLED user never sees the dark default flash on launch
 * or reload. CSP is script-src 'self', so it is an external file, not inline.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '..', '..', '..');
const BOOT = readFileSync(join(root, 'public', 'theme-boot.js'), 'utf8');
const INDEX = readFileSync(join(root, 'index.html'), 'utf8');
const TOKENS = readFileSync(join(root, 'src', 'styles', 'tokens.css'), 'utf8');

function bg(selector: string): string {
  const at = TOKENS.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  return /--color-bg:\s*(#[0-9a-f]{6})/i.exec(TOKENS.slice(at))![1]!.toLowerCase();
}

function boot({ prefersLight = false }: { prefersLight?: boolean } = {}) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('light') ? prefersLight : false, media: q }));
  new Function(BOOT)();
}

const html = document.documentElement;
const meta = () => document.querySelector('meta[name="theme-color"]')!.getAttribute('content');

beforeEach(() => {
  localStorage.clear();
  for (const a of ['data-theme', 'data-oled', 'data-accent', 'data-density']) html.removeAttribute(a);
  html.style.removeProperty('--ui-scale');
  document.head.innerHTML = '<meta name="theme-color" content="#0c1320" />';
  html.setAttribute('data-theme', 'dark');
});
afterEach(() => vi.unstubAllGlobals());

describe('theme boot script', () => {
  it('index.html loads it as an external blocking script in <head>, before the app module', () => {
    const head = INDEX.slice(0, INDEX.indexOf('</head>'));
    expect(head).toMatch(/<meta name="theme-color"[^>]*>[\s\S]*<script src="\/theme-boot\.js"><\/script>/);
    expect(INDEX.indexOf('/theme-boot.js')).toBeLessThan(INDEX.indexOf('type="module"'));
    // CSP script-src 'self': no inline script anywhere.
    expect(INDEX).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  });

  it('applies a saved light theme and its browser colour before the app loads', () => {
    localStorage.setItem('tsrust.theme', 'light');
    boot();
    expect(html.dataset['theme']).toBe('light');
    expect(meta()).toBe(bg(":root[data-theme='light']"));
  });

  it('resolves system against the OS: dark unless it asks for light', () => {
    boot();
    expect(html.dataset['theme']).toBe('dark');
    localStorage.setItem('tsrust.theme', 'system');
    boot({ prefersLight: true });
    expect(html.dataset['theme']).toBe('light');
  });

  it('turns OLED black on only while dark, with the appearance mirror applied', () => {
    localStorage.setItem('tsrust.theme', 'dark');
    localStorage.setItem('tsrust.appearance', JSON.stringify({ accent: 'teal', oledBlack: true, density: 'compact', uiScale: 9 }));
    boot();
    expect('oled' in html.dataset).toBe(true);
    expect(html.dataset['accent']).toBe('teal');
    expect(html.dataset['density']).toBe('compact');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.25');
    expect(meta()).toBe(bg(':root[data-oled]:not([data-theme=\'light\'])'));

    localStorage.setItem('tsrust.theme', 'light');
    html.removeAttribute('data-oled');
    boot();
    expect('oled' in html.dataset).toBe(false);
  });

  it('ignores a broken mirror and keeps the colour in step with later theme changes', async () => {
    localStorage.setItem('tsrust.appearance', '{not json');
    localStorage.setItem('tsrust.theme', 'bogus');
    boot();
    expect(html.dataset['theme']).toBe('dark');
    expect(meta()).toBe(bg(":root[data-theme='dark']"));
    html.setAttribute('data-theme', 'light');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(meta()).toBe(bg(":root[data-theme='light']"));
  });
});
