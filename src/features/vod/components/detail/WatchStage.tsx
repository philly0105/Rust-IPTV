import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
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
  const ref = useRef<HTMLElement>(null);
  // Play, Resume or Start over unmounts the button that had focus, dropping it to the page: the
  // first Tab then went through the skip link and the whole rail. The player takes it instead, as
  // Fill window does, once it lands in the stage (a frame or two later).
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const take = (): void => {
      const target = ref.current?.querySelector<HTMLElement>('[data-player-focus]');
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement) return;
      if (target) target.focus({ preventScroll: true });
      else if (++tries < 10) frame = requestAnimationFrame(take);
    };
    frame = requestAnimationFrame(take);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <section ref={ref} aria-label={t('nowPlaying')} className="flex w-full max-w-[120rem] flex-col gap-3 px-(--page-gutter) pt-4">
      <div className="flex items-center gap-3">
        <IconButton label={t('closePlayer')} shortcut="escape" icon={<X aria-hidden size={18} />} onClick={onClose} variant="secondary" size="sm" />
        {/* dir="auto": a Latin title in an RTL UI truncates at its own end, not its start. */}
        <div className="min-w-0">
          <h1 dir="auto" className="truncate text-match-parent text-title-sm text-fg">
            {title}
          </h1>
          {subtitle && (
            <div dir="auto" className="truncate text-match-parent text-sm text-fg-muted">
              {subtitle}
            </div>
          )}
        </div>
      </div>
      <div className="flex flex-col gap-4 xl:flex-row">
        {/* VL-watchstage-letterbox: the height cap caps the width too (16:9 of 72vh), so a wide window
            gets no black bars inside the frame; the rest of the row stays the page's. The bar above
            heads it with the title, so the player leaves out its own (PL-DUPLICATE-CHROME). */}
        <PlayerStage
          showTitle={false}
          endedAction={{ label: t('backToDetails'), onClick: onClose }}
          className="aspect-video max-h-[72vh] w-full max-w-[calc(72vh*16/9)] min-w-0 flex-1 overflow-hidden rounded-lg bg-black shadow-2"
        />
        {/* PV-02: at xl the rail's column takes the stage's height (the rail sits absolute inside it and
            scrolls), so a long Up next list no longer stretches the stage into letterbox bands.
            empty:hidden drops the column when the rail renders nothing. */}
        {aside && <div className="min-w-0 empty:hidden xl:relative xl:w-[340px] xl:shrink-0">{aside}</div>}
      </div>
    </section>
  );
}
