/**
 * The onboarding decision (contract C7), kept pure so every rule is a unit
 * test: given the running version, the two settings markers and how many
 * sources exist, what should happen at startup?
 *
 * - (A) `lastSeenVersion === ''` and no sources: a fresh install. Store the
 *   version silently; the tour waits for the first source.
 * - (B) `lastSeenVersion === ''` with sources: an upgrade from a build that
 *   had no onboarding. The user knows the app, so the tour is marked done and
 *   What's new shows the current version (`since: ''`).
 * - Tour: a source exists and the tour was never finished or skipped. It
 *   comes before What's new; the two never show together.
 * - (C) `lastSeenVersion !== version`: What's new for every release newer
 *   than `lastSeenVersion`, then the version is stored. Two refinements:
 *   a user who is still new (no sources, tour not done) has nothing to
 *   compare against, so the version is stored silently like (A); and a
 *   downgrade (stored version newer than the running one) has no notes to
 *   show, so it is stored silently too.
 * - (D) Otherwise nothing.
 *
 * No React and no icons here: the shell's host imports this module, and it
 * must stay small.
 */

import type { Settings, Source } from '@/api/types';

/**
 * The sources that count as "a source exists": one that has imported at least
 * once, or is still on its first import. A source whose every import failed
 * has nothing to show, so it neither starts the tour over an empty app nor
 * counts as an upgrade (L4-settings-2).
 */
export function countUsableSources(sources: readonly Pick<Source, 'lastRefreshAt' | 'lastError'>[]): number {
  return sources.filter((s) => s.lastRefreshAt !== undefined || !s.lastError).length;
}

export interface OnboardingInput {
  /** The running app version (`app.info.version`). */
  version: string;
  /** `settings.lastSeenVersion`: '' until the first decision stores one. */
  lastSeenVersion: string;
  /** `settings.tourCompleted`. */
  tourCompleted: boolean;
  /** How many sources exist. */
  sourceCount: number;
}

export type OnboardingAction =
  | { kind: 'none' }
  | { kind: 'tour' }
  /** `since: ''` means "the current version only" (rule B); otherwise releases newer than `since`. */
  | { kind: 'whatsNew'; since: string }
  | { kind: 'silent'; patch: Partial<Settings> };

/** Pure decision, unit-tested (see the module comment for rules A-D). */
export function onboardingAction(i: {
  version: string;
  lastSeenVersion: string;
  tourCompleted: boolean;
  sourceCount: number;
}): OnboardingAction {
  const hasSources = i.sourceCount > 0;
  if (i.lastSeenVersion === '') {
    // (A) fresh install / (B) upgrade from a build without onboarding.
    return hasSources ? { kind: 'whatsNew', since: '' } : { kind: 'silent', patch: { lastSeenVersion: i.version } };
  }
  // The tour first: What's new waits for it to close.
  if (hasSources && !i.tourCompleted) return { kind: 'tour' };
  if (i.lastSeenVersion !== i.version) {
    // Still new (nothing to compare against) or a downgrade: just remember the version.
    if (!hasSources && !i.tourCompleted) return { kind: 'silent', patch: { lastSeenVersion: i.version } };
    if (compareVersions(i.lastSeenVersion, i.version) > 0) return { kind: 'silent', patch: { lastSeenVersion: i.version } };
    // (C)
    return { kind: 'whatsNew', since: i.lastSeenVersion };
  }
  // (D)
  return { kind: 'none' };
}

/**
 * Orders two version strings (`[0-9A-Za-z.+-]`, as `settings.lastSeenVersion`
 * allows): numeric dot segments compare as numbers, `+build` metadata is
 * ignored, and a pre-release (`1.0.0-beta.2`) sorts before its release, with
 * its own dot segments compared numerically when both are numbers. Missing
 * segments count as 0, so `1.2` equals `1.2.0`. Returns <0, 0 or >0.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const core = v.split('+')[0] ?? '';
    const dash = core.indexOf('-');
    return dash < 0 ? { main: core, pre: '' } : { main: core.slice(0, dash), pre: core.slice(dash + 1) };
  };
  const x = split(a.trim());
  const y = split(b.trim());
  const main = compareSegments(x.main.split('.'), y.main.split('.'), true);
  if (main !== 0) return main;
  // A release outranks any of its pre-releases.
  if (x.pre === '' || y.pre === '') return x.pre === y.pre ? 0 : x.pre === '' ? 1 : -1;
  return compareSegments(x.pre.split('.'), y.pre.split('.'), false);
}

function compareSegments(a: string[], b: string[], padWithZero: boolean): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const sa = a[i];
    const sb = b[i];
    if (sa === undefined || sb === undefined) {
      if (padWithZero) {
        const other = Number(sa ?? sb);
        if (Number.isFinite(other) && other === 0) continue;
        return sa === undefined ? -1 : 1;
      }
      // Pre-release: the shorter list of equal leading segments sorts first (semver).
      return sa === undefined ? -1 : 1;
    }
    const na = /^\d+$/.test(sa) ? Number(sa) : NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : NaN;
    let c: number;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) c = na - nb;
    else if (!Number.isNaN(na)) c = -1; // numbers sort before words (semver)
    else if (!Number.isNaN(nb)) c = 1;
    else c = sa < sb ? -1 : sa > sb ? 1 : 0;
    if (c !== 0) return c < 0 ? -1 : 1;
  }
  return 0;
}

/** One release of `RELEASE_NOTES`, without committing to the icon type here. */
export interface ReleaseLike {
  version: string;
}

/**
 * The releases What's new lists, newest first:
 * - `since === null` (opened by hand): every release up to the running one;
 * - `since === ''` (rule B): the running version only;
 * - otherwise (rule C): releases newer than `since`, up to the running one.
 * Releases newer than the running version (notes written ahead) never show.
 */
export function releasesToShow<R extends ReleaseLike>(notes: readonly R[], version: string, since: string | null): R[] {
  return notes
    .filter((r) => {
      const vsCurrent = compareVersions(r.version, version);
      if (vsCurrent > 0) return false;
      if (since === null) return true;
      if (since === '') return vsCurrent === 0;
      return compareVersions(r.version, since) > 0;
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}
