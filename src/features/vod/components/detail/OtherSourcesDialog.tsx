import { Pin, PinOff, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ItemRef, Source, VodItem } from '@/api/types';

import { formatRating } from '../../lib/format';
import { isPinned, type SourcePin } from '../../lib/pins';
import { detailHref } from '../../lib/search';
import { Button, Dialog, IconButton, Poster, PosterCellWidthContext, buttonClass, cn, usePosterWidthBox, useScaledPx } from '@/ui';

export interface OtherSourcesDialogProps {
  open: boolean;
  onClose: () => void;
  current: VodItem;
  currentSourceName: string;
  others: VodItem[];
  sources: Map<string, Source>;
  pin: SourcePin | undefined;
  onPin: (ref: ItemRef | null) => void;
  onPlay: (item: VodItem) => void;
}

/**
 * Every copy of this title across the user's sources. Each row can play,
 * open its own detail, or be pinned as the preferred source for Play.
 */
export function OtherSourcesDialog({ open, onClose, current, currentSourceName, others, sources, pin, onPin, onPlay }: OtherSourcesDialogProps) {
  const { t } = useTranslation('vod');
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t('otherSourcesTitle')} description={t('otherSourcesHint', { count: others.length + 1 })}>
      <OtherSourcesList
        current={current}
        currentSourceName={currentSourceName}
        others={others}
        sources={sources}
        pin={pin}
        onPin={onPin}
        onPlay={onPlay}
        onOpen={onClose}
      />
    </Dialog>
  );
}

export type OtherSourcesListProps = Omit<OtherSourcesDialogProps, 'open' | 'onClose'> & {
  /** Runs when a row's "Open details" link is followed (the dialog closes). */
  onOpen?: () => void;
};

/** A copy's thumbnail, `w-10`: ten spacing steps of 3.75 px at 100 % scale. */
const THUMB_PX = 37.5;

/**
 * The copies of one title, one row each: the source, the copy's year, rating and container, and
 * Pin, Open details and Play. The dialog and the detail page's "Other sources" section share it.
 */
export function OtherSourcesList({ current, currentSourceName, others, sources, pin, onPin, onPlay, onOpen }: OtherSourcesListProps) {
  const { t, i18n } = useTranslation('vod');
  // P2-POSTERS-2: the thumbnails' width is known (`w-10`), so they do not read their frames as they mount.
  const thumbWidth = usePosterWidthBox(useScaledPx(THUMB_PX, true));
  const rows: { item: VodItem; sourceName: string; isCurrent: boolean }[] = [
    { item: current, sourceName: currentSourceName, isCurrent: true },
    ...others.map((item) => ({ item, sourceName: sources.get(item.ref.sourceId)?.name ?? item.ref.sourceId, isCurrent: false })),
  ];
  return (
    <ul className="flex flex-col divide-y divide-divider">
      {rows.map(({ item, sourceName, isCurrent }) => {
        const pinned = isPinned(pin, item.ref);
        const rating = formatRating(item.rating, i18n.language);
        return (
          <li key={`${item.ref.sourceId}|${item.ref.itemId}`} className={cn('flex items-center gap-3 py-3', pinned && 'tuning-tick ps-3')}>
            <div className="w-10 shrink-0 overflow-hidden rounded-sm">
              <PosterCellWidthContext.Provider value={thumbWidth}>
                <Poster src={item.posterUrl} sourceId={item.ref.sourceId} alt="" label={item.title} aspect="poster" />
              </PosterCellWidthContext.Provider>
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-fg">{sourceName}</div>
              <div className="flex flex-wrap gap-x-3 text-xs text-fg-subtle">
                <span dir="auto" className="truncate text-match-parent">{item.title}</span>
                {item.year && <span className="tabular">{item.year}</span>}
                {rating && <span className="tabular">{rating}</span>}
                {item.containerExtension && <span>{item.containerExtension.toUpperCase()}</span>}
                {isCurrent && <span className="text-fg-muted">{t('thisSource')}</span>}
                {pinned && <span className="text-accent">{t('preferredSource')}</span>}
              </div>
            </div>
            <IconButton
              size="sm"
              label={pinned ? t('unpinSource') : t('pinSource')}
              pressed={pinned}
              icon={pinned ? <PinOff aria-hidden size={16} /> : <Pin aria-hidden size={16} />}
              onClick={() => onPin(pinned ? null : item.ref)}
            />
            {!isCurrent && (
              <Link to={detailHref(item.ref) ?? '#'} className={buttonClass('ghost', 'sm')} onClick={onOpen}>
                {t('openDetails')}
              </Link>
            )}
            <Button size="sm" variant="secondary" icon={<Play aria-hidden size={14} />} onClick={() => onPlay(item)}>
              {t('play')}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
