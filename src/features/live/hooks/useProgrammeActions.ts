/**
 * What can be done with one programme of a channel's archive: play it from catch-up, download it
 * and copy its link. The guide's programme detail and the channel menu opened on a programme both
 * offer them, so they share this one implementation.
 */

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { rpc } from '@/api/transport';
import { invalidate } from '@/api/query';
import type { Channel, EpgProgram, Source } from '@/api/types';
import { errorDescription, toast } from '@/ui';
import { copyText } from '@/lib/clipboard';
import { downloadToastId } from '@/features/library/lib/queue';
import { canShareSource } from '@/features/player/shareable';

import { displayChannelName } from '../lib/channelName';
import { canCatchUp, formatClock, formatDay, ms, programWhen } from '../lib/epgTime';
import { canDownloadCatchup, catchupDownloadArgs, catchupSource, playCatchup } from '../lib/playback';
import { useDisplayPrefs } from './useDisplayPrefs';

export interface ProgrammeActions {
  /** Plays an ended programme from catch-up. */
  watch?(): void;
  /** Queues an ended programme's archive as a download (Xtream, Stalker, M3U with an end placeholder). */
  download?(): void;
  /** Copies the programme's archive link (ended or airing). */
  copy?(): void;
}

/**
 * `onLink` receives the resolved link when the clipboard refused it (the provider's answer came
 * too long after the press for some browsers), so the caller can offer it to copy by hand.
 * Each action is left out when the channel, its source or the programme cannot do it.
 */
export function useProgrammeActions(
  channel: Channel | null,
  source: Pick<Source, 'id' | 'kind'> | undefined,
  programme: EpgProgram | undefined,
  now: number,
  onLink?: (url: string, programme: EpgProgram) => void,
): ProgrammeActions {
  const { t, i18n } = useTranslation('live');
  const navigate = useNavigate();
  const { stripCountryPrefix } = useDisplayPrefs();

  return useMemo((): ProgrammeActions => {
    const src = channel && source && source.id === channel.ref.sourceId ? source : undefined;
    if (!channel || !src || !programme || !canCatchUp(programme, channel, src.kind, now)) return {};
    const ch = channel;
    const name = displayChannelName(ch.name, stripCountryPrefix);
    const ended = programWhen(programme, now) === 'past';
    const copy = async () => {
      let url: string;
      try {
        const s = await catchupSource(ch, src.kind, programme, now);
        // Timeshift URLs from Xtream/Stalker must retain the provider login in their path so that
        // VLC/MPV can open them. Ordinary channel copies still use the stricter policy.
        if (!canShareSource(s, () => src.kind, { allowCredentials: true })) {
          toast({ title: t('copyFailed'), variant: 'error' });
          return;
        }
        url = s.url;
      } catch (err) {
        toast({ title: t('copyFailed'), description: errorDescription(err), variant: 'error' });
        return;
      }
      try {
        await copyText(url);
        toast({ title: t('programmeLinkCopied'), variant: 'success' });
      } catch (err) {
        if (onLink) onLink(url, programme);
        else toast({ title: t('copyFailed'), description: errorDescription(err), variant: 'error' });
      }
    };
    const download = async () => {
      try {
        const at = ms(programme.start);
        const subtitle = `${programme.title} · ${formatDay(at, i18n.language)} ${formatClock(at, i18n.language)}`;
        const args = await catchupDownloadArgs(ch, src.kind, programme, {
          now, displayName: name, subtitle, notFileMessage: t('downloadNotFile', { ns: 'vod' }),
        });
        if (!args) return;
        const queued = await rpc('downloads.start', args);
        void invalidate('downloads.');
        toast({
          // The download's own id: its Downloaded (or failed) toast replaces this one in place.
          id: downloadToastId(queued.id),
          title: t('downloadQueued', { ns: 'vod' }),
          description: `${name}  ${programme.title}`,
          variant: 'success',
          action: { label: t('openDownloads', { ns: 'vod' }), onClick: () => void navigate('/downloads') },
        });
      } catch (err) {
        toast({ title: t('downloadFailed', { ns: 'vod' }), description: errorDescription(err), variant: 'error' });
      }
    };
    const watch = () => {
      void playCatchup(ch, src.kind, programme, now, name).catch((err: unknown) =>
        toast({ title: t('catchupFailed'), description: errorDescription(err), variant: 'error' }),
      );
    };
    return {
      ...(ended ? { watch } : {}),
      ...(ended && canDownloadCatchup(ch, src.kind) ? { download: () => void download() } : {}),
      copy: () => void copy(),
    };
  }, [channel, source, programme, now, onLink, stripCountryPrefix, t, i18n.language, navigate]);
}
