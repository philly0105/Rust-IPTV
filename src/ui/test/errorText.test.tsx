// Translated text leads in error screens and toasts; the core's raw (English) message is secondary
// (F-ERROR-TEXT), and key names follow the UI language (F-KEY-NAMES).
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import i18n, { loadLanguage } from '@/i18n';
import { RpcError } from '@/api/transport';

import { ErrorState, Kbd, comboKeys, errorDescription } from '..';

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('ErrorState', () => {
  it('shows the translated title and hint, with the raw message folded into the details', () => {
    render(<ErrorState error={new RpcError('auth', 'xtream: player_api.php answered 401 Unauthorized')} />);
    expect(screen.getByRole('heading', { name: 'Sign-in was rejected' })).toBeTruthy();
    expect(screen.getByText(/Check the username, password, or MAC address/)).toBeTruthy();
    const raw = screen.getByText('xtream: player_api.php answered 401 Unauthorized');
    expect(raw.closest('details')).not.toBeNull();
  });

  it('reads in the UI language', async () => {
    await loadLanguage('de');
    await i18n.changeLanguage('de');
    render(<ErrorState error={new RpcError('not_found', 'movie 42 not found')} />);
    const alert = screen.getByRole('alert');
    // The first visible paragraph is German, not the core's English.
    expect(alert.querySelector('h2 + p')?.textContent).not.toContain('movie 42');
    expect(screen.getByText('movie 42 not found').closest('details')).not.toBeNull();
  });
});

describe('errorDescription', () => {
  it('leads with the translated hint for the code and keeps the raw message in small print', () => {
    const { container } = render(<p>{errorDescription(new RpcError('timeout', 'operation timed out after 30s'))}</p>);
    expect(container.textContent).toMatch(/^The provider may be busy/);
    expect(container.querySelector('[data-error-message]')?.textContent).toBe('operation timed out after 30s');
  });

  it('leads with the message of an error the UI raised itself, with no guessed hint, and can redact it', () => {
    // FW-ERROR-HINT-LEAD: a plain Error carries the UI's own (often translated) words; the
    // internal-error hint ("Try again...") would be generic advice in front of them.
    const { container } = render(<p>{errorDescription(new Error('GET http://u:p@host/x failed'), (s) => s.replace('u:p@', '***@'))}</p>);
    expect(container.textContent).toBe('GET http://***@host/x failed');
    expect(container.querySelector('[data-error-message]')?.textContent).toBe('GET http://***@host/x failed');
  });

  it('keeps the code hint for errors from the core, and drops the external player advice in the browser', () => {
    const { container } = render(<p>{errorDescription(new RpcError('unsupported', 'screenshots need the desktop app'))}</p>);
    // Tests run as the browser build (no Tauri), where external players are not offered.
    expect(container.textContent).toMatch(/^The browser version, this source or this stream type/);
    expect(container.textContent).not.toMatch(/external player/);
    expect(container.querySelector('[data-error-message]')?.textContent).toBe('screenshots need the desktop app');
  });
});

describe('key names', () => {
  it('prints and speaks keys in the UI language', async () => {
    await loadLanguage('de');
    await i18n.changeLanguage('de');
    expect(comboKeys('ctrl+delete')).toEqual(['Strg', 'Entf']);
    expect(comboKeys('pageup')).toEqual(['Bild↑']);
    render(<Kbd combo="mediaplaypause" />);
    expect(screen.getByText('Wiedergabe/Pause')).toBeTruthy();
  });

  it('keeps arrow and media symbols in every language', async () => {
    await loadLanguage('ja');
    await i18n.changeLanguage('ja');
    expect(comboKeys('shift+arrowleft')).toEqual(['Shift', '←']);
    expect(comboKeys('space')).toEqual(['スペース']);
  });
});
