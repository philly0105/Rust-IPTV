import type { SourceKind } from '@/api/types';

/** Route that opens the Add Source dialog, optionally prefilled. */
export function addSourceHref(opts: { url?: string; kind?: SourceKind } = {}): string {
  const p = new URLSearchParams();
  p.set('add', opts.url ?? '');
  if (opts.kind) p.set('kind', opts.kind);
  return `/sources?${p.toString()}`;
}

/**
 * Maps an `iptv://` deep link to an in-app path, or null when it is not an add request.
 * Accepted shapes: `iptv://add?url=<enc>[&kind=m3u|xtream|stalker]` and
 * `iptv://add/<encoded url>`. Only http(s) targets are allowed.
 */
export function addSourcePathFromDeepLink(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== 'iptv:') return null;
  // `iptv://add?...` parses with host "add"; `iptv:add?...` with pathname "add".
  const verb = (u.host || u.pathname.replace(/^\/+/, '').split('/')[0] || '').toLowerCase();
  if (verb !== 'add') return null;
  let target = u.searchParams.get('url') ?? '';
  if (!target) {
    const rest = (u.host ? u.pathname : u.pathname.replace(/^\/*add/i, '')).replace(/^\/+/, '');
    target = rest ? decodeURIComponent(rest) : '';
  }
  if (target && !/^https?:\/\//i.test(target)) return null;
  const kind = u.searchParams.get('kind');
  const k = kind === 'm3u' || kind === 'xtream' || kind === 'stalker' ? kind : undefined;
  return addSourceHref({ url: target || undefined, kind: k });
}
