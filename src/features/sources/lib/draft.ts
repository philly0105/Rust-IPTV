/**
 * Form model for the Add / Edit source dialogs and the pure conversion into
 * the exact `sources.add` / `sources.update` payloads (SPEC C4).
 */

import type { SourcePatch, SourcesAddArgs, M3uAddInput } from '@/api/rpc';
import type {
  M3uOrigin,
  M3uSourceConfig,
  RequestHeaders,
  Source,
  SourceKind,
  StalkerSourceConfig,
  XtreamSourceConfig,
} from '@/api/types';

import {
  checkHeaderValue,
  checkHttpUrl,
  checkOrigin,
  normalizeMac,
  normalizeXtreamServer,
} from './validate';

export interface HeadersDraft {
  userAgent: string;
  referrer: string;
  origin: string;
}

export interface M3uDraft {
  origin: M3uOrigin;
  url: string;
  /** Desktop: absolute path chosen through the native dialog. */
  filePath: string;
  /** Web: text read from an `<input type=file>`; `fileName` is for display. */
  fileText: string;
  fileName: string;
  text: string;
  headers: HeadersDraft;
}

export interface XtreamDraft {
  serverUrl: string;
  username: string;
  password: string;
}

export interface StalkerDraft {
  portalUrl: string;
  macAddress: string;
  isFullPortal: boolean;
  username: string;
  password: string;
  headers: HeadersDraft;
  serialNumber: string;
  deviceId1: string;
  deviceId2: string;
  signature1: string;
  signature2: string;
}

export interface SourceDraft {
  kind: SourceKind;
  name: string;
  autoRefresh: boolean;
  m3u: M3uDraft;
  xtream: XtreamDraft;
  stalker: StalkerDraft;
}

/** Field path -> i18n key in the `sources` namespace. */
export type DraftErrors = Partial<Record<string, string>>;

export const emptyHeaders = (): HeadersDraft => ({ userAgent: '', referrer: '', origin: '' });

export function emptyDraft(kind: SourceKind = 'm3u'): SourceDraft {
  return {
    kind,
    name: '',
    autoRefresh: false,
    m3u: { origin: 'url', url: '', filePath: '', fileText: '', fileName: '', text: '', headers: emptyHeaders() },
    xtream: { serverUrl: '', username: '', password: '' },
    stalker: {
      portalUrl: '',
      macAddress: '',
      isFullPortal: false,
      username: '',
      password: '',
      headers: emptyHeaders(),
      serialNumber: '',
      deviceId1: '',
      deviceId2: '',
      signature1: '',
      signature2: '',
    },
  };
}

function headersDraftFrom(h: RequestHeaders | undefined): HeadersDraft {
  return { userAgent: h?.userAgent ?? '', referrer: h?.referrer ?? '', origin: h?.origin ?? '' };
}

/** Builds an edit draft from a stored source. Secrets are kept as stored. */
export function draftFromSource(s: Source): SourceDraft {
  const d = emptyDraft(s.kind);
  d.name = s.name;
  d.autoRefresh = s.autoRefresh;
  if (s.m3u) {
    d.m3u = {
      ...d.m3u,
      origin: s.m3u.origin,
      url: s.m3u.url ?? '',
      filePath: s.m3u.filePath ?? '',
      headers: headersDraftFrom(s.m3u.headers),
    };
  }
  if (s.xtream) d.xtream = { ...s.xtream };
  if (s.stalker) {
    const st = s.stalker;
    d.stalker = {
      portalUrl: st.portalUrl,
      macAddress: st.macAddress,
      isFullPortal: st.isFullPortal,
      username: st.username ?? '',
      password: st.password ?? '',
      headers: headersDraftFrom(st.headers),
      serialNumber: st.serialNumber ?? '',
      deviceId1: st.deviceId1 ?? '',
      deviceId2: st.deviceId2 ?? '',
      signature1: st.signature1 ?? '',
      signature2: st.signature2 ?? '',
    };
  }
  return d;
}

/** Only non-empty trimmed header values; validation errors go into `errors`. */
function buildHeaders(h: HeadersDraft, prefix: string, errors: DraftErrors): RequestHeaders {
  const out: RequestHeaders = {};
  const ua = h.userAgent.trim();
  const ref = h.referrer.trim();
  const origin = h.origin.trim();
  const uaErr = checkHeaderValue(ua);
  if (uaErr) errors[`${prefix}.userAgent`] = uaErr;
  else if (ua) out.userAgent = ua;
  if (ref) {
    const r = checkHttpUrl(ref);
    if (!r.ok) errors[`${prefix}.referrer`] = 'errorReferrer';
    else out.referrer = ref;
  }
  const oErr = checkOrigin(origin);
  if (oErr) errors[`${prefix}.origin`] = oErr;
  else if (origin) out.origin = origin.replace(/\/$/, '');
  return out;
}

/** Structural equality that ignores key order and treats missing, empty-string and empty-object the same. */
export function sameConfig(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v).sort()) {
        const val = (v as Record<string, unknown>)[k];
        if (val === undefined || val === null || val === '') continue;
        const n = norm(val);
        if (n && typeof n === 'object' && !Array.isArray(n) && Object.keys(n).length === 0) continue;
        out[k] = n;
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

const hasAny = (h: RequestHeaders): boolean => Object.keys(h).length > 0;

/** Removes line breaks a paste can carry; keeps inner spaces. */
const clean = (v: string): string => v.replace(/[\r\n]+/g, '').trim();
const cleanSecret = (v: string): string => v.replace(/[\r\n]+/g, '');

export interface BuildContext {
  isDesktop: boolean;
}

function buildM3u(d: M3uDraft, ctx: BuildContext, errors: DraftErrors): M3uAddInput | undefined {
  const headers = buildHeaders(d.headers, 'm3u.headers', errors);
  const withHeaders = (o: M3uAddInput): M3uAddInput => (hasAny(headers) ? { ...o, headers } : o);
  switch (d.origin) {
    case 'url': {
      const r = checkHttpUrl(d.url);
      if (!r.ok) {
        errors['m3u.url'] = r.error;
        return undefined;
      }
      return withHeaders({ origin: 'url', url: r.url });
    }
    case 'file': {
      // Desktop: the core reads the file by path. Web: the server cannot see the
      // browser's disk, so the file's text is sent with origin 'text'.
      if (ctx.isDesktop && d.filePath) return withHeaders({ origin: 'file', filePath: d.filePath });
      if (d.fileText) return withHeaders({ origin: 'text', text: d.fileText });
      errors['m3u.file'] = 'errorFileRequired';
      return undefined;
    }
    case 'text': {
      if (!d.text.trim()) {
        errors['m3u.text'] = 'errorRequired';
        return undefined;
      }
      if (!/#EXT(M3U|INF)/i.test(d.text) && !/^https?:\/\//im.test(d.text)) {
        errors['m3u.text'] = 'errorNotM3u';
        return undefined;
      }
      return withHeaders({ origin: 'text', text: d.text });
    }
  }
}

function buildXtream(d: XtreamDraft, errors: DraftErrors): XtreamSourceConfig | undefined {
  const server = normalizeXtreamServer(d.serverUrl);
  if (!server.ok) errors['xtream.serverUrl'] = server.error;
  const username = clean(d.username);
  if (!username) errors['xtream.username'] = 'errorRequired';
  const password = cleanSecret(d.password);
  if (!password) errors['xtream.password'] = 'errorRequired';
  if (!server.ok || !username || !password) return undefined;
  return { serverUrl: server.url, username, password };
}

function buildStalker(d: StalkerDraft, errors: DraftErrors, grandfatheredMac?: string): StalkerSourceConfig | undefined {
  const portal = checkHttpUrl(d.portalUrl);
  if (!portal.ok) errors['stalker.portalUrl'] = portal.error;
  let mac: string | null = null;
  if (!d.macAddress.trim()) errors['stalker.macAddress'] = 'errorRequired';
  else if (grandfatheredMac !== undefined && d.macAddress === grandfatheredMac) mac = grandfatheredMac;
  else {
    mac = normalizeMac(d.macAddress);
    if (!mac) errors['stalker.macAddress'] = 'errorMac';
  }
  const headers = buildHeaders(d.headers, 'stalker.headers', errors);
  if (!portal.ok || !mac) return undefined;
  const cfg: StalkerSourceConfig = { portalUrl: portal.url, macAddress: mac, isFullPortal: d.isFullPortal, headers };
  const optional = {
    username: clean(d.username),
    password: cleanSecret(d.password),
    serialNumber: clean(d.serialNumber),
    deviceId1: clean(d.deviceId1),
    deviceId2: clean(d.deviceId2),
    signature1: clean(d.signature1),
    signature2: clean(d.signature2),
  } as const;
  for (const [k, v] of Object.entries(optional) as [keyof typeof optional, string][]) {
    if (v) cfg[k] = v;
  }
  return cfg;
}

export type BuildResult<T> = { ok: true; value: T; errors: DraftErrors } | { ok: false; errors: DraftErrors };

/** Validates a draft and produces the exact `sources.add` args. */
export function buildAddArgs(draft: SourceDraft, ctx: BuildContext): BuildResult<SourcesAddArgs> {
  const errors: DraftErrors = {};
  const name = clean(draft.name);
  if (!name) errors.name = 'errorRequired';
  else if (name.length > 120) errors.name = 'errorNameTooLong';

  const args: SourcesAddArgs = { kind: draft.kind, name, autoRefresh: draft.autoRefresh };
  if (draft.kind === 'm3u') {
    const m3u = buildM3u(draft.m3u, ctx, errors);
    if (m3u) {
      args.m3u = m3u;
      // Pasted or uploaded text has nothing to refetch.
      if (m3u.origin === 'text') args.autoRefresh = false;
    }
  } else if (draft.kind === 'xtream') {
    const x = buildXtream(draft.xtream, errors);
    if (x) args.xtream = x;
  } else {
    const s = buildStalker(draft.stalker, errors);
    if (s) args.stalker = s;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: args, errors };
}

/** Connection config only (for `xtream.test` / `stalker.test`). */
export function buildXtreamConfig(d: XtreamDraft): BuildResult<XtreamSourceConfig> {
  const errors: DraftErrors = {};
  const v = buildXtream(d, errors);
  return v ? { ok: true, value: v, errors } : { ok: false, errors };
}

export function buildStalkerConfig(d: StalkerDraft, grandfatheredMac?: string): BuildResult<StalkerSourceConfig> {
  const errors: DraftErrors = {};
  const v = buildStalker(d, errors, grandfatheredMac);
  return v && Object.keys(errors).length === 0 ? { ok: true, value: v, errors } : { ok: false, errors };
}

/**
 * Validates an edit and produces the `sources.update` patch containing only
 * what changed. A stored MAC that predates validation stays accepted verbatim.
 */
export function buildUpdatePatch(source: Source, draft: SourceDraft, ctx: BuildContext): BuildResult<SourcePatch> {
  const errors: DraftErrors = {};
  const patch: SourcePatch = {};
  const name = clean(draft.name);
  if (!name) errors.name = 'errorRequired';
  else if (name.length > 120) errors.name = 'errorNameTooLong';
  else if (name !== source.name) patch.name = name;
  if (draft.autoRefresh !== source.autoRefresh) patch.autoRefresh = draft.autoRefresh;

  if (source.kind === 'm3u' && source.m3u) {
    const headers = buildHeaders(draft.m3u.headers, 'm3u.headers', errors);
    const next: M3uSourceConfig = { ...source.m3u, headers };
    if (source.m3u.origin === 'url') {
      const r = checkHttpUrl(draft.m3u.url);
      if (!r.ok) errors['m3u.url'] = r.error;
      else next.url = r.url;
    } else if (source.m3u.origin === 'file' && ctx.isDesktop && draft.m3u.filePath) {
      next.filePath = draft.m3u.filePath;
    }
    if (!sameConfig(next, source.m3u)) patch.m3u = next;
  } else if (source.kind === 'xtream') {
    const x = buildXtream(draft.xtream, errors);
    if (x && !sameConfig(x, source.xtream)) patch.xtream = x;
  } else if (source.kind === 'stalker') {
    const s = buildStalker(draft.stalker, errors, source.stalker?.macAddress);
    if (s && !sameConfig(s, source.stalker)) patch.stalker = s;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: patch, errors };
}

/**
 * True when the patch changes how the catalog is fetched (a refresh is advisable). Pass the
 * source as it was before the edit: M3U request headers apply at play time, so a header-only
 * edit needs no refresh, and a pasted playlist (`origin: 'text'`) cannot refresh at all.
 */
export function patchNeedsRefresh(patch: SourcePatch, before?: Pick<Source, 'm3u'>): boolean {
  if (patch.xtream !== undefined || patch.stalker !== undefined) return true;
  const m3u = patch.m3u;
  if (m3u === undefined) return false;
  if ((m3u.origin ?? before?.m3u?.origin) === 'text') return false;
  if (!before?.m3u) return true;
  return !sameConfig({ ...m3u, headers: undefined }, { ...before.m3u, headers: undefined });
}
