/**
 * The channel menu, one builder for every place a channel row has one (LG-13, LG-16): the Live and
 * Radio lists, a custom list's rows and the guide's channel cells. It used to be three hand-made
 * menus, and a list row lacked catch-up, the external players, multi-view and guide matching.
 *
 * Sections, separated by rules (empty ones fold away):
 * - Watch: Play, Browse catch-up, Play in MPV / VLC (desktop app only).
 * - Organize: Favorite, Add to multi-view, Add to list…, and the caller's own (Remove from list).
 * - Channel: Copy link, Rename / Reset name / Hide, Match guide channel, Lock.
 */

import { Copy, ExternalLink, History, Link2, Play, Star } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { isDesktop } from '@/api/transport';
import type { Channel, Source } from '@/api/types';
import { errorDescription, toast } from '@/ui';
import { useChannelEditMenuItems } from '@/features/channeledit';
import { useAddToListMenuItem } from '@/features/lists/hooks/useAddToList';
import { channelInput } from '@/features/multiview/addChannel';
import { useMultiviewMenuItem } from '@/features/multiview/useMultiviewMenuItem';
import { useLockMenuItems } from '@/features/parental/lockMenu';
import { usePlayerStore } from '@/features/player';
import { canShareSource, isShareableUrl } from '@/features/player/shareable';

import { ChannelLogo } from '../components/ChannelLogo';
import type { MenuEntry, MenuHeader, MenuItem } from '../components/ContextMenu';
import { archivePath, canBrowseArchive } from '../lib/archive';
import { displayChannelName } from '../lib/channelName';
import { openChannelSource } from '../lib/playback';
import { useDisplayPrefs } from './useDisplayPrefs';

export interface ChannelMenuOptions {
  /** The channel's source: its kind decides catch-up and Copy link, and external players resolve through it. */
  source: Pick<Source, 'id' | 'kind' | 'm3u'> | undefined;
  /** Whether it is a favorite; undefined while unknown (the entry waits, disabled). */
  favorite: boolean | undefined;
  onPlay(channel: Channel): void;
  onToggleFavorite(channel: Channel, wasFavorite: boolean): void;
  /** "Match guide channel"; left out without it. */
  onMapGuide?(channel: Channel): void;
  /** Entries the caller adds at the end of Organize (a list's "Remove from list"). */
  organize?: readonly MenuItem[];
  /**
   * Show F2 and Shift+Delete beside Rename and Hide. Only where the page binds them (the Live and
   * list rows); the guide does not.
   */
  editHints?: boolean;
}

const sep = (id: string): MenuEntry => ({ id, type: 'separator' });

/** A kit `MenuAction` (multi-view, lists, edits, locks) as one of this menu's items. */
function plain(a: MenuItem, hints: boolean): MenuItem {
  return { id: a.id, label: a.label, icon: a.icon, disabled: a.disabled, danger: a.danger, onSelect: a.onSelect, ...(hints && a.hint ? { hint: a.hint } : {}) };
}

export function useChannelMenuItems(channel: Channel | null, opts: ChannelMenuOptions): MenuEntry[] {
  const { t } = useTranslation('live');
  const navigate = useNavigate();
  const { stripCountryPrefix } = useDisplayPrefs();
  const name = channel ? displayChannelName(channel.name, stripCountryPrefix) : '';
  // C4: radio has no picture, so a station gets no multi-view entry.
  const live = channel?.ref.contentType === 'live';
  // The tile is titled as the row names the channel (settings.stripCountryPrefix).
  const multiviewItem = useMultiviewMenuItem(channel && live ? { ...channelInput(channel), title: name } : null);
  const addToListItem = useAddToListMenuItem(channel);
  const editItems = useChannelEditMenuItems(channel);
  // C2: lock / remove lock for the channel or station.
  const lockItems = useLockMenuItems(
    channel ? { sourceId: channel.ref.sourceId, contentType: channel.ref.contentType, kind: 'item', targetId: channel.ref.itemId, name } : null,
    { categoryId: channel?.categoryId },
  );
  const { source, favorite, onPlay, onToggleFavorite, onMapGuide, organize, editHints = false } = opts;

  return useMemo((): MenuEntry[] => {
    if (!channel) return [];
    const ch = channel;
    const src = source && source.id === ch.ref.sourceId ? source : undefined;
    const external = async (player: 'mpv' | 'vlc') => {
      if (!src) return;
      try {
        // C2: a locked channel or group asks for the PIN first, as inline playback does.
        const s = await openChannelSource(ch, src, name);
        if (!s) return;
        // The stage says what plays where, with Stop and Reopen (the player's ExternalStage), instead
        // of "Nothing playing"; the in-app player gives way to it (L2-desktop-9). The store opens it and
        // remembers the player chosen here, so Reopen uses it too (L3-live-ch-x4); a failed open shows
        // on the stage with Retry.
        const store = usePlayerStore.getState();
        if (store.source && store.mode !== 'external') store.stop();
        // The ref marks the row and the ribbon as playing, as an inline play does.
        await store.play({ ...s, ref: s.ref ?? ch.ref }, { mode: 'external', externalPlayer: player, queue: [] });
      } catch (err) {
        toast({ title: t('externalFailed', { player: player.toUpperCase() }), description: errorDescription(err), variant: 'error' });
      }
    };
    const copy = async () => {
      if (!src) return;
      try {
        // C2: copying a locked channel's link needs the PIN like playing it.
        const s = await openChannelSource(ch, src, name);
        if (!s) return;
        if (!canShareSource(s, () => src.kind)) {
          toast({ title: t('copyFailed'), variant: 'error' });
          return;
        }
        await navigator.clipboard.writeText(s.url);
        toast({ title: t('urlCopied'), variant: 'success' });
      } catch (err) {
        toast({ title: t('copyFailed'), description: errorDescription(err), variant: 'error' });
      }
    };
    const out: MenuEntry[] = [
      { id: 'play', label: t('play'), icon: <Play className="size-4" />, onSelect: () => onPlay(ch) },
      // guide: the channel's catch-up archive browser.
      ...(src && canBrowseArchive(ch, src.kind)
        ? [{ id: 'archive', label: t('browseArchive'), icon: <History className="size-4" />, onSelect: () => void navigate(archivePath(ch.ref)) }]
        : []),
      // External players run only in the desktop app; the server answers `unsupported` (as InlinePlayer gates them).
      ...(isDesktop && src
        ? [
            { id: 'mpv', label: t('playIn', { player: 'MPV' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('mpv') },
            { id: 'vlc', label: t('playIn', { player: 'VLC' }), icon: <ExternalLink className="size-4" />, onSelect: () => void external('vlc') },
          ]
        : []),
      sep('sep-organize'),
      {
        id: 'fav',
        label: favorite ? t('removeFavorite') : t('addFavorite'),
        icon: <Star className="size-4" fill={favorite ? 'currentColor' : 'none'} />,
        // Until the answer is in, the entry would not know which way it goes.
        disabled: favorite === undefined,
        onSelect: () => onToggleFavorite(ch, !!favorite),
      },
      ...(live ? [plain(multiviewItem, false)] : []),
      ...(addToListItem ? [plain(addToListItem, false)] : []),
      ...(organize ?? []),
      sep('sep-channel'),
      // Xtream and Stalker links carry the login (and so can a playlist link): only a link with no
      // credentials in it is offered, and the resolved link is checked again before it is copied.
      ...(src?.kind === 'm3u' && !!ch.url && isShareableUrl(ch.url)
        ? [{ id: 'copy', label: t('copyUrl'), icon: <Copy className="size-4" />, onSelect: () => void copy() }]
        : []),
      ...editItems.map((a) => plain(a, editHints)),
      ...(onMapGuide ? [{ id: 'epg', label: t('mapEpg'), icon: <Link2 className="size-4" />, onSelect: () => onMapGuide(ch) }] : []),
      ...lockItems.map((a) => plain(a, false)),
    ];
    return out;
  }, [channel, source, favorite, name, live, t, navigate, onPlay, onToggleFavorite, onMapGuide, organize, editHints, multiviewItem, addToListItem, editItems, lockItems]);
}

/** The menu's header for a channel: its logo, its name and what is on (LG-16). */
export function channelMenuHeader(channel: Channel, name: string, nowTitle?: string): MenuHeader {
  return {
    title: name,
    subtitle: nowTitle,
    media: <ChannelLogo src={channel.logoUrl} name={name} size={28} sourceId={channel.ref.sourceId} />,
  };
}
