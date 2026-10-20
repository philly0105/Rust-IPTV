import { clsx } from 'clsx';
import { Check, House, Radio } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ACCENTS, DENSITIES, UI_SCALE_MAX, UI_SCALE_MIN } from '@/api/types';
import type { Accent, CoverSize, DashboardRails, Density, Theme } from '@/api/types';
import { clampUiScale, previewAppearance, useTheme } from '@/shell';
import { Button, Poster, ProgressBar, Radio as RadioInput, Slider } from '@/ui';
import { intlLocale } from '@/lib/intl';

import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { railsPatch } from '../lib/patch';
import type { SectionProps } from './types';

/** The home screen's rows, in the order Home shows them. */
const RAILS: (keyof DashboardRails)[] = [
  'hero',
  'continueWatching',
  'myList',
  'liveFavorites',
  'recentlyWatchedLive',
  'favoriteMoviesAndSeries',
  'recentSources',
  'recentlyAdded',
  'tmdbTrending',
];

const RAIL_KEY: Record<keyof DashboardRails, string> = {
  hero: 'railHero',
  continueWatching: 'railContinueWatching',
  liveFavorites: 'railLiveFavorites',
  recentlyWatchedLive: 'railRecentlyWatchedLive',
  favoriteMoviesAndSeries: 'railFavoriteMoviesAndSeries',
  recentSources: 'railRecentSources',
  recentlyAdded: 'railRecentlyAdded',
  tmdbTrending: 'railTmdbTrending',
  myList: 'railMyList',
};


/**
 * Each card previews its own theme whatever theme is active, so it cannot read
 * the live CSS variables (they hold only the active theme's values). These
 * mirror src/styles/tokens.css; `line` is --color-divider. A test keeps them
 * in step with the token file.
 */
export const PREVIEW_PALETTE = {
  dark: { bg: '#0c1320', surface: '#121a29', line: '#1d2637', fg: '#eef1f6', accent: '#f5b544' },
  light: { bg: '#edf0f5', surface: '#ffffff', line: '#e1e5ec', fg: '#0f1626', accent: '#8f4f00' },
  oled: { bg: '#000000', surface: '#000000', line: '#151a22', fg: '#eef1f6', accent: '#f5b544' },
} as const;

/**
 * Every accent's text tone with its text-on-fill (`accent`, `fg`) and its solid fill with the
 * text on that fill (`solid`, `solidFg`), per theme (OLED uses the dark set). The swatches show
 * the solid fill, which is what a primary button looks like in that theme. Mirrors the
 * data-accent blocks in tokens.css; a test keeps them in step.
 */
type AccentTones = { accent: string; fg: string; solid: string; solidFg: string };
export const ACCENT_PALETTE: Record<Accent, Record<'dark' | 'light', AccentTones>> = {
  amber: {
    dark: { accent: '#f5b544', fg: '#1b1204', solid: '#f5b544', solidFg: '#1b1204' },
    light: { accent: '#8f4f00', fg: '#ffffff', solid: '#f5b544', solidFg: '#1b1204' },
  },
  teal: {
    dark: { accent: '#3ccfbd', fg: '#03201c', solid: '#3ccfbd', solidFg: '#03201c' },
    light: { accent: '#00685d', fg: '#ffffff', solid: '#3ccfbd', solidFg: '#03201c' },
  },
  violet: {
    dark: { accent: '#b7a0ff', fg: '#170c33', solid: '#b7a0ff', solidFg: '#170c33' },
    light: { accent: '#6a42cf', fg: '#ffffff', solid: '#b7a0ff', solidFg: '#170c33' },
  },
  rose: {
    dark: { accent: '#ff8fb3', fg: '#2e0614', solid: '#ff8fb3', solidFg: '#2e0614' },
    light: { accent: '#b3215a', fg: '#ffffff', solid: '#ff8fb3', solidFg: '#2e0614' },
  },
  lime: {
    dark: { accent: '#b4e05a', fg: '#141f02', solid: '#b4e05a', solidFg: '#141f02' },
    light: { accent: '#476800', fg: '#ffffff', solid: '#b4e05a', solidFg: '#141f02' },
  },
  sky: {
    dark: { accent: '#6cc2ff', fg: '#03182b', solid: '#6cc2ff', solidFg: '#03182b' },
    light: { accent: '#0a5ca6', fg: '#ffffff', solid: '#6cc2ff', solidFg: '#03182b' },
  },
  coral: {
    dark: { accent: '#ff9474', fg: '#2b0d04', solid: '#ff9474', solidFg: '#2b0d04' },
    light: { accent: '#ad3b16', fg: '#ffffff', solid: '#ff9474', solidFg: '#2b0d04' },
  },
};

const ACCENT_LABEL_KEYS: Record<Accent, string> = {
  amber: 'accentAmber',
  teal: 'accentTeal',
  violet: 'accentViolet',
  rose: 'accentRose',
  lime: 'accentLime',
  sky: 'accentSky',
  coral: 'accentCoral',
};

const DENSITY_LABEL_KEYS: Record<Density, string> = {
  comfortable: 'densityComfortable',
  compact: 'densityCompact',
};

/** Miniature of the app chrome so each card previews its own theme, accent and OLED choice. */
function ThemePreview({ mode, oled, accent }: { mode: 'light' | 'dark' | 'system'; oled: boolean; accent: Accent }) {
  const half = (m: 'light' | 'dark') => {
    const c = m === 'dark' && oled ? PREVIEW_PALETTE.oled : PREVIEW_PALETTE[m];
    const tone = ACCENT_PALETTE[accent][m].accent;
    return (
      <div className="flex h-full flex-1" style={{ background: c.bg }}>
        <div className="flex w-1/4 flex-col gap-1 p-1.5" style={{ background: c.surface, borderInlineEnd: `1px solid ${c.line}` }}>
          <span className="h-1.5 w-3/4 rounded-full" style={{ background: tone }} />
          <span className="h-1 w-full rounded-full opacity-50" style={{ background: c.fg }} />
          <span className="h-1 w-2/3 rounded-full opacity-50" style={{ background: c.fg }} />
        </div>
        <div className="grid flex-1 grid-cols-3 gap-1 p-1.5">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className="rounded-sm" style={{ background: c.surface, border: `1px solid ${c.line}` }} />
          ))}
        </div>
      </div>
    );
  };
  return (
    <div aria-hidden className="flex h-24 w-full overflow-hidden rounded-md border border-edge">
      {mode === 'system' ? (
        <>
          {half('light')}
          {half('dark')}
        </>
      ) : (
        half(mode)
      )}
    </div>
  );
}

/**
 * Seven dial-knob swatches as a radio group: arrows move and choose (flipped
 * in right-to-left locales), Home/End jump to the ends. Its name and help text
 * are the group's title and description (`hintId`).
 */
function AccentPicker({ value, onChange, tone, hintId }: { value: Accent; onChange: (a: Accent) => void; tone: 'dark' | 'light'; hintId: string }) {
  const { t } = useTranslation('settings');
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const i = ACCENTS.indexOf(value);
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    let next: number | null = null;
    if (e.key === (rtl ? 'ArrowLeft' : 'ArrowRight') || e.key === 'ArrowDown') next = (i + 1) % ACCENTS.length;
    else if (e.key === (rtl ? 'ArrowRight' : 'ArrowLeft') || e.key === 'ArrowUp') next = (i - 1 + ACCENTS.length) % ACCENTS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ACCENTS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const accent = ACCENTS[next]!;
    onChange(accent);
    groupRef.current?.querySelector<HTMLElement>(`[data-accent-option="${accent}"]`)?.focus();
  };

  return (
    <div className="px-3 py-3">
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={t('accent')}
        aria-describedby={hintId}
        data-testid="accent-picker"
        className="grid grid-cols-[repeat(auto-fill,minmax(4.5rem,1fr))] gap-1"
      >
        {ACCENTS.map((a) => {
          const selected = a === value;
          const swatch = ACCENT_PALETTE[a][tone];
          return (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              data-accent-option={a}
              data-testid={`accent-${a}`}
              onClick={() => onChange(a)}
              onKeyDown={onKeyDown}
              // Selection is the ring and the check on the swatch itself, as on the theme cards; no tile behind it.
              className="group flex min-w-0 flex-col items-center gap-2 rounded-md px-1 py-2.5 hover:bg-hover active:bg-active motion-safe:transition-colors"

            >
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full motion-safe:transition-[box-shadow,scale] motion-safe:duration-150 motion-safe:group-active:scale-95"
                style={{
                  background: swatch.solid,
                  // Ring in the swatch's own colour, separated by a gap the colour of the card.
                  boxShadow: selected ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${swatch.solid}` : 'inset 0 0 0 1px rgb(0 0 0 / 0.12)',
                }}
              >
                {selected ? <Check size={18} strokeWidth={2.75} style={{ color: swatch.solidFg }} /> : null}
              </span>
              <span className={clsx('max-w-full truncate text-caption', selected ? 'font-medium text-fg' : 'text-fg-muted group-hover:text-fg')}>
                {t(ACCENT_LABEL_KEYS[a])}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * A slice of real chrome drawn with the live tokens, so accent, OLED, density
 * and size changes show here the moment they apply. Inert: nothing in it acts.
 */
function AppearanceSample() {
  const { t } = useTranslation(['settings', 'shell']);
  return (
    <div className="flex flex-col gap-3 px-4 py-4" data-testid="appearance-sample">
      <span className="text-caption font-medium text-fg-subtle">{t('previewLabel')}</span>
      <div inert aria-hidden className="flex flex-wrap items-stretch gap-4 rounded-md border border-divider bg-bg p-3">
        <div className="flex w-40 shrink-0 flex-col gap-1 rounded-md bg-surface p-2">
          <span className="tuning-tick flex h-(--rail-item-height) items-center gap-2 rounded-md bg-selected ps-3 text-sm font-medium text-fg">
            <House size={16} className="text-accent" />
            <span className="truncate">{t('shell:navDashboard')}</span>
          </span>
          <span className="flex h-(--rail-item-height) items-center gap-2 rounded-md ps-3 text-sm text-fg-muted">
            <Radio size={16} />
            <span className="truncate">{t('shell:railLive')}</span>
          </span>
        </div>
        <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
          <div className="w-14 shrink-0">
            <Poster alt="" label={t('previewTitle')} rounded="sm" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="truncate font-display text-base font-semibold text-fg">{t('previewTitle')}</span>
            <span className="truncate text-sm text-fg-muted">{t('previewMeta')}</span>
            <ProgressBar value={42} size="xs" className="max-w-48" />
          </div>
          <Button variant="primary" size="sm" tabIndex={-1}>
            {t('previewPlay')}
          </Button>
        </div>
      </div>
    </div>
  );
}

const SCALE_STEP = 0.05;
const SCALE_TICKS = Math.round((UI_SCALE_MAX - UI_SCALE_MIN) / SCALE_STEP) + 1;

/**
 * Interface size slider with a preview: the whole app resizes through
 * previewAppearance, and the value is saved on release (pointer up, key up,
 * blur). Keyboard arrows step by 5 %, preview at once and save each step.
 *
 * While the pointer drags, only the readout and ticks follow it; the app
 * resizes when the pointer lets go. Resizing mid-drag rescales the track under
 * the pointer, so the same pointer position maps to another value and the
 * thumb flips back and forth between two sizes.
 */
function ScaleControl({
  value,
  onCommit,
  id,
  describedBy,
}: {
  value: number;
  onCommit: (v: number) => Promise<boolean>;
  id: string;
  describedBy?: string;
}) {
  const { t, i18n } = useTranslation('settings');
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const dragging = useRef(false);
  const seq = useRef(0);
  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);
  // Leaving the page mid-drag drops the unsaved preview.
  useEffect(() => () => previewAppearance(null), []);

  const pct = (v: number) => new Intl.NumberFormat(intlLocale(i18n.language), { style: 'percent', maximumFractionDigits: 0 }).format(v);

  const commit = (v: number) => {
    editing.current = false;
    dragging.current = false;
    const mine = ++seq.current;
    if (v === value) {
      previewAppearance(null);
      return;
    }
    // The preview stays up until the save settles, so the size never flickers back.
    previewAppearance({ uiScale: v });
    void onCommit(v).then(() => {
      if (mine === seq.current && !editing.current) previewAppearance(null);
    });
  };

  const onInput = (raw: number) => {
    const v = clampUiScale(raw / 100);
    editing.current = true;
    seq.current++;
    setDraft(v);
    if (!dragging.current) previewAppearance({ uiScale: v });
  };

  // Where the thumb's centre sits for a value: the track minus half a (1rem) thumb at each end.
  const along = (v: number) => `calc(0.5rem + (100% - 1rem) * ${(v - UI_SCALE_MIN) / (UI_SCALE_MAX - UI_SCALE_MIN)})`;

  return (
    <div className="flex w-full flex-col gap-2 @2xl:w-80">
      <div className="flex items-center justify-between gap-3">
        <output htmlFor={id} aria-live="polite" className="font-display text-2xl font-semibold text-fg tabular" data-testid="ui-scale-value">
          {pct(draft)}
        </output>
        {Math.abs(value - 1) > 1e-9 || Math.abs(draft - 1) > 1e-9 ? (
          <Button
            variant="ghost"
            size="sm"
            data-testid="ui-scale-reset"
            onClick={() => {
              setDraft(1);
              commit(1);
            }}
          >
            {t('uiScaleReset')}
          </Button>
        ) : null}
      </div>
      <Slider
        id={id}
        min={Math.round(UI_SCALE_MIN * 100)}
        max={Math.round(UI_SCALE_MAX * 100)}
        step={Math.round(SCALE_STEP * 100)}
        value={Math.round(draft * 100)}
        aria-describedby={describedBy}
        aria-valuetext={pct(draft)}
        data-testid="ui-scale"
        onValueChange={onInput}
        onPointerDown={() => {
          dragging.current = true;
        }}
        onPointerUp={() => commit(draft)}
        onPointerCancel={() => commit(draft)}
        onKeyUp={(e) => {
          if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key.startsWith('Page')) commit(draft);
        }}
        onBlur={() => {
          if (editing.current) commit(draft);
        }}
        className="w-full"
      />
      {/* The tuning scale: a tick per 5 % step, labelled at the ends and at 100 %. */}
      <div aria-hidden className="relative h-6">
        {Array.from({ length: SCALE_TICKS }, (_, i) => {
          const v = UI_SCALE_MIN + i * SCALE_STEP;
          const major = i === 0 || i === SCALE_TICKS - 1 || Math.abs(v - 1) < 1e-9;
          const on = Math.abs(v - draft) < 1e-9;
          return (
            <span
              key={i}
              className={clsx('absolute top-0 w-px -translate-x-1/2 rtl:translate-x-1/2', major ? 'h-2' : 'h-1', on ? 'bg-accent-mark' : 'bg-border')}
              style={{ insetInlineStart: along(v) }}
            />
          );
        })}
        {[UI_SCALE_MIN, 1, UI_SCALE_MAX].map((v, i) => (
          <span
            key={v}
            className={clsx(
              'absolute top-2.5 text-2xs text-fg-subtle tabular',
              i === 0 ? 'start-0' : i === 2 ? 'end-0' : '-translate-x-1/2 rtl:translate-x-1/2',
            )}
            style={i === 1 ? { insetInlineStart: along(v) } : undefined}
          >
            {pct(v)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function AppearanceSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const { resolved } = useTheme();
  const current: Theme = settings.theme;
  const accent: Accent = (ACCENTS as readonly string[]).includes(settings.accent) ? settings.accent : 'amber';
  const oledBlack = settings.oledBlack === true;
  const density: Density = settings.density === 'compact' ? 'compact' : 'comfortable';
  const uiScale = clampUiScale(settings.uiScale);
  const accentHintId = useId();

  const choose = (value: Theme) => {
    if (value === current) return;
    // The optimistic settings cache feeds the shell's ThemeSync, which applies it at once.
    void update({ theme: value });
  };

  const options: { value: Theme; label: string; hint: string }[] = [
    { value: 'dark', label: t('themeDark'), hint: t('themeDarkHint') },
    { value: 'light', label: t('themeLight'), hint: t('themeLightHint') },
    { value: 'system', label: t('themeSystem'), hint: t('themeSystemHint') },
  ];

  return (
    <SettingsSection title={t('sectionAppearance')} description={t('sectionAppearanceLead')} testId="settings-appearance">
      <SettingsGroup title={t('theme')}>
        <div role="radiogroup" aria-label={t('theme')} className="grid gap-3 p-3 @2xl:grid-cols-3">
          {options.map((o) => {
            const selected = o.value === current;
            return (
              // One selection language on the page: the chosen card (like the chosen swatch) gets
              // the accent outline and a check badge. The radio stays, visually hidden, for its
              // semantics and arrow keys; the card draws its focus ring.
              // rounded-md: one radius step under the 12 px group it sits in, 12 px in.
              <label
                key={o.value}
                className={clsx(
                  'relative flex cursor-pointer flex-col gap-3 rounded-md border p-3 motion-safe:transition-colors has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus',
                  selected ? 'border-accent bg-surface-2' : 'border-edge hover:border-border hover:bg-hover active:bg-active',
                )}
              >
                {/* The check sits inside the preview's corner, not across its edge. */}
                <span className="relative block">
                  <ThemePreview mode={o.value} oled={oledBlack} accent={accent} />
                  {selected ? (
                    <span
                      aria-hidden
                      className="absolute top-2 end-2 flex size-5 items-center justify-center rounded-full bg-accent-solid text-accent-solid-fg shadow-1"
                      data-testid="theme-check"
                    >
                      <Check size={12} strokeWidth={3} />
                    </span>
                  ) : null}
                </span>
                {/* Hidden by a wrapper, not through wrapperClassName: the kit's own `relative size-4.5`
                    there outlasts sr-only and left a blank band in every card. */}
                <span className="sr-only">
                  <RadioInput
                    name="settings-theme"
                    value={o.value}
                    checked={selected}
                    onChange={() => choose(o.value)}
                    className="focus-visible:shadow-none focus-visible:outline-none"
                    data-testid={`theme-${o.value}`}
                  />
                </span>
                <span className="flex flex-col gap-0.5">
                  <span className="text-body font-medium text-fg">{o.label}</span>
                  <span className="text-body-sm text-fg-muted">{o.hint}</span>
                </span>
              </label>
            );
          })}
        </div>
        <SwitchRow
          label={t('oledBlack')}
          description={resolved === 'light' ? t('oledBlackLightHint') : t('oledBlackHint')}
          checked={oledBlack}
          onChange={(v) => void update({ oledBlack: v })}
          testId="oled-black"
        />
      </SettingsGroup>

      <SettingsGroup title={t('accent')} description={t('accentHint')} descriptionId={accentHintId}>
        <AccentPicker value={accent} tone={resolved} hintId={accentHintId} onChange={(a) => a !== accent && void update({ accent: a })} />
        <AppearanceSample />
      </SettingsGroup>

      <SettingsGroup title={t('sizeGroup')}>
        <SettingsRow label={t('density')} description={t('densityHint')}>
          {({ id }) => (
            <Segmented<Density>
              id={id}
              label={t('density')}
              value={density}
              options={DENSITIES.map((d) => ({ value: d, label: t(DENSITY_LABEL_KEYS[d]) }))}
              onChange={(d) => void update({ density: d })}
            />
          )}
        </SettingsRow>
        <SettingsRow label={t('uiScale')} description={t('uiScaleHint')}>
          {({ id, describedBy }) => (
            <ScaleControl id={id} describedBy={describedBy} value={uiScale} onCommit={(v) => update({ uiScale: v })} />
          )}
        </SettingsRow>
        <SettingsRow label={t('coverSize')} description={t('coverSizeHint')}>
          {({ id }) => (
            <Segmented<CoverSize>
              id={id}
              label={t('coverSize')}
              value={settings.coverSize}
              options={[
                { value: 'small', label: t('coverSmall') },
                { value: 'medium', label: t('coverMedium') },
                { value: 'large', label: t('coverLarge') },
              ]}
              onChange={(coverSize) => void update({ coverSize })}
            />
          )}
        </SettingsRow>
      </SettingsGroup>

      {/* SS-8: the home screen is something the user sees, so it sits with the other looks. */}
      <SettingsGroup title={t('dashboard')} description={settings.showDashboard ? t('dashboardHint') : t('railsOffHint')}>
        <SwitchRow
          label={t('showDashboard')}
          description={t('showDashboardHint')}
          checked={settings.showDashboard}
          onChange={(showDashboard) => void update({ showDashboard })}
          testId="toggle-showDashboard"
        />
        {RAILS.map((rail) => (
          <SwitchRow
            key={rail}
            label={t(RAIL_KEY[rail])}
            checked={settings.dashboardRails[rail]}
            disabled={!settings.showDashboard}
            onChange={(v) => void update(railsPatch(settings, rail, v))}
            testId={`toggle-rail-${rail}`}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
