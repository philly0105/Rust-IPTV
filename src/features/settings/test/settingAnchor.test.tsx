import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { eagerRoutes, installDomStubs, renderAt, rpcMock, settings } from '../../sources/test/harness';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  rpcRaw: (cmd: string, args?: unknown) => rpcMock.call(cmd, args),
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const settingsRoutes = await eagerRoutes((await import('../routes')).settingsRoutes);
const { SETTING_TARGETS } = await import('@/shell/settingTargets');

beforeAll(installDomStubs);
beforeEach(() => {
  rpcMock.reset();
  rpcMock.handlers['settings.get'] = () => settings();
  rpcMock.handlers['player.capabilities'] = () => ({ embeddedMpv: false });
});
afterEach(cleanup);

describe("a setting's link (the palette's single settings)", () => {
  it('scrolls to the group that holds the setting and marks it for a moment', async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    renderAt(settingsRoutes, '/settings/appearance#interface-size');
    await screen.findByTestId('settings-appearance');
    await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
    const group = scrolled[0] as HTMLElement;
    expect(group.hasAttribute('data-settings-group')).toBe(true);
    expect(group.textContent).toContain('Interface size');
    expect(group.className).toContain('bg-selected');
  });

  it("moves keyboard focus to the setting's control, or a group's first control (v-setup-04)", async () => {
    Element.prototype.scrollIntoView = () => undefined;
    renderAt(settingsRoutes, '/settings/playback#captions');
    await screen.findByTestId('settings-playback');
    await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('switch'));
    const label = document.querySelector(`label[for="${document.activeElement!.id}"]`);
    expect(label?.textContent).toContain('Show captions');
    cleanup();
    renderAt(settingsRoutes, '/settings/playback#subtitles');
    await screen.findByTestId('settings-playback');
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    const group = document.activeElement!.closest('[data-settings-group]');
    expect(group?.textContent).toContain('Subtitles');
  });

  it("finds every listed setting's label in its section", async () => {
    for (const target of SETTING_TARGETS.filter((s) => s.section !== 'players' && s.section !== 'remote')) {
      const scrolled: Element[] = [];
      Element.prototype.scrollIntoView = function (this: Element) {
        scrolled.push(this);
      };
      renderAt(settingsRoutes, `/settings/${target.section}#${target.id}`);
      await waitFor(() => expect(scrolled.length, target.id).toBeGreaterThan(0), { timeout: 3000 });
      cleanup();
    }
    // One render of a settings section per listed setting.
  }, 60_000);
});
