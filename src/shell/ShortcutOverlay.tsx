import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Dialog, Kbd, SearchInput } from '@/ui';

import { normalizeCombo, useShortcutList, type ShortcutInfo } from './shortcuts';
import { useShellStore } from './store';

/**
 * Documented shortcuts (README + C16). They are listed even while the
 * feature that binds them is not mounted (e.g. digit zap outside Live), so
 * the overlay is always the complete reference. Registered entries with the
 * same area + combo replace these.
 */
export const DOCUMENTED_SHORTCUTS: readonly { combo: string; descKey: string; area: string }[] = [
  { combo: 'mod+k', descKey: 'scPalette', area: 'Global' },
  { combo: 'mod+f', descKey: 'scSearch', area: 'Global' },
  { combo: 'mod+r', descKey: 'scRecent', area: 'Global' },
  { combo: '?', descKey: 'scHelp', area: 'Global' },
  { combo: 'escape', descKey: 'scEscape', area: 'Global' },
  { combo: 'mod+shift+l', descKey: 'scTheme', area: 'Global' },
  { combo: 'f8', descKey: 'scNotifications', area: 'Global' },
  { combo: 'mod+b', descKey: 'scSidebar', area: 'Navigation' },
  { combo: 'digit', descKey: 'scDigits', area: 'Navigation' },
  { combo: 'space', descKey: 'scPlayPause', area: 'Playback' },
  { combo: 'k', descKey: 'scPlayPause', area: 'Playback' },
  { combo: 'f', descKey: 'scFullscreen', area: 'Playback' },
  { combo: 'arrowleft', descKey: 'scSeekBack', area: 'Playback' },
  { combo: 'arrowright', descKey: 'scSeekForward', area: 'Playback' },
  { combo: 'arrowup', descKey: 'scVolumeUp', area: 'Playback' },
  { combo: 'arrowdown', descKey: 'scVolumeDown', area: 'Playback' },
  { combo: 'm', descKey: 'scMute', area: 'Playback' },
  { combo: 'arrowup', descKey: 'scListMove', area: 'Dialogs and lists' },
  { combo: 'arrowdown', descKey: 'scListMove', area: 'Dialogs and lists' },
  { combo: 'enter', descKey: 'scListRun', area: 'Dialogs and lists' },
  { combo: 'escape', descKey: 'scListClose', area: 'Dialogs and lists' },
];

const AREA_ORDER = ['Global', 'Navigation', 'Live', 'Playback', 'Dialogs and lists'];
const AREA_KEYS: Record<string, string> = {
  Global: 'areaGlobal',
  Navigation: 'areaNavigation',
  Live: 'areaLive',
  Playback: 'areaPlayback',
  'Dialogs and lists': 'areaDialogs',
};

/** Merges registered and documented shortcuts and groups them by area. */
export function groupShortcuts(registered: ShortcutInfo[], documented: ShortcutInfo[]): [string, ShortcutInfo[]][] {
  const areaOf = (a: string) => a.trim().toLowerCase();
  const seen = new Set(registered.map((r) => `${areaOf(r.area)}|${normalizeCombo(r.combo)}`));
  const all = [...registered];
  for (const d of documented) {
    const key = `${areaOf(d.area)}|${normalizeCombo(d.combo)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(d);
  }
  const map = new Map<string, ShortcutInfo[]>();
  for (const s of all) {
    const list = map.get(s.area) ?? [];
    list.push(s);
    map.set(s.area, list);
  }
  const rank = (a: string) => {
    const i = AREA_ORDER.indexOf(a);
    return i < 0 ? AREA_ORDER.length : i;
  };
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

export function ShortcutOverlay() {
  const { t } = useTranslation('shell');
  const open = useShellStore((s) => s.helpOpen);
  const setOpen = useShellStore((s) => s.setHelpOpen);
  const registered = useShortcutList();
  const [filter, setFilter] = useState('');

  const groups = useMemo(() => {
    const documented = DOCUMENTED_SHORTCUTS.map((d) => ({ combo: d.combo, area: d.area, description: t(d.descKey) }));
    const q = filter.trim().toLowerCase();
    return groupShortcuts(registered, documented)
      .map(([area, list]) => [area, q ? list.filter((s) => `${s.description} ${s.combo}`.toLowerCase().includes(q)) : list] as const)
      .filter(([, list]) => list.length > 0);
  }, [registered, filter, t]);

  return (
    <Dialog
      open={open}
      onClose={() => {
        setOpen(false);
        setFilter('');
      }}
      title={t('keyboardShortcuts')}
      description={t('shortcutsIntro')}
      size="lg"
      testId="shortcut-overlay"
    >
      <SearchInput value={filter} onChange={setFilter} placeholder={t('filterShortcuts')} size="sm" className="mb-5" data-autofocus="" />
      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t('noShortcutsMatch')}</p>
      ) : (
        // Focusable so arrow and Page keys scroll a long list from the keyboard.
        <div
          role="region"
          aria-label={t('shortcutsListLabel')}
          tabIndex={0}
          className="grid gap-x-8 gap-y-6 rounded-md md:grid-cols-2"
        >
          {groups.map(([area, list]) => (
            <section key={area} aria-labelledby={`sc-area-${area}`}>
              <h3 id={`sc-area-${area}`} className="mb-2 text-sm font-semibold text-accent">
                {AREA_KEYS[area] ? t(AREA_KEYS[area]) : area}
              </h3>
              <dl className="flex flex-col">
                {list.map((s) => (
                  <div
                    key={`${s.combo}|${s.description}`}
                    data-combo={s.combo}
                    className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-b-0"
                  >
                    <dt className="text-sm text-fg">{s.description}</dt>
                    <dd className="shrink-0">
                      <Kbd combo={s.combo} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
