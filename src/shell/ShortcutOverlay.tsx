import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { comboKeys, Dialog, Kbd, SearchInput } from '@/ui';

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
  { combo: 'mod+b', descKey: 'scSidebar', area: 'Live' },
  { combo: 'digit', descKey: 'scDigits', area: 'Live' },
  { combo: '/', descKey: 'live:shortcutFocusSearch', area: 'Live' },
  { combo: 'enter', descKey: 'scSearchToList', area: 'Live' },
  { combo: 'arrowdown', descKey: 'scSearchToList', area: 'Live' },
  { combo: 'escape', descKey: 'scSearchClear', area: 'Live' },
  // Bound by the focused channel list (ChannelList.tsx onKeyDown).
  { combo: 's', descKey: 'scChannelFavorite', area: 'Live' },
  { combo: 'shift+f10', descKey: 'scItemMenu', area: 'Live' },
  { combo: 'contextmenu', descKey: 'scItemMenu', area: 'Live' },
  { combo: 'escape', descKey: 'scVodBack', area: 'Vod' },
  { combo: 'shift+n', descKey: 'sources:shortcutAddSource', area: 'Sources' },
  { combo: 'alt+arrowup', descKey: 'library:shortcutMoveUp', area: 'Favorites' },
  { combo: 'alt+arrowdown', descKey: 'library:shortcutMoveDown', area: 'Favorites' },
  { combo: 'p', descKey: 'library:shortcutPause', area: 'Downloads' },
  { combo: 'r', descKey: 'library:shortcutRetry', area: 'Downloads' },
  { combo: 'x', descKey: 'library:shortcutCancel', area: 'Downloads' },
  { combo: 'delete', descKey: 'library:shortcutRemove', area: 'Downloads' },
  { combo: 'backspace', descKey: 'library:backToLibrary', area: 'My videos' },
  { combo: 'space', descKey: 'scPlayPause', area: 'Playback' },
  { combo: 'k', descKey: 'scPlayPause', area: 'Playback' },
  { combo: 'f', descKey: 'scFullscreen', area: 'Playback' },
  { combo: 'arrowleft', descKey: 'scSeekBack', area: 'Playback' },
  { combo: 'arrowright', descKey: 'scSeekForward', area: 'Playback' },
  { combo: 'n', descKey: 'scNextItem', area: 'Playback' },
  // Bound app-wide by usePlaybackShortcuts (SEEK_STEP_LARGE), not only on the focused seek bar.
  { combo: 'shift+arrowleft', descKey: 'scSeekBackLarge', area: 'Playback' },
  { combo: 'shift+arrowright', descKey: 'scSeekForwardLarge', area: 'Playback' },
  { combo: 'arrowup', descKey: 'scVolumeUp', area: 'Playback' },
  { combo: 'arrowdown', descKey: 'scVolumeDown', area: 'Playback' },
  { combo: 'm', descKey: 'scMute', area: 'Playback' },
  { combo: 'c', descKey: 'scCaptions', area: 'Playback' },
  { combo: 'pageup', descKey: 'scChannelUp', area: 'Playback' },
  { combo: 'pagedown', descKey: 'scChannelDown', area: 'Playback' },
  // Bound by pip.ts only while picture-in-picture is on.
  { combo: 'escape', descKey: 'player:exitPip', area: 'Playback' },
  // Bound by the focused seek bar (SeekBar.tsx onKeyDown). Its own area: PgUp/PgDn mean channel up/down in Playback.
  { combo: 'pageup', descKey: 'scSeekBarPageForward', area: 'Seek bar' },
  { combo: 'pagedown', descKey: 'scSeekBarPageBack', area: 'Seek bar' },
  { combo: 'home', descKey: 'scSeekBarStart', area: 'Seek bar' },
  { combo: 'end', descKey: 'scSeekBarEnd', area: 'Seek bar' },
  { combo: 'arrowup', descKey: 'scListMove', area: 'Dialogs and lists' },
  { combo: 'arrowdown', descKey: 'scListMove', area: 'Dialogs and lists' },
  { combo: 'enter', descKey: 'scListRun', area: 'Dialogs and lists' },
  { combo: 'escape', descKey: 'scListClose', area: 'Dialogs and lists' },
  { combo: 'home', descKey: 'scListJump', area: 'Dialogs and lists' },
  { combo: 'end', descKey: 'scListJump', area: 'Dialogs and lists' },
  { combo: 'pageup', descKey: 'scListPage', area: 'Dialogs and lists' },
  { combo: 'pagedown', descKey: 'scListPage', area: 'Dialogs and lists' },
  { combo: 'arrowleft', descKey: 'scGridMove', area: 'Dialogs and lists' },
  { combo: 'arrowright', descKey: 'scGridMove', area: 'Dialogs and lists' },
  // Favorites, Recent and My videos rows (onRowKeyDown); Downloads registers its own.
  { combo: 'delete', descKey: 'scListRemove', area: 'Dialogs and lists' },
];

const AREA_ORDER = ['Global', 'Navigation', 'Live', 'Vod', 'Sources', 'Favorites', 'Downloads', 'My videos', 'Playback', 'Seek bar', 'Dialogs and lists'];
/**
 * Area id -> fully namespaced i18n key of its display label. Feature areas
 * reuse the label the feature registers under, so documented and registered
 * entries merge. Usable with `t()` from any namespace (Settings imports it).
 */
export const SHORTCUT_AREA_KEYS: Readonly<Record<string, string>> = {
  Global: 'shell:areaGlobal',
  Navigation: 'shell:areaNavigation',
  Live: 'shell:areaLive',
  Vod: 'shell:areaVod',
  Sources: 'sources:title',
  Favorites: 'library:favoritesTitle',
  Downloads: 'library:title',
  'My videos': 'library:myVideosTitle',
  Playback: 'shell:areaPlayback',
  'Seek bar': 'shell:areaSeekBar',
  'Dialogs and lists': 'shell:areaDialogs',
};
const AREA_KEYS = SHORTCUT_AREA_KEYS;

/**
 * Merges registered and documented shortcuts and groups them by area.
 * `label` maps an area id to its display name. Areas are compared by label,
 * so a feature that registers under its own translated area name (Live TV
 * uses `live:shortcutArea`) lands in the same group as the documented `Live`
 * entries and replaces them instead of listing them twice.
 */
export function groupShortcuts(
  registered: ShortcutInfo[],
  documented: ShortcutInfo[],
  label: (area: string) => string = (a) => a,
): [string, ShortcutInfo[]][] {
  const areaOf = (a: string) => label(a).trim().toLowerCase();
  const seen = new Set(registered.map((r) => `${areaOf(r.area)}|${normalizeCombo(r.combo)}`));
  const all = [...registered];
  for (const d of documented) {
    const key = `${areaOf(d.area)}|${normalizeCombo(d.combo)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(d);
  }
  const map = new Map<string, ShortcutInfo[]>();
  const rankOf = new Map<string, number>();
  for (const s of all) {
    const name = label(s.area);
    const list = map.get(name) ?? [];
    list.push(s);
    map.set(name, list);
    const i = AREA_ORDER.indexOf(s.area);
    const r = i < 0 ? AREA_ORDER.length : i;
    rankOf.set(name, Math.min(rankOf.get(name) ?? r, r));
  }
  const rank = (a: string) => rankOf.get(a) ?? AREA_ORDER.length;
  return [...map.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]));
}

/** Text the overlay filter matches: the description, the combo, and its printed keys ("Ctrl", "PgUp"). */
export function shortcutHaystack(s: ShortcutInfo): string {
  return `${s.description} ${s.combo} ${comboKeys(s.combo).join(' ')}`.toLowerCase();
}

export function ShortcutOverlay() {
  const { t } = useTranslation('shell');
  const open = useShellStore((s) => s.helpOpen);
  const setOpen = useShellStore((s) => s.setHelpOpen);
  const registered = useShortcutList();
  const [filter, setFilter] = useState('');
  const idBase = useId();

  const groups = useMemo(() => {
    const documented = DOCUMENTED_SHORTCUTS.map((d) => ({ combo: d.combo, area: d.area, description: t(d.descKey) }));
    const label = (area: string) => {
      const key = AREA_KEYS[area];
      return key ? t(key) : area;
    };
    const q = filter.trim().toLowerCase();
    return groupShortcuts(registered, documented, label)
      .map(([area, list]) => [area, q ? list.filter((s) => shortcutHaystack(s).includes(q)) : list] as const)
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
          {groups.map(([area, list], gi) => (
            // Area names have spaces; an IDREF must not, so the id comes from useId plus the index.
            <section key={area} aria-labelledby={`${idBase}-area-${gi}`}>
              <h3 id={`${idBase}-area-${gi}`} className="mb-2 text-sm font-semibold text-accent">
                {area}
              </h3>
              <dl className="flex flex-col">
                {list.map((s) => (
                  <div
                    key={`${s.combo}|${s.description}`}
                    data-combo={s.combo}
                    className="flex items-center justify-between gap-4 border-b border-divider py-2 last:border-b-0"
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
