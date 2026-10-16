import { Pin } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { ChannelQuality, LiveAlternate } from '@/api/types';

import { cn } from '../cn';
import { playAlternate, rankAlternates, useAlternatesStore } from '../failover';
import { useLivePin } from '../livePins';
import { usePlayerStore } from '../store';
import { MenuRow } from './Controls';

const QUALITY_LABEL: Record<ChannelQuality, string> = { sd: 'SD', hd: 'HD', fhd: 'FHD', uhd: '4K' };

/** The playing live channel has other copies (the options menu shows its row). */
export function useHasAlternates(): boolean {
  const isLive = usePlayerStore((s) => !!s.source?.isLive);
  return useAlternatesStore((s) => s.status === 'ready' && !!s.data?.alternates.length) && isLive;
}

/** "Alternate sources" row in the options menu root; nothing when the channel has none. */
export function AlternatesRow({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation('player');
  const count = useAlternatesStore((s) => s.data?.alternates.length ?? 0);
  if (!useHasAlternates()) return null;
  return <MenuRow label={t('alternateSources')} value={String(count)} onClick={onOpen} />;
}

function QualityTag({ quality }: { quality: ChannelQuality }) {
  return (
    <span className="shrink-0 rounded-sm border border-white/30 px-1 text-2xs leading-4 font-semibold text-white/80">
      {QUALITY_LABEL[quality]}
    </span>
  );
}

function AlternateItem({ alt, pinned, onPick }: { alt: LiveAlternate; pinned: boolean; onPick(): void }) {
  const { t } = useTranslation('player');
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      data-testid="alternate-source"
      className="flex w-full items-center gap-2 rounded-sm px-3 py-2 text-start text-white hover:bg-white/10 focus-visible:bg-white/10"
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{alt.channel.name}</span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-white/60">
          {pinned && <Pin className="size-3 shrink-0" aria-label={t('preferredSource')} />}
          <span className="truncate">{alt.sourceName}</span>
        </span>
      </span>
      {alt.quality && <QualityTag quality={alt.quality} />}
    </button>
  );
}

/**
 * The "Alternate sources" submenu: other copies of the playing channel, best first (the pinned
 * source leads), and the pin for the source now playing.
 */
export function AlternatesMenu({ onDone }: { onDone(): void }) {
  const { t } = useTranslation('player');
  const data = useAlternatesStore((s) => s.data);
  const status = useAlternatesStore((s) => s.status);
  const source = usePlayerStore((s) => s.source);
  const [pin, setPin] = useLivePin(data?.key);
  const ref = source?.ref;

  if (status === 'loading') {
    return <p className="px-3 py-2 text-sm text-white/70">{t('loading')}</p>;
  }
  const list = data ? rankAlternates(data) : [];
  const pinnedHere = !!pin && !!ref && pin.sourceId === ref.sourceId;

  return (
    <>
      {list.length === 0 ? (
        <p className="px-3 py-2 text-sm text-white/70">{t('alternateSourcesNone')}</p>
      ) : (
        list.map((alt) => (
          <AlternateItem
            key={`${alt.channel.ref.sourceId}|${alt.channel.ref.itemId}`}
            alt={alt}
            pinned={!!pin && pin.sourceId === alt.channel.ref.sourceId && pin.itemId === alt.channel.ref.itemId}
            onPick={() => {
              playAlternate(alt);
              onDone();
            }}
          />
        ))
      )}
      {ref && data && (
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={pinnedHere}
          data-testid="prefer-source"
          onClick={() => setPin(pinnedHere ? null : ref)}
          className={cn(
            'mt-1 flex w-full items-center gap-2 rounded-sm border-t border-white/10 px-3 py-2 text-start text-sm hover:bg-white/10 focus-visible:bg-white/10',
            pinnedHere ? 'text-white dark:text-accent-hover' : 'text-white',
          )}
        >
          <Pin className={cn('size-4 shrink-0', !pinnedHere && 'opacity-50')} aria-hidden />
          <span className="min-w-0 flex-1">{t('preferSource', { channel: source.title })}</span>
        </button>
      )}
    </>
  );
}
