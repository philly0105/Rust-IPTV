import { CircleCheck, Info, Play } from 'lucide-react';
import { useCallback, useMemo, useState, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { itemKey, type ItemRef, type ItemSnapshot, type SourceKind } from '@/api/types';
import { useMyListMenuItem } from '@/features/mylist/hooks/useMyListMenuItem';
import { ContextMenu, type MenuItem } from '@/features/live/components/ContextMenu';
import { Poster } from '@/ui';

import { resumeKey } from './queries';
import { usePlayTitle, type PlayTarget } from './usePlayTitle';
import { useToggleWatched, useWatchedKeys } from './useWatched';

/** The title a poster's menu acts on. */
export interface PosterMenuItem {
  ref: ItemRef;
  /** The caption's name (the menu's header and the My List entry). */
  name: string;
  /** The provider's title, for the player. Defaults to `name`. */
  title?: string | undefined;
  year?: number | undefined;
  posterUrl?: string | undefined;
  /** The title's group, so the parental gate can check group locks. */
  categoryId?: string | undefined;
}

export interface PosterMenuOptions {
  sourceKind: SourceKind | undefined;
  /** Saved positions by `resumeKey`: a started movie's menu says Resume. */
  resume: ReadonlyMap<string, number>;
  /** Opens the title's page (a grid remembers its spot first). */
  openDetails: (ref: ItemRef, index: number) => void;
}

/** Where a context menu event opens the menu: the pointer, or the card's middle for the keyboard's menu key. */
export function menuPosition(e: MouseEvent<HTMLElement>, card: Element): { x: number; y: number } {
  if (e.clientX !== 0 || e.clientY !== 0) return { x: e.clientX, y: e.clientY };
  const r = card.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) };
}

/**
 * A poster's menu (right click, Shift+F10, the context-menu key, a long press): Play (or Resume),
 * Open details, My List and Mark as watched, under a header naming the title. Category grids and
 * the landing's rails open the same menu. `open` keeps its identity, so memoised rails keep theirs.
 */
export function usePosterMenu({ sourceKind, resume, openDetails }: PosterMenuOptions) {
  const { t } = useTranslation('vod');
  const [menu, setMenu] = useState<{ pos: { x: number; y: number }; item: PosterMenuItem; index: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const open = useCallback((item: PosterMenuItem, index: number, pos: { x: number; y: number }) => setMenu({ pos, item, index }), []);
  const snapshot = useMemo<ItemSnapshot | undefined>(() => {
    if (!menu) return undefined;
    const s: ItemSnapshot = { title: menu.item.name, contentType: menu.item.ref.contentType };
    if (menu.item.posterUrl) s.posterUrl = menu.item.posterUrl;
    if (menu.item.year) s.subtitle = String(menu.item.year);
    return s;
  }, [menu]);
  const myListItem = useMyListMenuItem(menu && snapshot ? { ref: menu.item.ref, snapshot } : null);
  // L4-vod-4: the menu also plays the title (resuming like the detail page's Play) and marks it watched.
  const menuTitle = useMemo(() => (menu ? [menu.item] : undefined), [menu]);
  const watched = useWatchedKeys(menuTitle).has(menu ? itemKey(menu.item.ref) : '');
  const toggleWatched = useToggleWatched();
  const play = usePlayTitle();
  const playFromMenu = (item: PosterMenuItem, index: number) => {
    // A series has no single thing to play from here: its details pick the episode.
    if (item.ref.contentType !== 'movie' || !sourceKind) return openDetails(item.ref, index);
    const target: PlayTarget = { ref: item.ref, sourceKind, title: item.title ?? item.name };
    if (item.categoryId) target.categoryId = item.categoryId;
    if (item.posterUrl) target.posterUrl = item.posterUrl;
    void play(target);
  };
  // A movie started and not finished resumes from the menu, as the detail page's Resume does.
  const resumes = !!menu && menu.item.ref.contentType === 'movie' && !watched && (resume.get(resumeKey(menu.item.ref)) ?? 0) > 0;
  const items: MenuItem[] = menu
    ? [
        { id: 'play', label: resumes ? t('resume') : t('play'), icon: <Play aria-hidden className="size-4" />, onSelect: () => playFromMenu(menu.item, menu.index) },
        { id: 'open', label: t('openDetails'), icon: <Info aria-hidden className="size-4" />, onSelect: () => openDetails(menu.item.ref, menu.index) },
        ...(myListItem ? [myListItem] : []),
        {
          id: 'watched',
          label: watched ? t('markUnwatched') : t('markWatched'),
          icon: <CircleCheck aria-hidden className="size-4" />,
          onSelect: () => void toggleWatched(menu.item.ref),
        },
      ]
    : [];
  const element = (
    <ContextMenu
      pos={menu?.pos ?? null}
      items={items}
      label={menu?.item.name ?? ''}
      // Names the title the menu acts on: on a phone the sheet covers the poster pressed.
      header={
        menu
          ? {
              title: menu.item.name,
              subtitle: menu.item.year ? String(menu.item.year) : undefined,
              media: <Poster src={menu.item.posterUrl} sourceId={menu.item.ref.sourceId} alt="" label={menu.item.name} className="w-9" rounded="sm" />,
            }
          : undefined
      }
      onClose={close}
    />
  );
  return { open, element, isOpen: menu !== null };
}
