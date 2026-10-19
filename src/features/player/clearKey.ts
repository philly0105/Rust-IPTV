/**
 * ClearKey DRM from an m3u channel's `#KODIPROP` licence (`Channel.clearKey`, set by the core
 * when `inputstream.adaptive.license_type` is ClearKey). Accepted forms, as IPTVnator accepts them:
 * `kid:key` pairs (hex or base64url, several separated by commas), a JSON map `{"<kid>":"<key>"}`,
 * a JWK set `{"keys":[{"kid":"…","k":"…"}]}`, or a licence server URL (Kodi's `url|headers|…`
 * form keeps the URL). Shaka takes the result for DASH; mpv can't, so such sources play in the
 * built-in player (`modeForSettings`).
 */

import type { PlayerDrm } from '@/api/types';

/** A 16-byte key or key id as lowercase hex, from hex (dashes allowed) or base64/base64url. */
function toHex(value: string): string | null {
  const v = value.trim();
  const hex = v.replace(/-/g, '');
  if (/^[0-9a-f]{32}$/i.test(hex)) return hex.toLowerCase();
  if (!/^[A-Za-z0-9+/_-]+=*$/.test(v)) return null;
  let bytes: string;
  try {
    const b64 = v.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    bytes = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  } catch {
    return null;
  }
  if (bytes.length !== 16) return null;
  return Array.from(bytes, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
}

function addKey(keys: Record<string, string>, kid: unknown, key: unknown): void {
  if (typeof kid !== 'string' || typeof key !== 'string') return;
  const k = toHex(kid);
  const v = toHex(key);
  if (k && v) keys[k] = v;
}

/** Shaka's ClearKey config for a licence, or undefined when it holds nothing usable. */
export function parseClearKey(licence: string | undefined): PlayerDrm | undefined {
  const text = licence?.trim();
  if (!text) return undefined;
  if (/^https?:\/\//i.test(text)) {
    const url = text.split('|')[0]?.trim();
    return url ? { licenseServer: url } : undefined;
  }
  const keys: Record<string, string> = {};
  if (text.startsWith('{')) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (!json || typeof json !== 'object') return undefined;
    const jwks = (json as { keys?: unknown }).keys;
    if (Array.isArray(jwks)) {
      for (const jwk of jwks) {
        if (jwk && typeof jwk === 'object') addKey(keys, (jwk as { kid?: unknown }).kid, (jwk as { k?: unknown }).k);
      }
    } else {
      for (const [kid, key] of Object.entries(json)) addKey(keys, kid, key);
    }
  } else {
    for (const pair of text.split(/[,;\s]+/)) {
      const i = pair.indexOf(':');
      if (i > 0) addKey(keys, pair.slice(0, i), pair.slice(i + 1));
    }
  }
  return Object.keys(keys).length > 0 ? { clearKeys: keys } : undefined;
}
