/**
 * The dashboard's channel card menu (Run 2 C2/C3): right click, the context-menu
 * key or Shift+F10 on a live or radio card opens Play, Add to multi-view (TV
 * only), Add to list…, Rename… / Reset name / Hide channel and the parental
 * lock items, the channel entries of Live's menu. The cards ask for it through
 * `ChannelMenuContext` (cards.tsx), so any rail inside the host gets it by
 * passing `channel` to its ChannelCard.
 */

import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import type { Channel, ItemRef, ItemSnapshot } from '@/api/types';
import { scheduleIdleLoad } from '@/shell/idleLoad';

import { CardMenuContext, ChannelMenuContext, type CardMenuRequest, type ChannelMenuRequest } from './cards';

/**
 * The menus themselves, with the multi-view, list, channel-edit, parental and Live menu code they
 * draw, in a chunk of their own: on a cold start Home rendered only after nine more chunks (about
 * 60 kB) that nothing needs before a menu opens.
 */
const loadMenuBody = () => import('./ChannelMenuBody');
const ChannelMenuBody = lazy(() => loadMenuBody().then((m) => ({ default: m.ChannelMenuBody })));

/**
 * The channel a favorite or recent entry stands for, from its saved snapshot:
 * enough for the menu (the ref, the name, the logo, the group name the list
 * picker shows). Category ids are not saved, so multi-view groups it with none;
 * the menu looks the id up for its parental lock items (ChannelMenuHost).
 */
export function snapshotChannel(ref: ItemRef, snapshot: ItemSnapshot): Channel {
  const channel: Channel = {
    ref,
    name: snapshot.title,
    categoryId: '',
    categoryName: snapshot.subtitle ?? '',
    isRadio: ref.contentType === 'radio',
  };
  if (snapshot.posterUrl) channel.logoUrl = snapshot.posterUrl;
  return channel;
}

/**
 * Provides the card menus to the cards below it and draws them: the channel menu, and the plain
 * action menu of a Continue watching card (CardMenuContext). One menu shows at a time. Mount once
 * around the rails.
 */
export function ChannelMenuHost({ children }: { children: ReactNode }) {
  const [menu, setMenuState] = useState<ChannelMenuRequest | null>(null);
  const [actions, setActionsState] = useState<CardMenuRequest | null>(null);
  // The open action menu, so whatever replaces or closes it tells its opener (the hero pauses for it).
  const openRequest = useRef<CardMenuRequest | null>(null);
  const setActions = useCallback((request: CardMenuRequest | null) => {
    const was = openRequest.current;
    openRequest.current = request;
    if (was && was !== request) was.onClose?.();
    setActionsState(request);
  }, []);
  const setMenu = useCallback(
    (request: ChannelMenuRequest) => {
      setActions(null);
      setMenuState(request);
    },
    [setActions],
  );
  const openActions = useCallback(
    (request: CardMenuRequest) => {
      setMenuState(null);
      setActions(request);
    },
    [setActions],
  );
  const close = useCallback(() => {
    setMenuState(null);
    setActions(null);
  }, [setActions]);
  // A host that goes (leaving Home) closes its menu for good.
  useEffect(() => () => openRequest.current?.onClose?.(), []);

  // The menus mount with the first request and stay mounted (their closing pop-out); their chunk
  // loads ahead on the player's schedule, or at the first press, so a first menu rarely waits.
  const [bodyMounted, setBodyMounted] = useState(false);
  if (!bodyMounted && (menu || actions)) setBodyMounted(true);
  useEffect(() => {
    if (bodyMounted) return;
    return scheduleIdleLoad(() => void loadMenuBody().catch(() => undefined));
  }, [bodyMounted]);

  return (
    <ChannelMenuContext.Provider value={setMenu}>
      <CardMenuContext.Provider value={openActions}>
        {children}
        {bodyMounted && (
          <Suspense fallback={null}>
            <ChannelMenuBody menu={menu} actions={actions} onClose={close} />
          </Suspense>
        )}
      </CardMenuContext.Provider>
    </ChannelMenuContext.Provider>
  );
}
