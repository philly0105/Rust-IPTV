/**
 * One voice for the sources, settings, onboarding, parental and channel-edit copy (SS-11):
 *
 * - The thing on the Sources page is a "source" (an M3U playlist, an Xtream account or a Stalker
 *   portal), so text about every source never says "playlist". "Playlist" stays for M3U-only text.
 * - One ellipsis character ("…", not "..."), in every locale.
 * - English uses one contraction style ("Couldn't", never "Could not") and the spelling the rest
 *   of the app uses for a TV programme.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LANGUAGES } from '@/i18n';

const DIR = path.join(__dirname, '..', '..', '..', 'i18n');
const NAMESPACES = ['sources', 'settings', 'onboarding', 'parental', 'channels'] as const;
const read = (folder: string, ns: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(DIR, folder, `${ns}.json`), 'utf8')) as Record<string, string>;

/** Keys that speak of every kind of source at once. */
const ALL_SOURCES: Record<string, RegExp> = {
  sources: /^(removeAll|removedAll|removeLockedText)/,
  settings: /^(backupRefreshing|backupSkippedEntries|backupNoPlaylists|backupWrongFormat|backupSummary)/,
  channels: /^goneBadge$/,
};

describe('copy of the sources and settings areas (SS-11)', () => {
  it('calls the entity a source wherever the text covers every kind', () => {
    for (const [ns, keys] of Object.entries(ALL_SOURCES)) {
      const en = read('en', ns);
      const matched = Object.keys(en).filter((k) => keys.test(k));
      expect(matched.length, ns).toBeGreaterThan(0);
      for (const k of matched) expect(en[k], `${ns}.${k}`).not.toMatch(/playlist/i);
    }
  });

  it('uses the ellipsis character, not three dots, in every locale', () => {
    for (const { code } of LANGUAGES) {
      for (const ns of NAMESPACES) {
        for (const [k, v] of Object.entries(read(code, ns))) expect(v.includes('...'), `${code}/${ns}.${k}: ${v}`).toBe(false);
      }
    }
  });

  it('writes "Couldn\'t" in English, never "Could not"', () => {
    for (const ns of NAMESPACES) {
      for (const [k, v] of Object.entries(read('en', ns))) expect(v, `${ns}.${k}`).not.toMatch(/\bcould not\b/i);
    }
  });

  it('spells a TV programme "programme" in English (a "program" is software)', () => {
    for (const ns of NAMESPACES) {
      for (const [k, v] of Object.entries(read('en', ns))) {
        if (k === 'playerPathHint') continue;
        // Placeholder names ({{programs}}) are code, not copy.
        expect(v.replace(/\{\{[^}]*\}\}/g, ''), `${ns}.${k}`).not.toMatch(/\bprograms?\b/i);
      }
    }
  });
});
