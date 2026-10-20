import { Fragment, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Kbd } from '@/ui';
import { useShortcutList, type ShortcutInfo } from '@/shell';
import { shortcutReference } from '@/shell/ShortcutOverlay';
import { SettingsGroup, SettingsSection } from '../components';
import type { SectionProps } from './types';

/**
 * One row per action: keys that do the same thing ("Shift+F10" and "Menu" both open the channel
 * menu) share a row, "Shift F10 or Menu", instead of repeating the sentence. Order is kept.
 */
export function mergeByDescription(items: readonly ShortcutInfo[]): { description: string; combos: string[] }[] {
  const out: { description: string; combos: string[] }[] = [];
  const at = new Map<string, number>();
  for (const s of items) {
    const i = at.get(s.description);
    if (i === undefined) {
      at.set(s.description, out.length);
      out.push({ description: s.description, combos: [s.combo] });
    } else if (!out[i]!.combos.includes(s.combo)) out[i]!.combos.push(s.combo);
  }
  return out;
}

/**
 * The full shortcut reference: registered shortcuts merged with the documented
 * ones (so keys bound only on other screens, like PiP Escape or Live search,
 * still show). It comes from the same `shortcutReference` as the ? overlay,
 * so every area (Multi-view, My List, Seek bar...) gets the same translated
 * heading in both places.
 */
export function ShortcutsSection(_props: SectionProps) {
  const { t } = useTranslation('settings');
  const { t: ts } = useTranslation('shell');
  const registered = useShortcutList();
  const groups = useMemo(() => shortcutReference(registered, ts).map(([area, items]) => [area, mergeByDescription(items)] as const), [registered, ts]);

  return (
    <SettingsSection title={t('sectionShortcuts')} description={t('sectionShortcutsLead')} testId="settings-shortcuts">
      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge px-4 py-8 text-center text-fg-muted">{t('shortcutsEmpty')}</p>
      ) : (
        // The list holds nothing focusable, so the region itself takes focus:
        // keyboard users can then scroll it with the arrow and Page keys
        // (axe scrollable-region-focusable on #main), as in the ? overlay.
        <div
          role="region"
          aria-label={ts('shortcutsListLabel')}
          tabIndex={0}
          data-testid="shortcuts-list"
          className="flex flex-col gap-8 rounded-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
        >
          {groups.map(([area, items]) => (
            <SettingsGroup key={area} title={area}>
              <dl className="flex flex-col divide-y divide-divider" data-testid="shortcut-group">
                {items.map((s) => (
                  <div
                    key={`${s.combos.join(' ')}|${s.description}`}
                    data-combo={s.combos[0]}
                    data-combos={s.combos.join(' ')}
                    className="flex min-h-11 items-center justify-between gap-4 px-4 py-2"
                  >
                    <dt className="text-body-sm text-fg">{s.description}</dt>
                    <dd className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                      {s.combos.map((combo, i) => (
                        <Fragment key={combo}>
                          {i > 0 ? <span className="text-caption text-fg-subtle">{t('shortcutsOr')}</span> : null}
                          <Kbd combo={combo} />
                        </Fragment>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </SettingsGroup>
          ))}
        </div>
      )}
      <p className="text-sm text-fg-muted">{t('shortcutsNote')}</p>
    </SettingsSection>
  );
}
