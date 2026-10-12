import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTINGS, type Settings } from '@/api/types';

import { inspectBackup } from '../lib/backup';
import {
  addEpgUrl,
  applyPatch,
  optionalStringPatch,
  railsPatch,
  remotePatch,
  revertPatch,
  tmdbPatch,
  validateArgs,
  validatePort,
} from '../lib/patch';

const base = (): Settings => structuredClone(DEFAULT_SETTINGS);

describe('settings patch shape', () => {
  it('sends the whole dashboardRails object with one rail changed', () => {
    const s = base();
    const p = railsPatch(s, 'hero', !s.dashboardRails.hero);
    expect(Object.keys(p)).toEqual(['dashboardRails']);
    expect(p.dashboardRails).toEqual({ ...s.dashboardRails, hero: !s.dashboardRails.hero });
  });

  it('sends the whole tmdb object and clears an empty key with null (merge patch)', () => {
    const s = base();
    s.tmdb = { ...s.tmdb, apiKey: 'abc', language: 'de-DE' };
    const p = tmdbPatch(s, { apiKey: '', enabled: true });
    expect(Object.keys(p)).toEqual(['tmdb']);
    // Left out, the core would keep the stored key; null removes it (B6-D27).
    expect(p.tmdb).toEqual({ ...s.tmdb, enabled: true, apiKey: null });
  });

  it('sends the whole remoteControl object', () => {
    const s = base();
    const p = remotePatch(s, { port: 9001 });
    expect(p).toEqual({ remoteControl: { ...s.remoteControl, port: 9001 } });
  });

  it('clears optional paths with an empty string and trims values', () => {
    expect(optionalStringPatch('mpvPath', '  C:\\mpv\\mpv.exe  ')).toEqual({ mpvPath: 'C:\\mpv\\mpv.exe' });
    expect(optionalStringPatch('vlcPath', '   ')).toEqual({ vlcPath: '' });
  });

  it('applies and reverts only the touched keys', () => {
    const before = base();
    const patch = { showCaptions: !before.showCaptions };
    const optimistic = applyPatch(before, patch);
    expect(optimistic.showCaptions).toBe(!before.showCaptions);
    // Something else changed meanwhile; revert must not clobber it.
    const current = { ...optimistic, coverSize: 'large' as const };
    const reverted = revertPatch(current, before, patch);
    expect(reverted.showCaptions).toBe(before.showCaptions);
    expect(reverted.coverSize).toBe('large');
  });
});

describe('settings validators', () => {
  it('validates ports', () => {
    expect(validatePort('8080')).toEqual({ ok: true, port: 8080 });
    expect(validatePort('abc')).toEqual({ ok: false, error: 'errorPortNumber' });
    expect(validatePort('80')).toEqual({ ok: false, error: 'errorPortRange' });
    expect(validatePort('70000')).toEqual({ ok: false, error: 'errorPortRange' });
  });

  it('validates player args', () => {
    expect(validateArgs('--fs --volume=50')).toBeNull();
    expect(validateArgs('--title="a b')).toBe('errorArgsQuote');
    expect(validateArgs('--fs\n--mute')).toBe('errorArgsNewline');
  });

  it('adds EPG urls without duplicates', () => {
    expect(addEpgUrl([], 'epg.example.com/guide.xml')).toEqual({ ok: true, list: ['http://epg.example.com/guide.xml'] });
    expect(addEpgUrl(['http://epg.example.com/guide.xml'], 'http://epg.example.com/guide.xml')).toEqual({ ok: false, error: 'errorEpgDuplicate' });
  });
});

describe('inspectBackup', () => {
  it('summarizes a valid backup', () => {
    const json = JSON.stringify({
      kind: 'iptvnator-playlist-backup',
      version: 1,
      exportedAt: '2026-10-01T00:00:00Z',
      includeSecrets: false,
      playlists: [{ portalType: 'm3u' }, { portalType: 'xtream' }, { portalType: 'stalker' }, { portalType: 'm3u' }],
    });
    const r = inspectBackup(json);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.summary.playlists).toBe(4);
      expect(r.summary.byKind).toEqual({ m3u: 2, xtream: 1, stalker: 1 });
    }
  });

  it('rejects other files', () => {
    expect(inspectBackup('not json')).toEqual({ ok: false, error: 'backupNotJson' });
    expect(inspectBackup('{"kind":"other"}')).toEqual({ ok: false, error: 'backupWrongFormat' });
    expect(inspectBackup('{"kind":"iptvnator-playlist-backup","version":2,"playlists":[]}')).toEqual({ ok: false, error: 'backupWrongVersion' });
  });
});
