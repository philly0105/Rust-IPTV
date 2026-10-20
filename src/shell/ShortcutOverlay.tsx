import { Fragment, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';
import { comboKeys, Dialog, Kbd, SearchInput } from '@/ui';

import { normalizeCombo, useShortcutList, type ShortcutInfo } from './shortcuts';
import { useShellStore } from './store';

/**
 * Documented shortcuts (README + C16). They are listed even while the
 * feature that binds them is not mounted (e.g. digit zap outside Live), so
 * the overlay is always the complete reference. Registered entries with the
 * same area + combo replace these.
 */
export const DOCUMENTED_SHORTCUTS: readonly { combo: string; descKey: string; area: string; desktopOnly?: true }[] = [
  { combo: 'mod+k', descKey: 'scPalette', area: 'Global' },
  { combo: 'mod+f', descKey: 'scSearch', area: 'Global' },
  // A browser keeps Ctrl+R for reload (SH-ctrl-r-browser); only the app window binds it.
  { combo: 'mod+r', descKey: 'scRecent', area: 'Global', desktopOnly: true },
  { combo: '?', descKey: 'scHelp', area: 'Global' },
  { combo: 'escape', descKey: 'scEscape', area: 'Global' },
  { combo: 'mod+shift+l', descKey: 'scTheme', area: 'Global' },
  { combo: 'f8', descKey: 'scNotifications', area: 'Global' },
  { combo: 'f11', descKey: 'scFullscreen', area: 'Global' },
  // Bound by useParentalEvents only while a session unlock is active.
  { combo: 'mod+alt+l', descKey: 'parental:shortcutLockNow', area: 'Parental controls' },
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
  // Run 2 (C11): the focused channel row. `l` is a document listener (useAddToListShortcut); F2 and Shift+Delete are channel edits.
  { combo: 'l', descKey: 'lists:shortcutAddToList', area: 'Live' },
  { combo: 'f2', descKey: 'channels:shortcutRename', area: 'Live' },
  { combo: 'shift+delete', descKey: 'channels:shortcutHide', area: 'Live' },
  // The focused channel list (ChannelList.tsx onKeyDown): while a live channel plays, plain Page Up/Down zap.
  { combo: 'shift+pageup', descKey: 'scChannelListPage', area: 'Live' },
  { combo: 'shift+pagedown', descKey: 'scChannelListPage', area: 'Live' },
  // Guide (EpgGridPage.tsx): search and jump to a date and time.
  { combo: '/', descKey: 'guide:searchLabel', area: 'Guide' },
  { combo: 't', descKey: 'guide:jumpTitle', area: 'Guide' },
  // Only inside the Manage lists and Edit channels dialogs (SortableList.tsx onKeyDown); the list
  // page and the Lists sidebar reorder through those dialogs, so the text names them.
  { combo: 'alt+arrowup', descKey: 'scListsDialogMoveUp', area: 'Lists' },
  { combo: 'alt+arrowdown', descKey: 'scListsDialogMoveDown', area: 'Lists' },
  // Multi-view page (MultiviewPage.tsx); the focused-slot keys are bound by the wall (useWallKeyboard.ts).
  { combo: 'digit', descKey: 'multiview:shortcutSound', area: 'Multi-view' },
  { combo: 'f', descKey: 'multiview:shortcutFullscreen', area: 'Multi-view' },
  { combo: 'm', descKey: 'multiview:shortcutMute', area: 'Multi-view' },
  { combo: 'l', descKey: 'multiview:shortcutLayout', area: 'Multi-view' },
  { combo: 'a', descKey: 'multiview:shortcutAdd', area: 'Multi-view' },
  { combo: 'escape', descKey: 'multiview:shortcutSwapCancel', area: 'Multi-view' },
  { combo: 'arrowleft', descKey: 'multiview:shortcutFocusMove', area: 'Multi-view' },
  { combo: 'arrowright', descKey: 'multiview:shortcutFocusMove', area: 'Multi-view' },
  { combo: 'arrowup', descKey: 'multiview:shortcutFocusMove', area: 'Multi-view' },
  { combo: 'arrowdown', descKey: 'multiview:shortcutFocusMove', area: 'Multi-view' },
  { combo: 'home', descKey: 'multiview:shortcutFocusEnds', area: 'Multi-view' },
  { combo: 'end', descKey: 'multiview:shortcutFocusEnds', area: 'Multi-view' },
  { combo: 'enter', descKey: 'multiview:shortcutGiveSound', area: 'Multi-view' },
  { combo: 'space', descKey: 'multiview:shortcutGiveSound', area: 'Multi-view' },
  { combo: 'delete', descKey: 'multiview:shortcutCloseTile', area: 'Multi-view' },
  { combo: 'backspace', descKey: 'multiview:shortcutCloseTile', area: 'Multi-view' },
  { combo: 'r', descKey: 'multiview:shortcutReplaceTile', area: 'Multi-view' },
  { combo: 's', descKey: 'multiview:shortcutSwapTile', area: 'Multi-view' },
  { combo: 'escape', descKey: 'scVodBack', area: 'Vod' },
  // Bound by the movie and series grid (CategoryGridPage.tsx) while it shows posters.
  { combo: 's', descKey: 'vod:shortcutMyList', area: 'Vod' },
  { combo: 'shift+f10', descKey: 'vod:shortcutPosterMenu', area: 'Vod' },
  { combo: 'contextmenu', descKey: 'vod:shortcutPosterMenu', area: 'Vod' },
  { combo: 'w', descKey: 'vod:shortcutWatched', area: 'Vod' },
  { combo: 'shift+w', descKey: 'vod:shortcutHideWatched', area: 'Vod' },
  // The search page (SearchPage.tsx): the header field's onKeyDown and the first result's ArrowUp.
  { combo: 'arrowdown', descKey: 'scSearchToResults', area: 'Search' },
  { combo: 'arrowup', descKey: 'scResultsToSearch', area: 'Search' },
  // My List page (MyListPage.tsx), acting on the focused row.
  { combo: 'alt+arrowup', descKey: 'mylist:shortcutMoveUp', area: 'My List' },
  { combo: 'alt+arrowdown', descKey: 'mylist:shortcutMoveDown', area: 'My List' },
  { combo: 'delete', descKey: 'mylist:shortcutRemove', area: 'My List' },
  { combo: 'w', descKey: 'mylist:shortcutWatched', area: 'My List' },
  { combo: 'shift+n', descKey: 'sources:shortcutAddSource', area: 'Sources' },
  // Bound by the focused source card (SourceCard.tsx onKeyDown); plain arrows on its grip too.
  { combo: 'alt+arrowup', descKey: 'sources:shortcutMoveUp', area: 'Sources' },
  { combo: 'alt+arrowdown', descKey: 'sources:shortcutMoveDown', area: 'Sources' },
  { combo: 'alt+arrowup', descKey: 'library:shortcutMoveUp', area: 'Favorites' },
  { combo: 'alt+arrowdown', descKey: 'library:shortcutMoveDown', area: 'Favorites' },
  { combo: 'p', descKey: 'library:shortcutPause', area: 'Downloads' },
  { combo: 'r', descKey: 'library:shortcutRetry', area: 'Downloads' },
  { combo: 'x', descKey: 'library:shortcutCancel', area: 'Downloads' },
  { combo: 'delete', descKey: 'library:shortcutRemove', area: 'Downloads' },
  { combo: 'o', descKey: 'library:shortcutReveal', area: 'Downloads' },
  { combo: 'backspace', descKey: 'library:backToLibrary', area: 'My videos' },
  { combo: '7', descKey: 'stats:showWeek', area: 'Stats' },
  { combo: '3', descKey: 'stats:showMonth', area: 'Stats' },
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
  // player: navigation, sync and stream info shortcuts (usePlaybackShortcuts.ts).
  { combo: 'j', descKey: 'player:shortcutSeekBack10', area: 'Playback' },
  { combo: 'l', descKey: 'player:shortcutSeekForward10', area: 'Playback' },
  { combo: 'shift+p', descKey: 'player:shortcutPrevItem', area: 'Playback' },
  { combo: 'b', descKey: 'player:shortcutPrevChannel', area: 'Playback' },
  { combo: 'shift+b', descKey: 'player:shortcutChannelHistory', area: 'Playback' },
  { combo: 'g', descKey: 'player:shortcutSubDelayDown', area: 'Playback' },
  { combo: 'h', descKey: 'player:shortcutSubDelayUp', area: 'Playback' },
  { combo: 'shift+g', descKey: 'player:shortcutAudioDelayDown', area: 'Playback' },
  { combo: 'shift+h', descKey: 'player:shortcutAudioDelayUp', area: 'Playback' },
  { combo: 'i', descKey: 'player:shortcutStreamInfo', area: 'Playback' },
  { combo: 'shift+c', descKey: 'player:shortcutSubtitleMenu', area: 'Playback' },
  { combo: 'z', descKey: 'scSleepTimer', area: 'Playback' },
  // Run 3 C6: bound while a video plays in the app; a focused Live row or multi-view tile keeps its own `s`.
  { combo: 's', descKey: 'player:screenshot', area: 'Playback' },
  // Bound by pip.ts only while picture-in-picture is on.
  { combo: 'escape', descKey: 'player:exitPip', area: 'Playback' },
  // The keyboard's media keys (usePlaybackShortcuts.ts, L3-desktop-5); they work in a text field too.
  { combo: 'mediaplaypause', descKey: 'player:shortcutMediaPlayPause', area: 'Playback' },
  { combo: 'mediastop', descKey: 'player:shortcutMediaStop', area: 'Playback' },
  { combo: 'mediatracknext', descKey: 'player:shortcutMediaNext', area: 'Playback' },
  { combo: 'mediatrackprevious', descKey: 'player:shortcutMediaPrevious', area: 'Playback' },
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
  // Favorites and Recent rows and a My Videos title's episode rows (onRowKeyDown); Downloads registers
  // its own. The My Videos grid has no Delete: a title is removed from its page.
  { combo: 'delete', descKey: 'scListRemove', area: 'Dialogs and lists' },
  // Run 3 first-run tour (onboarding/tour/Tour.tsx): its own capture-phase key handler while it is
  // open. The arrows follow the reading direction (mirrored in RTL), so one text covers both.
  { combo: 'escape', descKey: 'scTourSkip', area: 'Tour' },
  { combo: 'arrowleft', descKey: 'scTourStep', area: 'Tour' },
  { combo: 'arrowright', descKey: 'scTourStep', area: 'Tour' },
  // Replaying it: the palette's "Take the tour" command (CommandPalette.tsx, help.tour).
  { combo: 'mod+k', descKey: 'scTourReplay', area: 'Tour' },
];

/**
 * The order of the groups: what every screen shares, then playback (the most used), live TV and
 * the guide, the other pages, the keys of lists and dialogs, and the rare ones last (parental
 * controls, then the tour, whose replay row closes the reference).
 */
const AREA_ORDER = [
  'Global',
  'Playback',
  'Seek bar',
  'Live',
  'Guide',
  'Multi-view',
  'Vod',
  'Search',
  'Navigation',
  'Lists',
  'My List',
  'Favorites',
  'Sources',
  'Downloads',
  'My videos',
  'Stats',
  'Dialogs and lists',
  'Parental controls',
  'Tour',
];
/**
 * Area id -> fully namespaced i18n key of its display label. Feature areas
 * reuse the label the feature registers under, so documented and registered
 * entries merge. Usable with `t()` from any namespace; `shortcutReference`
 * is the one place that reads it.
 */
export const SHORTCUT_AREA_KEYS: Readonly<Record<string, string>> = {
  Global: 'shell:areaGlobal',
  'Parental controls': 'shell:settingsParental',
  Navigation: 'shell:areaNavigation',
  Live: 'shell:areaLive',
  Guide: 'guide:shortcutArea',
  Lists: 'lists:title',
  'Multi-view': 'multiview:shortcutArea',
  Vod: 'shell:areaVod',
  Search: 'shell:navSearch',
  'My List': 'mylist:title',
  Sources: 'sources:title',
  Favorites: 'library:favoritesTitle',
  Downloads: 'library:title',
  'My videos': 'library:myVideosTitle',
  Stats: 'stats:title',
  Playback: 'shell:areaPlayback',
  'Seek bar': 'shell:areaSeekBar',
  'Dialogs and lists': 'shell:areaDialogs',
  Tour: 'shell:areaTour',
};

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

/**
 * The full shortcut reference, as both the ? overlay and Settings > Shortcuts
 * show it: the registered shortcuts merged with the documented ones, grouped
 * under translated area names. `t` must resolve namespaced keys
 * (`multiview:shortcutArea`), which any `useTranslation` t does. Sharing this
 * keeps the two lists from drifting apart (an area missing from a second
 * label map used to show its raw English id in Settings).
 */
export function shortcutReference(registered: ShortcutInfo[], t: (key: string) => string, desktop = isDesktop): [string, ShortcutInfo[]][] {
  const documented = DOCUMENTED_SHORTCUTS.filter((d) => desktop || !d.desktopOnly).map((d) => ({ combo: d.combo, area: d.area, description: t(d.descKey) }));
  const label = (area: string) => {
    const key = SHORTCUT_AREA_KEYS[area];
    return key ? t(key) : area;
  };
  return groupShortcuts(registered, documented, label);
}

/**
 * One row per action: keys that do the same thing in an area (Enter and Down both move from the
 * search box to the list) share a row, "Enter or Down", instead of the sentence twice. Order is
 * kept. Settings > Shortcuts merges its rows the same way.
 */
export function mergeShortcutRows(items: readonly ShortcutInfo[]): { description: string; combos: string[] }[] {
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

/** Text the overlay filter matches: the description, the combo, and its printed keys ("Ctrl", "PgUp"). */
export function shortcutHaystack(s: ShortcutInfo): string {
  return `${s.description} ${s.combo} ${comboKeys(s.combo).join(' ')}`.toLowerCase();
}

/**
 * The `?` overlay. While closed it reads only `helpOpen`: the registry subscription and the
 * reference build live in the open dialog, so registrations (a page mounting, a shortcut whose
 * `enabled` follows a held key) cost the closed overlay nothing (L2-perf-ui-8, L2-live-12).
 */
export function ShortcutOverlay() {
  const open = useShellStore((s) => s.helpOpen);
  return open ? <OpenShortcutOverlay /> : null;
}

/** Mounted only while open, so the filter starts empty each time. */
function OpenShortcutOverlay() {
  const { t } = useTranslation('shell');
  const setOpen = useShellStore((s) => s.setHelpOpen);
  const registered = useShortcutList();
  const [filter, setFilter] = useState('');
  const idBase = useId();

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return shortcutReference(registered, t)
      .map(([area, list]) => [area, q ? list.filter((s) => shortcutHaystack(s).includes(q)) : list] as const)
      .filter(([, list]) => list.length > 0);
  }, [registered, filter, t]);

  return (
    <Dialog
      open
      onClose={() => setOpen(false)}
      title={t('keyboardShortcuts')}
      description={t('shortcutsIntro')}
      // Wide enough for two columns of one-line rows; the filter stays put while the list scrolls,
      // and the list fades out at the bottom edge where it continues.
      size="xl"
      bodyClassName="pb-8 [mask-image:linear-gradient(to_bottom,#000_calc(100%-2rem),transparent)]"
      testId="shortcut-overlay"
    >
      <div className="sticky top-0 z-[1] -mx-1 bg-surface px-1 pt-1 pb-4">
        <SearchInput value={filter} onChange={setFilter} placeholder={t('filterShortcuts')} size="sm" data-autofocus="" />
      </div>
      {groups.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t('noShortcutsMatch')}</p>
      ) : (
        // Focusable so arrow and Page keys scroll a long list from the keyboard.
        <div
          role="region"
          aria-label={t('shortcutsListLabel')}
          tabIndex={0}
          // Two balanced columns: each area flows into the next, with no gap where a short one sat beside a long one.
          className="gap-x-10 rounded-md md:columns-2"
        >
          {groups.map(([area, list], gi) => (
            // Area names have spaces; an IDREF must not, so the id comes from useId plus the index.
            <section key={area} aria-labelledby={`${idBase}-area-${gi}`} className="mb-7 min-w-0 break-inside-avoid">
              {/* Quiet group labels in sentence case, as the rail, the palette and the More sheet label their groups. */}
              <h3 id={`${idBase}-area-${gi}`} className="mb-1.5 text-caption font-medium text-fg-subtle">
                {area}
              </h3>
              <dl className="flex flex-col">
                {mergeShortcutRows(list).map((s) => (
                  <div
                    key={`${s.combos.join(' ')}|${s.description}`}
                    data-combo={s.combos[0]}
                    data-combos={s.combos.join(' ')}
                    className="flex min-h-10 items-center justify-between gap-4 border-b border-divider py-1.5 last:border-b-0"
                  >
                    <dt className="text-body-sm text-fg">{s.description}</dt>
                    <dd className="flex shrink-0 items-center gap-1.5">
                      {s.combos.map((combo, i) => (
                        <Fragment key={combo}>
                          {i > 0 && <span className="text-caption text-fg-subtle">{t('settings:shortcutsOr')}</span>}
                          <Kbd combo={combo} />
                        </Fragment>
                      ))}
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
