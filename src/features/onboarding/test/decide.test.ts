// The startup decision (contract C7, check 10): rules A-D, the tour before
// What's new, the two refinements (a still-new user and a downgrade store the
// version silently), version ordering, and which releases What's new lists.
import { describe, expect, it } from 'vitest';

import { compareVersions, countUsableSources, onboardingAction, releasesToShow } from '../decide';

const V = '0.1.0';
const decide = (lastSeenVersion: string, tourCompleted: boolean, sourceCount: number, version = V) =>
  onboardingAction({ version, lastSeenVersion, tourCompleted, sourceCount });

describe('onboardingAction', () => {
  describe('rule A: first start, no sources', () => {
    it('stores the running version silently', () => {
      expect(decide('', false, 0)).toEqual({ kind: 'silent', patch: { lastSeenVersion: V } });
    });

    it('stores only lastSeenVersion, never tourCompleted', () => {
      const action = decide('', false, 0);
      expect(action.kind === 'silent' && Object.keys(action.patch)).toEqual(['lastSeenVersion']);
    });

    it('starts the tour once the first source exists', () => {
      // After the silent store the next start (or the source appearing) sees the stored version.
      expect(decide(V, false, 1)).toEqual({ kind: 'tour' });
    });

    it('does nothing more while there are still no sources', () => {
      expect(decide(V, false, 0)).toEqual({ kind: 'none' });
    });

    it('does not start the tour again once it was finished or skipped', () => {
      expect(decide(V, true, 1)).toEqual({ kind: 'none' });
      expect(decide(V, true, 3)).toEqual({ kind: 'none' });
    });
  });

  describe('rule B: first start of this build with sources (an upgrade)', () => {
    it("shows What's new for the current version only", () => {
      expect(decide('', false, 1)).toEqual({ kind: 'whatsNew', since: '' });
      expect(decide('', false, 5)).toEqual({ kind: 'whatsNew', since: '' });
    });

    it('never starts the tour, even when tourCompleted is still false', () => {
      expect(decide('', false, 2).kind).not.toBe('tour');
    });

    it('shows the same when the tour is already marked done', () => {
      expect(decide('', true, 1)).toEqual({ kind: 'whatsNew', since: '' });
    });
  });

  describe('rule C: a new version since the last start', () => {
    it("shows What's new for releases newer than the stored version", () => {
      expect(decide('0.0.1', true, 1)).toEqual({ kind: 'whatsNew', since: '0.0.1' });
    });

    it('works without sources once the tour is done', () => {
      expect(decide('0.0.9', true, 0)).toEqual({ kind: 'whatsNew', since: '0.0.9' });
    });

    it('waits for the tour: a pending tour comes first', () => {
      expect(decide('0.0.1', false, 1)).toEqual({ kind: 'tour' });
      // Once the tour is done, the same inputs give What's new.
      expect(decide('0.0.1', true, 1)).toEqual({ kind: 'whatsNew', since: '0.0.1' });
    });

    it('stores the version silently for a user who is still new (no sources, no tour)', () => {
      expect(decide('0.0.1', false, 0)).toEqual({ kind: 'silent', patch: { lastSeenVersion: V } });
    });

    it('stores the version silently after a downgrade', () => {
      expect(decide('0.2.0', true, 1)).toEqual({ kind: 'silent', patch: { lastSeenVersion: V } });
      expect(decide('1.0.0', true, 0)).toEqual({ kind: 'silent', patch: { lastSeenVersion: V } });
    });

    it('treats a pre-release of the running version as older', () => {
      expect(decide('0.1.0-beta.1', true, 1)).toEqual({ kind: 'whatsNew', since: '0.1.0-beta.1' });
    });
  });

  describe('rule D: nothing new', () => {
    it('does nothing when the version is unchanged and the tour is done', () => {
      expect(decide(V, true, 1)).toEqual({ kind: 'none' });
      expect(decide(V, true, 0)).toEqual({ kind: 'none' });
    });
  });

  it('gives one action per start, and every kind is reachable', () => {
    const kinds = new Set<string>();
    for (const last of ['', '0.0.1', V, '9.9.9'])
      for (const done of [false, true])
        for (const n of [0, 1, 4]) {
          const a = decide(last, done, n);
          kinds.add(a.kind);
          expect(['none', 'tour', 'whatsNew', 'silent']).toContain(a.kind);
        }
    expect(kinds).toEqual(new Set(['none', 'tour', 'whatsNew', 'silent']));
  });

  it('only ever patches lastSeenVersion, to the running version', () => {
    for (const last of ['', '0.0.1', '9.9.9'])
      for (const done of [false, true])
        for (const n of [0, 1]) {
          const a = decide(last, done, n, '2.3.4');
          if (a.kind === 'silent') expect(a.patch).toEqual({ lastSeenVersion: '2.3.4' });
        }
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.1.0', '0.1.0', 0],
    ['0.1.0', '0.0.1', 1],
    ['0.0.9', '0.1.0', -1],
    ['0.10.0', '0.9.0', 1],
    ['1.2', '1.2.0', 0],
    ['1.2.1', '1.2', 1],
    ['1.0.0+build.7', '1.0.0', 0],
    ['1.0.0-beta.2', '1.0.0', -1],
    ['1.0.0', '1.0.0-rc.1', 1],
    ['1.0.0-beta.2', '1.0.0-beta.10', -1],
    ['1.0.0-alpha', '1.0.0-beta', -1],
    ['1.0.0-alpha', '1.0.0-alpha.1', -1],
    ['1.0.0-1', '1.0.0-alpha', -1],
    [' 0.2.0 ', '0.2.0', 0],
  ])('%s vs %s -> %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
    expect(Math.sign(compareVersions(b, a))).toBe(-sign || 0);
  });
});

describe('releasesToShow', () => {
  const notes = [{ version: '0.1.0' }, { version: '0.3.0' }, { version: '0.2.0' }, { version: '0.0.5' }];
  const versions = (rs: { version: string }[]) => rs.map((r) => r.version);

  it('opened by hand: every release up to the running one, newest first', () => {
    expect(versions(releasesToShow(notes, '0.2.0', null))).toEqual(['0.2.0', '0.1.0', '0.0.5']);
  });

  it("rule B (since ''): the running version only", () => {
    expect(versions(releasesToShow(notes, '0.2.0', ''))).toEqual(['0.2.0']);
    expect(releasesToShow(notes, '0.1.5', '')).toEqual([]);
  });

  it('rule C: releases newer than since, up to the running one', () => {
    expect(versions(releasesToShow(notes, '0.3.0', '0.0.5'))).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(versions(releasesToShow(notes, '0.3.0', '0.2.0'))).toEqual(['0.3.0']);
    expect(releasesToShow(notes, '0.3.0', '0.3.0')).toEqual([]);
  });

  it('never lists notes written ahead of the running version', () => {
    expect(versions(releasesToShow(notes, '0.1.0', '0.0.1'))).toEqual(['0.1.0', '0.0.5']);
  });

  it('does not change the list it was given', () => {
    const copy = [...notes];
    releasesToShow(notes, '0.3.0', null);
    expect(notes).toEqual(copy);
  });
});

describe('countUsableSources (L4-settings-2)', () => {
  it('skips sources whose every import failed, keeps imported and importing ones', () => {
    expect(
      countUsableSources([
        { lastError: 'connect timeout' },
        { lastRefreshAt: '2026-10-16T10:00:00Z', lastError: 'later refresh failed' },
        {},
        { lastRefreshAt: '2026-10-16T10:00:00Z' },
      ]),
    ).toBe(3);
    expect(countUsableSources([{ lastError: 'auth' }])).toBe(0);
  });
});
