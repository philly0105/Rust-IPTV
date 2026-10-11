import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

import type { Theme } from '@/api/types';

import { SettingsGroup, SettingsSection } from '../components';
import type { SectionProps } from './types';

/** Miniature of the app chrome drawn with fixed colors so each card previews its own theme. */
function ThemePreview({ mode }: { mode: 'light' | 'dark' | 'system' }) {
  const half = (m: 'light' | 'dark') => {
    const c =
      m === 'dark'
        ? { bg: '#0c1320', surface: '#131c2d', line: '#2f3d57', fg: '#e9edf5', accent: '#f5b544' }
        : { bg: '#edf0f5', surface: '#ffffff', line: '#c6cedc', fg: '#121a2a', accent: '#8f4f00' };
    return (
      <div className="flex h-full flex-1" style={{ background: c.bg }}>
        <div className="flex w-1/4 flex-col gap-1 p-1.5" style={{ background: c.surface, borderRight: `1px solid ${c.line}` }}>
          <span className="h-1.5 w-3/4 rounded-full" style={{ background: c.accent }} />
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
    <div aria-hidden className="flex h-24 w-full overflow-hidden rounded-md border border-border">
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

export function AppearanceSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const current: Theme = settings.theme;

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
              <label
                key={o.value}
                className={clsx(
                  'flex cursor-pointer flex-col gap-3 rounded-md border p-3 hover:bg-surface-2 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-focus',
                  selected ? 'border-accent bg-surface-2' : 'border-border',
                )}
              >
                <ThemePreview mode={o.value} />
                <span className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="settings-theme"
                    value={o.value}
                    checked={selected}
                    onChange={() => choose(o.value)}
                    className="sr-only"
                    data-testid={`theme-${o.value}`}
                  />
                  <span
                    aria-hidden
                    className={clsx(
                      'mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border-2',
                      selected ? 'border-accent' : 'border-fg-subtle',
                    )}
                  >
                    {selected ? <span className="size-2 rounded-full bg-accent" /> : null}
                  </span>
                  <span className="flex flex-col">
                    <span className="font-medium text-fg">{o.label}</span>
                    <span className="text-sm text-fg-muted">{o.hint}</span>
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
