// RELEASE_NOTES: newest first, valid versions, unique keys, an icon per item,
// and a title and text in English for every item. The i18n parity test
// carries the same keys into the other 18 languages.
import { describe, expect, it } from 'vitest';

import en from '@/i18n/en/onboarding.json';
import pkg from '../../../../package.json';

import { compareVersions } from '../decide';
import { RELEASE_NOTES } from '../notes';
import { TOUR_STEPS } from '../tour/steps';

const strings = en as Record<string, string>;
/** `settings.lastSeenVersion` accepts '' or 1-32 of these characters (contract C1). */
const VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;

describe('RELEASE_NOTES', () => {
  it('lists releases newest first, each with a version lastSeenVersion can hold', () => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(0);
    for (const r of RELEASE_NOTES) expect(r.version).toMatch(VERSION_RE);
    for (let i = 1; i < RELEASE_NOTES.length; i++) {
      expect(compareVersions(RELEASE_NOTES[i - 1]!.version, RELEASE_NOTES[i]!.version)).toBeGreaterThan(0);
    }
  });

  it('has notes for the version the app reports', () => {
    expect(RELEASE_NOTES.map((r) => r.version)).toContain(pkg.version);
  });

  it('gives every item a unique key, an icon, a title and a text', () => {
    const keys = RELEASE_NOTES.flatMap((r) => r.items.map((i) => i.key));
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of RELEASE_NOTES) {
      expect(r.items.length).toBeGreaterThan(0);
      for (const item of r.items) {
        expect(['function', 'object']).toContain(typeof item.icon);
        expect(strings[`${item.key}Title`], `${item.key}Title`).toBeTruthy();
        expect(strings[`${item.key}Text`], `${item.key}Text`).toBeTruthy();
      }
    }
  });

  it('keeps every English string the feature uses', () => {
    const used = [
      ...TOUR_STEPS.flatMap((s) => [s.titleKey, s.textKey]),
      ...['tourStep', 'tourNext', 'tourBack', 'tourSkip', 'tourDone', 'tourHintSearch', 'tourHintPalette', 'tourHintShortcuts'],
      ...['whatsNewTitle', 'whatsNewVersion', 'whatsNewClose', 'whatsNewTour', 'whatsNewEmpty'],
      ...RELEASE_NOTES.flatMap((r) => r.items.flatMap((i) => [`${i.key}Title`, `${i.key}Text`])),
    ];
    for (const k of used) expect(strings[k], k).toBeTruthy();
    // And nothing unused lingers in the file.
    expect(Object.keys(strings).sort()).toEqual([...new Set(used)].sort());
  });
});
