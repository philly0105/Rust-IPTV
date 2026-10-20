/**
 * One brand mark everywhere (audits SR-3, DS-BRAND-MARK, SH-brand-mismatch) and web metadata
 * that installs cleanly (SR-8, SH-pwa-manifest). The masters are docs/brand/*.svg; the inline
 * copies (BrandMark, the index.html boot splash) must draw the same shapes, the manifest and
 * index.html must point at icons that exist at the sizes they claim, and the icons that
 * launchers crop (maskable, apple-touch) must be opaque.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isKnownPath } from '@/routes';
import { BrandMark } from '@/ui/BrandMark';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ROOT = join(__dirname, '..', '..', '..');
const PUBLIC = join(ROOT, 'public');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');
const INDEX = new DOMParser().parseFromString(read('index.html'), 'text/html');
const MANIFEST = JSON.parse(read('public', 'manifest.webmanifest')) as {
  id?: string;
  description?: string;
  categories?: string[];
  icons: { src: string; sizes: string; purpose?: string }[];
  shortcuts: { name: string; url: string; icons: { src: string; sizes: string }[] }[];
};

function master(file: string): Element {
  return new DOMParser().parseFromString(read('docs', 'brand', file), 'image/svg+xml').documentElement;
}

/**
 * The drawing of an <svg>: its viewBox, then every element below it with its attributes, ids and
 * url(#id) references reduced to the name after the last '-' (BrandMark prefixes useId, the
 * splash `boot-`).
 */
function drawing(svg: Element): string[] {
  const name = (v: string) => v.replace(/url\(#(?:[^)]*-)?([a-z]+)\)/g, 'url(#$1)');
  const lines = [`viewBox=${svg.getAttribute('viewBox')}`];
  for (const el of svg.querySelectorAll('*')) {
    const attrs = [...el.attributes]
      .map((a) => `${a.name}=${a.name === 'id' ? a.value.replace(/^.*-/, '') : name(a.value)}`)
      .sort();
    lines.push(`${el.localName} ${attrs.join(' ')}`);
  }
  return lines;
}

/** Width, height and lowest alpha of an 8-bit, non-interlaced RGB or RGBA PNG in public/. */
function png(src: string): { width: number; height: number; minAlpha: number } {
  const buf = readFileSync(join(PUBLIC, src));
  expect(buf.toString('latin1', 1, 4), src).toBe('PNG');
  const [width, height, depth, type, interlace] = [buf.readUInt32BE(16), buf.readUInt32BE(20), buf[24], buf[25], buf[28]];
  expect([depth, interlace], src).toEqual([8, 0]);
  if (type === 2) return { width, height, minAlpha: 255 };
  expect(type, src).toBe(6);
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString('latin1', at + 4, at + 8) === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  let prev = new Uint8Array(stride);
  let minAlpha = 255;
  for (let at = 0; at < raw.length; at += stride + 1) {
    const filter = raw[at]!;
    const row = new Uint8Array(raw.subarray(at + 1, at + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? row[i - 4]! : 0;
      const b = prev[i]!;
      const c = i >= 4 ? prev[i - 4]! : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      row[i] = (row[i]! + [0, a, b, (a + b) >> 1, paeth][filter]!) & 255;
    }
    for (let i = 3; i < stride; i += 4) minAlpha = Math.min(minAlpha, row[i]!);
    prev = row;
  }
  return { width, height, minAlpha };
}

const square = (sizes: string) => {
  const [w, h] = sizes.split('x').map(Number);
  return { width: w, height: h };
};

describe('BrandMark', () => {
  it('is decorative unless it gets a title', () => {
    const { container } = render(<BrandMark />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    cleanup();
    render(<BrandMark title="Tsrust IPTV" size={48} />);
    const named = screen.getByRole('img', { name: 'Tsrust IPTV' });
    expect([named.getAttribute('width'), named.getAttribute('height')]).toEqual(['48', '48']);
  });

  it('draws docs/brand/mark.svg in colour and docs/brand/mark-mono.svg in mono', () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark variant="mono" />
      </>,
    );
    const [color, mono] = container.querySelectorAll('svg');
    expect(drawing(color!)).toEqual(drawing(master('mark.svg')));
    expect(drawing(mono!)).toEqual(drawing(master('mark-mono.svg')));
    expect(mono!.getAttribute('stroke')).toBe('currentColor');
  });

  it('gives each instance its own gradient ids, and every reference stays inside its own svg', () => {
    const { container } = render(
      <>
        <BrandMark />
        <BrandMark />
      </>,
    );
    const ids = [...container.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
    for (const svg of container.querySelectorAll('svg')) {
      const own = new Set([...svg.querySelectorAll('[id]')].map((el) => el.id));
      const refs = [...svg.outerHTML.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]!);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(own.has(ref), ref).toBe(true);
    }
  });
});

describe('index.html', () => {
  it('links the favicon, apple-touch-icon and manifest that exist in public/', () => {
    const hrefs = [...INDEX.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')].map(
      (l) => l.getAttribute('href')!,
    );
    expect(hrefs).toEqual(['/icons/favicon-32.png', '/icons/favicon.svg', '/icons/apple-touch-icon.png', '/manifest.webmanifest']);
    for (const href of hrefs) expect(() => readFileSync(join(PUBLIC, href)), href).not.toThrow();
    expect(png('/icons/favicon-32.png')).toMatchObject({ width: 32, height: 32 });
    expect(read('public', 'icons', 'favicon.svg')).toBe(read('docs', 'brand', 'mark.svg'));
    // iOS fills transparent corners with black, then rounds them itself.
    expect(png('/icons/apple-touch-icon.png')).toEqual({ width: 180, height: 180, minAlpha: 255 });
  });

  it('describes the app to users, not its implementation', () => {
    const description = INDEX.querySelector('meta[name="description"]')!.getAttribute('content')!;
    expect(description).toBe(MANIFEST.description);
    expect(description).not.toMatch(/\brust\b/i);
  });

  it('has a theme-color for each OS scheme, matching the theme backgrounds in tokens.css', () => {
    const tokens = read('src', 'styles', 'tokens.css');
    const bg = (selector: string) => /--color-bg:\s*(#[0-9a-f]{6})/i.exec(tokens.slice(tokens.indexOf(`${selector} {`)))![1]!.toLowerCase();
    const metas = [...INDEX.querySelectorAll('meta[name="theme-color"]')].map((m) => [m.getAttribute('media'), m.getAttribute('content')]);
    expect(metas).toEqual([
      ['(prefers-color-scheme: dark)', bg(":root[data-theme='dark']")],
      ['(prefers-color-scheme: light)', bg(":root[data-theme='light']")],
    ]);
  });

  it('paints a static splash of the mark inside #root, styled by attributes only', () => {
    const splash = INDEX.querySelector('#root > [data-boot-splash]')!;
    expect(splash).not.toBeNull();
    expect(splash.textContent).toContain('Tsrust IPTV');
    expect(drawing(splash.querySelector('svg')!)).toEqual(drawing(master('mark.svg')));
    expect(splash.getAttribute('style')).toContain('var(--color-bg');
    // Tauri adds a nonce to style-src for every <style> element, which would switch off
    // 'unsafe-inline' and with it every style attribute in the app.
    expect(INDEX.querySelectorAll('style')).toHaveLength(0);
  });
});

describe('theme-boot.js and the two theme-color metas', () => {
  const BOOT = read('public', 'theme-boot.js');

  it('writes the theme the user chose into both, whatever the OS scheme', async () => {
    document.head.innerHTML =
      '<meta name="theme-color" content="#0c1320" media="(prefers-color-scheme: dark)" />' +
      '<meta name="theme-color" content="#edf0f5" media="(prefers-color-scheme: light)" />';
    const html = document.documentElement;
    html.setAttribute('data-theme', 'dark');
    localStorage.setItem('tsrust.theme', 'light');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q }));
    new Function(BOOT)();
    const contents = () => [...document.querySelectorAll('meta[name="theme-color"]')].map((m) => m.getAttribute('content'));
    expect(contents()).toEqual(['#edf0f5', '#edf0f5']);

    html.setAttribute('data-theme', 'dark');
    await new Promise((r) => setTimeout(r, 0));
    expect(contents()).toEqual(['#0c1320', '#0c1320']);
    localStorage.clear();
  });
});

describe('manifest.webmanifest', () => {
  it('has an id, a user-facing description and categories', () => {
    expect(MANIFEST.id).toBe('/');
    expect(MANIFEST.description).toMatch(/M3U/);
    expect(MANIFEST.categories).toContain('entertainment');
  });

  it('lists icons that exist at their stated sizes, with an opaque maskable one', () => {
    for (const icon of MANIFEST.icons) expect(png(icon.src), icon.src).toMatchObject(square(icon.sizes));
    expect(MANIFEST.icons.filter((i) => (i.purpose ?? 'any').split(' ').includes('any')).map((i) => i.sizes)).toEqual(['192x192', '512x512']);
    const maskable = MANIFEST.icons.find((i) => i.purpose === 'maskable')!;
    expect(maskable.sizes).toBe('512x512');
    expect(png(maskable.src).minAlpha).toBe(255);
  });

  it('has shortcuts to real routes, each with a 96 px icon', () => {
    expect(MANIFEST.shortcuts.map((s) => s.url)).toEqual(['/epg', '/search', '/favorites']);
    for (const shortcut of MANIFEST.shortcuts) {
      expect(isKnownPath(shortcut.url), shortcut.url).toBe(true);
      for (const icon of shortcut.icons) expect(png(icon.src), icon.src).toMatchObject(square(icon.sizes));
    }
  });
});
