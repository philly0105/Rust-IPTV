/**
 * Review round 2 (2026-10-20): one rule for group titles, About's term lists and lead, the theme
 * cards' check and radii, the image cache row's label column and neutral meter, the backup drop
 * zone's edge, the short startup choices, and the settings components kept out of Home's first
 * load.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';
import { SECTION_IDS } from '../sections/types';

const flags = vi.hoisted(() => ({ desktop: false }));

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  get isDesktop() {
    return flags.desktop;
  },
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);

const SRC = join(__dirname, '..', '..', '..');

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  flags.desktop = false;
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false, reason: 'not built' });
  rpcMock.handlers['downloads.dir'] = () => ({ path: '/data/downloads' });
  rpcMock.handlers['parental.status'] = () => ({ enabled: false, mode: 'hide', autoAdult: true, unlockMinutes: 15, unlocked: false, failedAttempts: 0 });
  rpcMock.handlers['parental.locks'] = () => [];
  rpcMock.handlers['remote.status'] = () => ({ running: false, port: 7280 });
  rpcMock.handlers['app.info'] = () => ({ version: '0.2.0', dataDir: '/data', platform: 'linux', isDesktop: false, logFile: '/data/logs/iptv-server.log' });
  rpcMock.handlers['images.stats'] = () => ({ bytes: 49 * 1024 * 1024, files: 1834, maxBytes: 500 * 1024 * 1024 });
});
afterEach(cleanup);

describe.each(SECTION_IDS)('/settings/%s groups', (id) => {
  it('are all titled when there is more than one', async () => {
    flags.desktop = id === 'players';
    renderAt(settingsRoutes, `/settings/${id}`);
    const section = await screen.findByTestId(`settings-${id}`);
    // An untitled group after a titled one reads as the overflow of the one above.
    await waitFor(() => expect(section.querySelector('[data-settings-group]')).not.toBeNull());
    const groups = [...section.querySelectorAll<HTMLElement>('[data-settings-group]')];
    if (groups.length > 1) {
      const untitled = groups.filter((g) => g.dataset['settingsGroup'] !== 'titled').map((g) => g.textContent?.slice(0, 60));
      expect(untitled).toEqual([]);
    }
  });
});

describe('Appearance', () => {
  it('titles the accent group, which describes the swatches, and has no heading inside its card', async () => {
    renderAt(settingsRoutes, '/settings/appearance');
    const picker = await screen.findByTestId('accent-picker');
    const group = picker.closest<HTMLElement>('[data-settings-group]')!;
    expect(within(group).getByRole('heading', { level: 3 }).textContent).toBe('Accent color');
    expect(document.getElementById(picker.getAttribute('aria-describedby')!)?.textContent).toBe('Used for highlights, the selected item and play buttons.');
    // The card holds the swatches and the preview, no title of its own.
    expect(within(group).getAllByText('Accent color')).toHaveLength(1);
  });

  it("puts the chosen theme's check inside its preview, and rounds the cards one step under the group", async () => {
    renderAt(settingsRoutes, '/settings/appearance');
    const check = await screen.findByTestId('theme-check');
    expect(check.className).toContain('top-2');
    expect(check.className).toContain('end-2');
    // The positioned box is the preview's wrapper, not the card with its padding.
    const box = check.parentElement!;
    expect(box.className).toContain('relative');
    expect(box.querySelector('[aria-hidden].h-24')).not.toBeNull();
    const card = check.closest('label')!;
    expect(card.className).toContain('rounded-md');
    expect(card.className).not.toContain('rounded-lg');
  });
});

describe('About', () => {
  it('has a lead like every other section', async () => {
    renderAt(settingsRoutes, '/settings/about');
    const section = await screen.findByTestId('settings-about');
    expect(within(section).getByText('Version, updates, and where your data is kept.')).toBeTruthy();
  });

  it("keeps What's new and the tour together in one row of equal buttons", async () => {
    renderAt(settingsRoutes, '/settings/about');
    const row = await screen.findByTestId('about-product-actions');
    const whatsNew = within(row).getByTestId('about-whats-new');
    const tour = within(row).getByTestId('about-tour');
    expect(whatsNew.className).toBe(tour.className);
    expect(row.className).not.toContain('flex-col');
  });

  it('lists the data folder and log file as valid term lists, with the Open buttons outside them', async () => {
    flags.desktop = true;
    rpcMock.handlers['app.info'] = () => ({ version: '0.2.0', dataDir: 'C:/data', platform: 'windows', isDesktop: true, logFile: 'C:/data/log.txt' });
    renderAt(settingsRoutes, '/settings/about');
    await screen.findByTestId('about-open-logs');
    const section = screen.getByTestId('settings-about');
    for (const dl of section.querySelectorAll('dl')) {
      // A dl holds only dt and dd, or divs of them (axe definition-list).
      for (const child of dl.children) {
        expect(['DT', 'DD', 'DIV']).toContain(child.tagName);
        if (child.tagName === 'DIV') for (const inner of child.children) expect(['DT', 'DD']).toContain(inner.tagName);
      }
    }
    // Every dt and dd sits in a dl, directly or in a div of one (axe dlitem).
    for (const item of section.querySelectorAll('dt, dd')) {
      const parent = item.parentElement!;
      expect(parent.tagName === 'DL' || (parent.tagName === 'DIV' && parent.parentElement?.tagName === 'DL')).toBe(true);
    }
    const open = screen.getByTestId('about-open-logs');
    expect(open.closest('dl')).toBeNull();
    expect(within(section).getByText('C:/data/log.txt').tagName).toBe('DD');
  });
});

describe('Backup and storage', () => {
  it("gives the image cache the settings row's label column, not a percentage cap", async () => {
    renderAt(settingsRoutes, '/settings/backup');
    const row = await screen.findByTestId('image-cache-row');
    const hint = within(row).getByText(/Posters, logos and backdrops/);
    expect(hint.className).toContain('max-w-[38rem]');
    expect(hint.className).toContain('text-body-sm');
    expect(hint.parentElement!.className).not.toContain('60%');
    expect(within(row).getByText('Image cache').className).toContain('text-body');
  });

  it('draws the cache level neutral, and in the warning tone when nearly full', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    const meter = await screen.findByTestId('image-cache-meter');
    const fill = meter.firstElementChild as HTMLElement;
    // A level is not progress: no accent.
    expect(fill.className).toContain('bg-fg-muted');
    expect(fill.className).not.toMatch(/bg-accent/);
    cleanup();
    rpcMock.handlers['images.stats'] = () => ({ bytes: 480 * 1024 * 1024, files: 9000, maxBytes: 500 * 1024 * 1024 });
    renderAt(settingsRoutes, '/settings/backup');
    const full = (await screen.findByTestId('image-cache-meter')).firstElementChild as HTMLElement;
    expect(full.className).toContain('bg-warning');
  });

  it('outlines the drop zone with the container edge at rest, one radius under its group', async () => {
    renderAt(settingsRoutes, '/settings/backup');
    const zone = await screen.findByTestId('backup-dropzone');
    expect(zone.className).toContain('border-edge');
    expect(zone.className).toContain('hover:border-border');
    expect(zone.className).toMatch(/(^|\s)rounded-md(\s|$)/);
    // The control border is for controls (design-system.md).
    expect(zone.className.split(/\s+/)).not.toContain('border-border');
  });
});

describe('General', () => {
  it('keeps the startup choices short enough for one line each on a phone', async () => {
    renderAt(settingsRoutes, '/settings/general');
    const group = await screen.findByRole('radiogroup', { name: 'On startup' });
    const labels = within(group)
      .getAllByRole('radio')
      .map((r) => r.textContent ?? '');
    expect(labels).toEqual(['Home screen', 'Where I left off']);
    for (const l of labels) expect(l.length).toBeLessThanOrEqual(16);
  });
});

describe("Home's first load", () => {
  it('reaches the parental gate without the parental barrel, so the settings components stay out of it', () => {
    const gate = readFileSync(join(SRC, 'features', 'multiview', 'parentalGate.ts'), 'utf8');
    expect(gate).toMatch(/from '@\/features\/parental\/gate'/);
    expect(gate).not.toMatch(/from '@\/features\/parental'/);
  });

  it("marks the settings save context pure, so Rollup can drop the module where it is unused", () => {
    const src = readFileSync(join(SRC, 'features', 'settings', 'components.tsx'), 'utf8');
    for (const m of src.matchAll(/^export const \w+ = (.*)createContext/gm)) expect(m[1]).toContain('/* @__PURE__ */');
  });
});
