import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PlayerStage } from '@/features/player';

import { IconButton } from '@/ui';

/**
 * Watch-state top of a detail page: the docked player stage at full content
 * width with a slim title bar. The close button (and Escape) stops playback
 * and returns the page to browse state.
 */
export function WatchStage({ title, subtitle, onClose, aside }: { title: string; subtitle?: string; onClose: () => void; aside?: ReactNode }) {
  const { t } = useTranslation('vod');
  return (
    <section aria-label={t('nowPlaying')} className="mx-auto flex w-full max-w-[1800px] flex-col gap-3 px-4 pt-4 md:px-8">
      <div className="flex items-center gap-3">
        <IconButton label={t('closePlayer')} title={`${t('closePlayer')} (Esc)`} icon={<X aria-hidden size={18} />} onClick={onClose} variant="secondary" size="sm" />
        <div className="min-w-0">
          <h1 className="truncate font-display text-lg font-semibold text-fg">{title}</h1>
          {subtitle && <div className="truncate text-sm text-fg-muted">{subtitle}</div>}
        </div>
      </div>
      <div className="flex flex-col gap-4 xl:flex-row">
        <PlayerStage className="aspect-video max-h-[72vh] w-full min-w-0 flex-1 overflow-hidden rounded-lg bg-black shadow-2" />
        {aside}
      </div>
    </section>
  );
}
