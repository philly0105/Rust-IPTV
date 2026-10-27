/** R6-r3 F4: every control in a favorites/recent row has an accessible name (axe button-name). */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ItemRef } from '@/api/types';

import { MENU_SHEET_QUERY } from '@/ui';

import { EntryRow } from '../components/EntryRow';
import { i18n, installDomStubs } from './harness';

vi.mock('@/api/transport', () => ({
  rpc: async () => undefined,
  rpcRaw: async () => undefined,
  isDesktop: false,
  RpcError: class RpcError extends Error {},
  proxiedUrl: (s: { url: string }) => s.url,
}));
vi.mock('@/api/events', () => ({ onAppEvent: () => () => undefined, onAnyAppEvent: () => () => undefined }));
vi.mock('@/shell', async () => (await import('./harness')).shellModule);
vi.mock('@/features/player', async () => (await import('./harness')).playerModule);

beforeAll(installDomStubs);
afterEach(cleanup);

function renderRow(contentType: ItemRef['contentType'], onOpen = vi.fn()) {
  render(
    <I18nextProvider i18n={i18n}>
      <EntryRow
        entryRef={{ sourceId: 's1', contentType, itemId: 'i1' }}
        snapshot={{ title: 'BBC One', subtitle: 'News', contentType }}
        showSource={false}
        time="Today"
        removeLabel="Remove BBC One"
        menuRemoveLabel="Remove from favorites"
        onOpen={onOpen}
        onRemove={() => undefined}
      />
    </I18nextProvider>,
  );
  return onOpen;
}

describe('EntryRow accessible names', () => {
  for (const type of ['live', 'movie'] as const) {
    it(`${type}: no button without a name; the artwork is decorative`, () => {
      renderRow(type);
      const buttons = screen.getAllByRole('button');
      for (const b of buttons) {
        const name = b.getAttribute('aria-label') ?? b.textContent ?? '';
        expect(name.trim(), b.outerHTML).not.toBe('');
      }
      const art = screen.getByTestId('entry-artwork');
      expect(art.getAttribute('aria-hidden')).toBe('true');
      expect(art.tagName).not.toBe('BUTTON');
      expect(art.querySelector('button, [tabindex]')).toBeNull();
    });
  }

  it('the artwork still opens the item with the mouse', () => {
    const onOpen = renderRow('live');
    fireEvent.click(screen.getByTestId('entry-artwork'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('EntryRow menu on a phone', () => {
  const original = window.matchMedia;
  afterEach(() => {
    window.matchMedia = original;
  });

  it("opens as a bottom sheet headed by the row's channel and what is on, as Live TV's channel menu does", () => {
    window.matchMedia = ((query: string) => ({
      matches: query === MENU_SHEET_QUERY,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    render(
      <I18nextProvider i18n={i18n}>
        <EntryRow
          entryRef={{ sourceId: 's1', contentType: 'live', itemId: 'i1' }}
          snapshot={{ title: 'US| ESPN HD', contentType: 'live' }}
          showSource={false}
          time="Today"
          removeLabel="Remove ESPN HD"
          menuRemoveLabel="Remove from history"
          now={{ title: 'NFL Live', progress: 0.4, leftSeconds: 2400 }}
          onOpen={() => undefined}
          onRemove={() => undefined}
        />
      </I18nextProvider>,
    );
    // The touch trigger is the last menu button in the row (the hover strip's sits before it).
    const triggers = screen.getAllByRole('button', { name: 'Actions for US| ESPN HD' });
    fireEvent.click(triggers[triggers.length - 1]!);
    const menu = screen.getByRole('menu', { name: 'Actions for US| ESPN HD' });
    expect(menu.hasAttribute('data-sheet')).toBe(true);
    const header = within(menu).getByTestId('menu-sheet-header');
    // The name reads as in the row, its country tag after it.
    expect(within(header).getByTestId('channel-name-tag').textContent).toBe('US');
    expect(header.textContent).toContain('ESPN HD');
    expect(header.textContent).toContain('NFL Live');
    expect(within(menu).getByRole('menuitem', { name: 'Remove from history' })).toBeTruthy();
  });
});
