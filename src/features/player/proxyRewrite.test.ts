import { describe, expect, it } from 'vitest';

import { proxyRewrite, proxyRoute, unproxiedUrl } from './engines';

const app = window.location.origin;
const upstream = 'http://cdn.example:8080/live/d/stream.mpd?tok=1';
const q = (u: string): URLSearchParams => new URLSearchParams(u.split('?').slice(1).join('?'));
const webLoad = `/api/proxy?${new URLSearchParams({ url: upstream, sourceId: 's1', ua: 'DashUA/1', referer: 'http://r.example/', origin: 'http://o.example' })}`;
const desktopBase = 'http://127.0.0.1:5555/9f8e7d6c/api/proxy';
const desktopLoad = `${desktopBase}?${new URLSearchParams({ url: upstream, sourceId: 's1', ua: 'DashUA/1' })}`;

describe('proxyRewrite', () => {
  it('is null for a direct load', () => {
    expect(proxyRewrite('http://cdn.example/a.mpd')).toBeNull();
    expect(proxyRewrite('/api/files/3')).toBeNull();
  });

  it('routes a relative segment resolved against the web proxy URL to the upstream, with header params', () => {
    const rw = proxyRewrite(webLoad)!;
    // What shaka produced before the fix: `chunk-v1-1.m4s` resolved against `/api/proxy?...`.
    const out = rw(`${app}/api/chunk-v1-1.m4s`);
    expect(out.startsWith('/api/proxy?')).toBe(true);
    const p = q(out);
    expect(p.get('url')).toBe('http://cdn.example:8080/live/d/chunk-v1-1.m4s');
    expect(p.get('sourceId')).toBe('s1');
    expect(p.get('ua')).toBe('DashUA/1');
    expect(p.get('referer')).toBe('http://r.example/');
    expect(p.get('origin')).toBe('http://o.example');
    // A bare relative URI resolves against the upstream manifest too.
    expect(q(rw('init-v1.mp4')).get('url')).toBe('http://cdn.example:8080/live/d/init-v1.mp4');
  });

  it('routes a relative segment resolved against the desktop token base through that base', () => {
    const rw = proxyRewrite(desktopLoad)!;
    const out = rw('http://127.0.0.1:5555/9f8e7d6c/api/init-v1.mp4');
    expect(out.startsWith(`${desktopBase}?`)).toBe(true);
    expect(q(out).get('url')).toBe('http://cdn.example:8080/live/d/init-v1.mp4');
    expect(q(out).get('ua')).toBe('DashUA/1');
    expect(q(out).get('sourceId')).toBe('s1');
  });

  it('routes absolute segment and key URLs through the proxy with the header params', () => {
    for (const load of [webLoad, desktopLoad]) {
      const rw = proxyRewrite(load)!;
      const seg = rw('https://edge.example/seg/42.m4s?x=1&y=2');
      expect(q(seg).get('url')).toBe('https://edge.example/seg/42.m4s?x=1&y=2');
      expect(q(seg).get('ua')).toBe('DashUA/1');
      const key = rw('https://keys.example/k/7');
      expect(q(key).get('url')).toBe('https://keys.example/k/7');
      expect(q(key).get('sourceId')).toBe('s1');
    }
  });

  it('leaves URLs already on the proxy route, app URLs and non-http URLs alone', () => {
    const web = proxyRewrite(webLoad)!;
    const routed = `${app}/api/proxy?url=http%3A%2F%2Fcdn.example%2Fs.ts&sourceId=s1`;
    expect(web(routed)).toBe(routed);
    expect(web('/api/proxy?url=x')).toBe('/api/proxy?url=x');
    expect(web(`${app}/api/files/3`)).toBe(`${app}/api/files/3`);
    expect(web(`${app}/assets/logo.png`)).toBe(`${app}/assets/logo.png`);
    expect(web('blob:abc')).toBe('blob:abc');
    const desk = proxyRewrite(desktopLoad)!;
    const deskRouted = `${desktopBase}?url=http%3A%2F%2Fcdn.example%2Fs.ts`;
    expect(desk(deskRouted)).toBe(deskRouted);
  });
});

describe('unproxiedUrl', () => {
  it('maps the manifest response URI back to the upstream so relative URIs resolve there', () => {
    const web = proxyRoute(webLoad)!;
    expect(unproxiedUrl(web, `${app}${webLoad}`)).toBe(upstream);
    const desk = proxyRoute(desktopLoad)!;
    expect(unproxiedUrl(desk, desktopLoad)).toBe(upstream);
    expect(unproxiedUrl(desk, 'http://cdn.example/other.mpd')).toBe('http://cdn.example/other.mpd');
    expect(new URL('../seg/1.m4s', unproxiedUrl(web, webLoad)).href).toBe('http://cdn.example:8080/live/seg/1.m4s');
  });
});
