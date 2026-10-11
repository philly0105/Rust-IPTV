import { useTranslation } from 'react-i18next';

import { Dialog } from '@/ui';

/** YouTube trailer in a privacy-enhanced embed; the iframe exists only while open. */
export function TrailerDialog({ open, onClose, youtubeKey, title }: { open: boolean; onClose: () => void; youtubeKey: string; title: string }) {
  const { t } = useTranslation('vod');
  return (
    <Dialog open={open} onClose={onClose} size="xl" title={t('trailerFor', { title })} bodyClassName="px-0 pb-0">
      <div className="aspect-video w-full overflow-hidden rounded-b-lg bg-black">
        {open && (
          <iframe
            className="h-full w-full"
            src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(youtubeKey)}?autoplay=1&rel=0`}
            title={t('trailerFor', { title })}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            referrerPolicy="strict-origin-when-cross-origin"
            allowFullScreen
          />
        )}
      </div>
    </Dialog>
  );
}
