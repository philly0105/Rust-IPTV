import { Pin, PinOff, Play } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { ItemRef, Source, VodItem } from '@/api/types';

import { formatRating } from '../../lib/format';
import { isPinned, type SourcePin } from '../../lib/pins';
import { detailHref } from '../../lib/search';
import { Button, Dialog, IconButton, Poster, buttonClass, cn } from '@/ui';

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
  const { t, i18n } = useTranslation('vod');
  const rows: { item: VodItem; sourceName: string; isCurrent: boolean }[] = [
    { item: current, sourceName: currentSourceName, isCurrent: true },
    ...others.map((item) => ({ item, sourceName: sources.get(item.ref.sourceId)?.name ?? item.ref.sourceId, isCurrent: false })),
  ];
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={t('otherSourcesTitle')} description={t('otherSourcesHint', { count: rows.length })}>
      <ul className="flex flex-col divide-y divide-border">
        {rows.map(({ item, sourceName, isCurrent }) => {
          const pinned = isPinned(pin, item.ref);
          const rating = formatRating(item.rating, i18n.language);
          return (
            <li key={`${item.ref.sourceId}|${item.ref.itemId}`} className={cn('flex items-center gap-3 py-3', pinned && 'tuning-tick pl-3')}>
              <div className="w-10 shrink-0 overflow-hidden rounded-sm">
                <Poster src={item.posterUrl} alt="" label={item.title} aspect="poster" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-fg">{sourceName}</div>
                <div className="flex flex-wrap gap-x-3 text-xs text-fg-subtle">
                  <span className="truncate">{item.title}</span>
                  {item.year && <span className="tabular">{item.year}</span>}
                  {rating && <span className="tabular">{rating}</span>}
                  {item.containerExtension && <span>{item.containerExtension.toUpperCase()}</span>}
                  {isCurrent && <span className="text-accent">{t('thisSource')}</span>}
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
                <Link to={detailHref(item.ref) ?? '#'} className={buttonClass('ghost', 'sm')} onClick={onClose}>
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
    </Dialog>
  );
}
