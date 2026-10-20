/**
 * Appearance (contract C1): the html attributes and --ui-scale that theme.tsx
 * applies, the localStorage mirror, the scale state components read, the
 * Appearance settings section, and the settings palettes staying in step with
 * tokens.css. See docs/architecture/appearance.md.
 */

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ACCENTS, DEFAULT_SETTINGS, type Settings } from '@/api/types';

vi.mock('@/api/transport', async (orig) => ({
  ...(await orig<typeof import('@/api/transport')>()),
  rpc: async () => {
    throw new Error('no rpc in this test');
  },
  rpcRaw: async () => {
    throw new Error('no rpc in this test');
  },
  isDesktop: false,
}));
vi.mock('@/api/events', () => ({
  onAppEvent: () => () => undefined,
  onAnyAppEvent: () => () => undefined,
  onConnectionState: () => () => undefined,
}));

const theme = await import('@/shell/theme');
const { useScaleStore, scalePx } = await import('@/ui/scale');
const { queryClient } = await import('@/api/query');
const { AppearanceSection, ACCENT_PALETTE, PREVIEW_PALETTE } = await import('@/features/settings/sections/AppearanceSection');

const {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  ThemeSync,
  applyAppearanceToDocument,
  clampUiScale,
  effectiveAppearance,
  previewAppearance,
  sanitizeAppearance,
  useAppearanceStore,
  useThemeStore,
} = theme;

const html = document.documentElement;
const tokensCss = readFileSync(join(__dirname, '..', '..', 'styles', 'tokens.css'), 'utf8');

function resetDocument() {
  for (const k of ['accent', 'oled', 'density', 'theme', 'themeSwitching']) delete html.dataset[k];
  html.style.removeProperty('--ui-scale');
}

beforeEach(() => {
  localStorage.clear();
  resetDocument();
  useAppearanceStore.setState({ appearance: DEFAULT_APPEARANCE, preview: null });
  useThemeStore.setState({ theme: 'dark' });
});
afterEach(cleanup);

describe('applyAppearanceToDocument (C1)', () => {
  it('sets data-accent, data-oled, data-density and --ui-scale, and hands the scale to components', () => {
    applyAppearanceToDocument({ accent: 'teal', oledBlack: true, density: 'compact', uiScale: 1.1 }, 'dark');
    expect(html.dataset['accent']).toBe('teal');
    expect(html.dataset['oled']).toBe('');
    expect(html.dataset['density']).toBe('compact');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.1');
    expect(useScaleStore.getState()).toMatchObject({ uiScale: 1.1, density: 'compact' });
  });

  it('OLED black applies only while the dark theme is in effect', () => {
    applyAppearanceToDocument({ accent: 'amber', oledBlack: true, density: 'comfortable', uiScale: 1 }, 'light');
    expect('oled' in html.dataset).toBe(false);
    applyAppearanceToDocument({ accent: 'amber', oledBlack: true, density: 'comfortable', uiScale: 1 }, 'dark');
    expect('oled' in html.dataset).toBe(true);
    applyAppearanceToDocument({ accent: 'amber', oledBlack: false, density: 'comfortable', uiScale: 1 }, 'dark');
    expect('oled' in html.dataset).toBe(false);
  });

  it('cleans up unusable values instead of writing them', () => {
    applyAppearanceToDocument({ accent: 'neon', oledBlack: false, density: 'tiny', uiScale: 3 } as never, 'dark');
    expect(html.dataset['accent']).toBe('amber');
    expect(html.dataset['density']).toBe('comfortable');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.25');
  });

  it('an accent change swaps every colour in one frame', async () => {
    applyAppearanceToDocument({ ...DEFAULT_APPEARANCE, accent: 'amber' }, 'dark');
    await waitFor(() => expect(html.dataset['themeSwitching']).toBeUndefined());
    applyAppearanceToDocument({ ...DEFAULT_APPEARANCE, accent: 'violet' }, 'dark');
    expect(html.dataset['themeSwitching']).toBe('true');
    await waitFor(() => expect(html.dataset['themeSwitching']).toBeUndefined());
  });
});

describe('appearance values', () => {
  it('clampUiScale keeps 90 to 125 % and rounds to the core precision', () => {
    expect(clampUiScale(0.5)).toBe(0.9);
    expect(clampUiScale(2)).toBe(1.25);
    expect(clampUiScale(1.123456)).toBe(1.1235);
    expect(clampUiScale(Number.NaN)).toBe(1);
    expect(clampUiScale('1.1')).toBe(1);
  });

  it('sanitizeAppearance keeps known values and defaults the rest', () => {
    expect(sanitizeAppearance({ accent: 'lime', oledBlack: true, density: 'compact', uiScale: 0.95 })).toEqual({
      accent: 'lime',
      oledBlack: true,
      density: 'compact',
      uiScale: 0.95,
    });
    expect(sanitizeAppearance({ accent: 'LIME', oledBlack: 'yes', density: null })).toEqual(DEFAULT_APPEARANCE);
    expect(sanitizeAppearance('garbage')).toEqual(DEFAULT_APPEARANCE);
  });

  it('the saved appearance is mirrored to localStorage for the next cold start', () => {
    useAppearanceStore.getState().set({ accent: 'sky', oledBlack: true, density: 'compact', uiScale: 1.2 });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!)).toEqual({ accent: 'sky', oledBlack: true, density: 'compact', uiScale: 1.2 });
  });

  it('a preview lies over the saved appearance without saving it', () => {
    useAppearanceStore.getState().set({ ...DEFAULT_APPEARANCE, accent: 'rose' });
    previewAppearance({ uiScale: 1.15 });
    expect(effectiveAppearance(useAppearanceStore.getState())).toEqual({ ...DEFAULT_APPEARANCE, accent: 'rose', uiScale: 1.15 });
    expect(JSON.parse(localStorage.getItem(APPEARANCE_STORAGE_KEY)!).uiScale).toBe(1);
    previewAppearance(null);
    expect(effectiveAppearance(useAppearanceStore.getState()).uiScale).toBe(1);
  });

  it('scalePx follows the UI scale, and the density only for spacing lengths', () => {
    expect(scalePx(200, 1.1, 'comfortable')).toBe(220);
    expect(scalePx(200, 1, 'compact')).toBe(200);
    expect(scalePx(200, 1, 'compact', true)).toBe(175);
    expect(scalePx(200, 1.25, 'compact', true)).toBe(219);
  });
});

describe('ThemeSync', () => {
  it('applies the settings appearance and follows the theme in effect', () => {
    const view = render(<ThemeSync settingsTheme="dark" appearance={{ accent: 'rose', oledBlack: true, density: 'compact', uiScale: 1.15 }} />);
    expect(html.dataset['theme']).toBe('dark');
    expect(html.dataset['accent']).toBe('rose');
    expect('oled' in html.dataset).toBe(true);
    expect(html.dataset['density']).toBe('compact');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.15');

    view.rerender(<ThemeSync settingsTheme="light" appearance={{ accent: 'rose', oledBlack: true, density: 'compact', uiScale: 1.15 }} />);
    expect(html.dataset['theme']).toBe('light');
    expect('oled' in html.dataset).toBe(false);
    expect(html.dataset['accent']).toBe('rose');
  });

  it('a live preview resizes the document and ending it puts the saved size back', () => {
    render(<ThemeSync settingsTheme="dark" appearance={{ accent: 'amber', oledBlack: false, density: 'comfortable', uiScale: 1.05 }} />);
    act(() => previewAppearance({ uiScale: 1.2 }));
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.2');
    act(() => previewAppearance(null));
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.05');
  });

  it('keeps the mirrored appearance while settings are still loading', () => {
    useAppearanceStore.getState().set({ accent: 'coral', oledBlack: false, density: 'compact', uiScale: 0.9 });
    render(<ThemeSync />);
    expect(html.dataset['accent']).toBe('coral');
    expect(html.dataset['density']).toBe('compact');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('0.9');
  });
});

describe('tokens.css carries every C1 state', () => {
  it('has a dark and a light block per non-default accent, an OLED block and a compact block', () => {
    for (const accent of ACCENTS.filter((a) => a !== 'amber')) {
      expect(tokensCss).toContain(`:root[data-accent='${accent}'] {`);
      expect(tokensCss).toContain(`:root[data-theme='light'][data-accent='${accent}'] {`);
    }
    expect(tokensCss).toContain(":root[data-oled]:not([data-theme='light']) {");
    const compact = /:root\[data-density='compact'\]\s*\{([^}]*)\}/.exec(tokensCss)?.[1] ?? '';
    // 0.21875rem = 0.25rem x 0.875, the factor scale.ts uses.
    expect(compact).toMatch(/--spacing:\s*0\.21875rem/);
    expect(tokensCss).toMatch(/--ui-scale:\s*1;/);
    expect(tokensCss).toMatch(/--rail-width:\s*calc\(\d+px \* var\(--ui-scale\)\)/);
  });
});

describe('settings palettes follow the tokens', () => {
  const block = (selector: RegExp) => selector.exec(tokensCss)?.[1] ?? '';
  const token = (body: string, name: string) => new RegExp(String.raw`--color-${name}:\s*(#[0-9a-f]{6})`, 'i').exec(body)?.[1]?.toLowerCase();
  const DARK = block(/:root,\s*:root\[data-theme='dark'\]\s*\{([^}]*)\}/);
  const LIGHT = block(/:root\[data-theme='light'\]\s*\{([^}]*)\}/);

  it('ACCENT_PALETTE matches each accent block, dark and light', () => {
    for (const accent of ACCENTS) {
      const dark = accent === 'amber' ? DARK : block(new RegExp(String.raw`:root\[data-accent='${accent}'\]\s*\{([^}]*)\}`));
      const light = accent === 'amber' ? LIGHT : block(new RegExp(String.raw`:root\[data-theme='light'\]\[data-accent='${accent}'\]\s*\{([^}]*)\}`));
      const tones = (body: string) => ({
        accent: token(body, 'accent'),
        fg: token(body, 'accent-fg'),
        solid: token(body, 'accent-solid'),
        solidFg: token(body, 'accent-solid-fg'),
      });
      expect(ACCENT_PALETTE[accent], accent).toEqual({ dark: tones(dark), light: tones(light) });
    }
  });

  it('the OLED preview matches the OLED block over the dark one', () => {
    const oled = block(/:root\[data-oled\]:not\(\[data-theme='light'\]\)\s*\{([^}]*)\}/);
    expect(PREVIEW_PALETTE.oled).toEqual({
      bg: token(oled, 'bg'),
      surface: token(oled, 'surface'),
      line: token(oled, 'divider'),
      fg: token(DARK, 'fg'),
      accent: token(DARK, 'accent'),
    });
  });
});

describe('Appearance settings section', () => {
  function renderSection(over: Partial<Settings> = {}) {
    const update = vi.fn(async () => true);
    queryClient.clear();
    render(
      <QueryClientProvider client={queryClient}>
        <AppearanceSection settings={{ ...DEFAULT_SETTINGS, ...over }} update={update} />
      </QueryClientProvider>,
    );
    return update;
  }

  it('offers seven named accents as a radio group; the arrows choose the next one', () => {
    const update = renderSection({ accent: 'amber' });
    const group = screen.getByRole('radiogroup', { name: 'Accent color' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Amber', 'Teal', 'Violet', 'Rose', 'Lime', 'Sky', 'Coral']);
    expect(within(group).getByRole('radio', { checked: true }).textContent).toBe('Amber');
    fireEvent.keyDown(radios[0]!, { key: 'ArrowRight' });
    expect(update).toHaveBeenLastCalledWith({ accent: 'teal' });
    expect(document.activeElement).toBe(radios[1]);
    fireEvent.keyDown(radios[1]!, { key: 'End' });
    expect(update).toHaveBeenLastCalledWith({ accent: 'coral' });
    fireEvent.click(radios[3]!);
    expect(update).toHaveBeenLastCalledWith({ accent: 'rose' });
  });

  it('the OLED switch saves, and its hint says when it applies', () => {
    const update = renderSection();
    const oled = screen.getByRole('switch', { name: 'OLED black' });
    expect(screen.getByText(/Pure black backgrounds in the dark theme/)).toBeTruthy();
    fireEvent.click(oled);
    expect(update).toHaveBeenLastCalledWith({ oledBlack: true });
    cleanup();
    useThemeStore.setState({ theme: 'light' });
    renderSection();
    expect(screen.getByText('Applies when the dark theme is on.')).toBeTruthy();
  });

  it('density is a two-way choice', () => {
    const update = renderSection();
    const group = screen.getByRole('radiogroup', { name: 'Density' });
    fireEvent.click(within(group).getByRole('radio', { name: 'Compact' }));
    expect(update).toHaveBeenLastCalledWith({ density: 'compact' });
  });

  it('dragging the interface size previews it live and saves on release', async () => {
    const update = renderSection({ uiScale: 1 });
    const slider = screen.getByTestId('ui-scale') as HTMLInputElement;
    expect(slider.min).toBe('90');
    expect(slider.max).toBe('125');
    fireEvent.change(slider, { target: { value: '110' } });
    expect(useAppearanceStore.getState().preview).toEqual({ uiScale: 1.1 });
    expect(screen.getByTestId('ui-scale-value').textContent).toBe('110%');
    expect(update).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(update).toHaveBeenLastCalledWith({ uiScale: 1.1 });
    await waitFor(() => expect(useAppearanceStore.getState().preview).toBeNull());
  });

  it('Reset puts the size back to 100 %', () => {
    const update = renderSection({ uiScale: 1.2 });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(update).toHaveBeenLastCalledWith({ uiScale: 1 });
  });

  it('the sample draws real chrome labels', () => {
    renderSection();
    const sample = screen.getByTestId('appearance-sample');
    expect(within(sample).getByText('Home')).toBeTruthy();
    expect(within(sample).getByText('Live TV')).toBeTruthy();
    expect(within(sample).getByText('Night Harbor', { selector: 'span' })).toBeTruthy();
  });
});

describe('cold start', () => {
  it('paints the mirrored appearance as soon as the module loads, before settings arrive', async () => {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ accent: 'violet', oledBlack: false, density: 'compact', uiScale: 1.1 }));
    localStorage.setItem('tsrust.theme', 'dark');
    resetDocument();
    vi.resetModules();
    await import('@/shell/theme');
    expect(html.dataset['accent']).toBe('violet');
    expect(html.dataset['density']).toBe('compact');
    expect(html.style.getPropertyValue('--ui-scale')).toBe('1.1');
  });
});
