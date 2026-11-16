import { Heart } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext } from 'react-router';

import { invalidate, queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import type { ItemRef } from '@/api/types';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { plainChannelName } from '@/lib/channelName';
import { errorDescription } from '@/ui/States';
import { toast } from '@/ui/Toast';

import { usePlayerStore } from '../store';
import { usePlayerSettings } from '../useSettings';
import { MenuAction } from './Controls';

/**
 * What can be done with the live channel playing, from the player's own menus (the options menu,
 * the video's context menu): keep it as a favourite, put it on the multi-view wall. Before, both
 * were only on the page's channel rows, so a channel found while zapping in fullscreen meant
 * leaving it. `onDone` closes the menu. Nothing for VOD, radio or a stream without a catalog ref.
 */
export function ChannelActions({ onDone }: { onDone(): void }) {
  const ref = usePlayerStore((s) => (s.source?.isLive && s.source.ref?.contentType === 'live' ? s.source.ref : undefined));
  const inRouter = useInRouterContext();
  if (!ref) return null;
  return (
    <>
      <FavoriteAction channel={ref} onDone={onDone} />
      {/* The wall opens through the router (its toast's Open); a player outside one has no wall. */}
      {inRouter && <MultiviewAction channel={ref} onDone={onDone} />}
    </>
  );
}

/** The heart, as on the Live list's rows: neutral, filled while the channel is a favourite. */
function FavoriteAction({ channel, onDone }: { channel: ItemRef; onDone(): void }) {
  const { t } = useTranslation('live');
  const strip = usePlayerSettings()?.stripCountryPrefix;
  // Read through the shared client, not a query hook: the player can be drawn outside the app's
  // query provider. One answer per menu opening.
  const [favorite, setFavorite] = useState(false);
  useEffect(() => {
    let live = true;
    const args = { refs: [channel] };
    queryClient
      .fetchQuery({ queryKey: rpcKey('favorites.contains', args), queryFn: () => rpc('favorites.contains', args), staleTime: 30_000 })
      .then(
        (found) => {
          if (live) setFavorite(found.length > 0);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [channel]);
  const busy = useRef(false);
  const toggle = async (): Promise<void> => {
    if (busy.current) return;
    busy.current = true;
    const { title = '', posterUrl } = usePlayerStore.getState().source ?? {};
    try {
      const res = await rpc('favorites.toggle', {
        ref: channel,
        snapshot: { title, contentType: channel.contentType, ...(posterUrl ? { posterUrl } : {}) },
      });
      await invalidate('favorites.');
      const name = plainChannelName(title, strip);
      toast({ title: res.isFavorite ? t('favoriteAdded', { name }) : t('favoriteRemoved', { name }), variant: 'success' });
    } catch (err) {
      toast({ title: favorite ? t('favoriteRemoveFailed') : t('favoriteAddFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      busy.current = false;
    }
  };
  return (
    <MenuAction
      icon={<Heart aria-hidden className={favorite ? 'fill-current' : undefined} />}
      label={favorite ? t('removeFavorite') : t('addFavorite')}
      onClick={() => {
        onDone();
        void toggle();
      }}
    />
  );
}

/** "Add to multi-view", the channel rows' action (`useMultiviewMenuItem`), for what plays. */
function MultiviewAction({ channel, onDone }: { channel: ItemRef; onDone(): void }) {
  const { t } = useTranslation('multiview');
  const title = usePlayerStore((s) => s.source?.title);
  const logo = usePlayerStore((s) => s.source?.posterUrl);
  const item = useMultiviewMenuItem({ ref: channel, title: title ?? channel.itemId, ...(logo ? { logo } : {}) });
  return (
    <MenuAction
      icon={item.icon}
      label={t('menuAdd')}
      disabled={item.disabled}
      onClick={() => {
        onDone();
        item.onSelect();
      }}
    />
  );
}
