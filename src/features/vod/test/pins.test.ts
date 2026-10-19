// Preferred-source pins live in the core (`sourcePins.*`); pins an older build kept in
// localStorage move there once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const core = vi.hoisted(() => ({
  pins: new Map<string, { sourceId: string; itemId: string; updatedAt: string }>(),
  calls: [] as { cmd: string; args: unknown }[],
  fail: undefined as undefined | { code: string; message: string },
}));

vi.mock('@/api/transport', async (orig) => {
  const actual = await orig<typeof import('@/api/transport')>();
  return {
    ...actual,
    rpc: async (cmd: string, args: { matchKey: string; ref?: { sourceId: string; itemId: string } }) => {
      core.calls.push({ cmd, args });
      if (core.fail) throw actual.RpcError.from(core.fail);
      if (cmd === 'sourcePins.get') return core.pins.get(args.matchKey) ?? null;
      if (cmd === 'sourcePins.set') {
        if (args.ref!.sourceId === 'gone') throw actual.RpcError.from({ code: 'not_found', message: 'the source no longer exists' });
        const pin = { sourceId: args.ref!.sourceId, itemId: args.ref!.itemId, updatedAt: '2026-10-19T00:00:00Z' };
        core.pins.set(args.matchKey, pin);
        return pin;
      }
      throw new Error(`unmocked rpc ${cmd}`);
    },
  };
});

const { LEGACY_STORAGE_KEY, matchKey, migrateLocalPins, resetPinMigration } = await import('../lib/pins');

const legacy = (pins: Record<string, unknown>) => localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(pins));

beforeEach(() => {
  core.pins.clear();
  core.calls.length = 0;
  core.fail = undefined;
  localStorage.clear();
  resetPinMigration();
});
afterEach(() => localStorage.clear());

describe('matchKey', () => {
  it('is the normalized title base plus the year', () => {
    expect(matchKey({ title: 'Amélie (2001)', titleBase: 'Amélie', year: 2001 })).toBe('amelie|2001');
    expect(matchKey({ title: 'Heat' })).toBe('heat|');
  });
});

describe('migrateLocalPins', () => {
  it('moves local pins into the core once, keeps a pin the core already has, and drops the local copy', async () => {
    core.pins.set('dune|2021', { sourceId: 'b', itemId: '9', updatedAt: '2026-10-01T00:00:00Z' });
    legacy({
      'heat|1995': { sourceId: 'a', itemId: '1', updatedAt: '2026-01-01T00:00:00Z' },
      'dune|2021': { sourceId: 'a', itemId: '2', updatedAt: '2026-01-01T00:00:00Z' },
      'broken|': { sourceId: 3 },
      'old|2000': { sourceId: 'gone', itemId: '4', updatedAt: '2026-01-01T00:00:00Z' },
    });
    await migrateLocalPins();
    expect(core.pins.get('heat|1995')).toMatchObject({ sourceId: 'a', itemId: '1' });
    expect(core.pins.get('dune|2021')).toMatchObject({ sourceId: 'b', itemId: '9' });
    expect(core.calls.filter((c) => c.cmd === 'sourcePins.set').map((c) => c.args)).toEqual([
      { matchKey: 'heat|1995', ref: { sourceId: 'a', contentType: 'movie', itemId: '1' } },
      { matchKey: 'old|2000', ref: { sourceId: 'gone', contentType: 'movie', itemId: '4' } },
    ]);
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();

    // Once per page load.
    core.calls.length = 0;
    await migrateLocalPins();
    expect(core.calls).toHaveLength(0);
  });

  it('keeps the local copy when the core could not be reached, for the next load', async () => {
    legacy({ 'heat|1995': { sourceId: 'a', itemId: '1', updatedAt: '2026-01-01T00:00:00Z' } });
    core.fail = { code: 'network', message: 'offline' };
    await migrateLocalPins();
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).not.toBeNull();

    resetPinMigration();
    core.fail = undefined;
    await migrateLocalPins();
    expect(core.pins.get('heat|1995')).toMatchObject({ sourceId: 'a', itemId: '1' });
    expect(localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
  });

  it('asks the core nothing without local pins', async () => {
    await migrateLocalPins();
    expect(core.calls).toHaveLength(0);
  });
});
