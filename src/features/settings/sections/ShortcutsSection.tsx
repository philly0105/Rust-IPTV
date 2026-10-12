import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Kbd } from '@/ui';
import { DOCUMENTED_SHORTCUTS, groupShortcuts, useShortcutList } from '@/shell';
import { SettingsGroup, SettingsSection } from '../components';
import type { SectionProps } from './types';

/** Area ids used by the shell and features, mapped to their `shell` label keys (same as the ? overlay). */
const AREA_KEYS: Record<string, string> = {
  Global: 'areaGlobal',
  Navigation: 'areaNavigation',
  Live: 'areaLive',
  Vod: 'areaVod',
  Playback: 'areaPlayback',
  'Dialogs and lists': 'areaDialogs',
};

/**
 * The full shortcut reference: registered shortcuts merged with the documented
 * ones (so keys bound only on other screens, like PiP Escape or Live search,
 * still show), grouped and labelled exactly like the ? overlay.
 */
export function ShortcutsSection(_props: SectionProps) {
  const { t } = useTranslation('settings');
  const { t: ts } = useTranslation('shell');
  const registered = useShortcutList();
  const groups = useMemo(() => {
    const documented = DOCUMENTED_SHORTCUTS.map((d) => ({ combo: d.combo, area: d.area, description: ts(d.descKey) }));
    const label = (area: string) => {
      const key = AREA_KEYS[area];
      return key ? ts(key) : area;
    };
    return groupShortcuts(registered, documented, label);
  }, [registered, ts]);

  return (
    <SettingsSection title={t('sectionShortcuts')} description={t('sectionShortcutsLead')} testId="settings-shortcuts">
      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-fg-muted">{t('shortcutsEmpty')}</p>
      ) : (
        groups.map(([area, items]) => (
          <SettingsGroup key={area} title={area}>
            <dl className="flex flex-col divide-y divide-border" data-testid="shortcut-group">
              {items.map((s) => (
                <div key={`${s.combo}|${s.description}`} data-combo={s.combo} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt className="text-fg">{s.description}</dt>
                  <dd className="shrink-0">
                    <Kbd combo={s.combo} />
                  </dd>
                </div>
              ))}
            </dl>
          </SettingsGroup>
        ))
      )}
      <p className="text-sm text-fg-muted">{t('shortcutsNote')}</p>
    </SettingsSection>
  );
}
