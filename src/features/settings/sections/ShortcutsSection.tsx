import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Kbd, comboKeys } from '@/ui';
import { useShortcutList } from '@/shell';
import { SettingsGroup, SettingsSection } from '../components';
import type { SectionProps } from './types';

export function ShortcutsSection(_props: SectionProps) {
  const { t } = useTranslation('settings');
  const list = useShortcutList();
  const groups = useMemo(() => {
    const byArea = new Map<string, { combo: string; description: string }[]>();
    for (const s of list) {
      const arr = byArea.get(s.area) ?? [];
      if (!arr.some((x) => x.combo === s.combo && x.description === s.description)) arr.push(s);
      byArea.set(s.area, arr);
    }
    return [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list]);

  return (
    <SettingsSection title={t('sectionShortcuts')} description={t('sectionShortcutsLead')} testId="settings-shortcuts">
      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-fg-muted">{t('shortcutsEmpty')}</p>
      ) : (
        groups.map(([area, items]) => (
          <SettingsGroup key={area} title={area}>
            <dl className="flex flex-col divide-y divide-border">
              {items.map((s) => (
                <div key={`${s.combo}|${s.description}`} className="flex items-center justify-between gap-4 px-4 py-2.5">
                  <dt className="text-fg">{s.description}</dt>
                  <dd className="flex shrink-0 items-center gap-1">
                    {comboKeys(s.combo).map((k, i) => (
                      <Kbd key={i}>{k}</Kbd>
                    ))}
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
