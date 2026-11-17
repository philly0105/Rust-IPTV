import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Tooltip } from '@/ui/Tooltip';

import { cn } from '../cn';
import { usePlayerStore } from '../store';
import { readStats, statsRows, useStreamInfoStore, type StreamStats } from '../streamInfo';

/** How often the open panel reads the stats. */
export const STATS_POLL_MS = 1000;

/**
 * The stream info overlay (I, or "Stream info" in the menus). Polls the active surface while
 * open and is not mounted while closed, so a closed panel costs nothing. Over embedded mpv it
 * is cut out of the native video (`data-mpv-overlay` plus `data-mpv-reserved`).
 */
export function StreamInfoPanel({ className, big = false, columns = false }: { className?: string; big?: boolean; columns?: boolean }) {
  const open = useStreamInfoStore((s) => s.open);
  const hasSource = usePlayerStore((s) => !!s.source);
  if (!open || !hasSource) return null;
  return <OpenPanel className={className} big={big} columns={columns} />;
}

/**
 * `big`: fullscreen and Fill window, read from further away, with the room to show whole values.
 * `columns`: a wide, short player (the Live page's stage), where one column of rows would scroll:
 * the rows run on into a second column instead.
 */
function OpenPanel({ className, big, columns }: { className?: string | undefined; big: boolean; columns: boolean }) {
  const { t, i18n } = useTranslation('player');
  const url = usePlayerStore((s) => s.source?.url ?? '');
  const [stats, setStats] = useState<StreamStats | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // One read at a time: a slow mpv answer never stacks requests up.
    const tick = async (): Promise<void> => {
      const next = await readStats();
      if (stopped) return;
      setStats(next);
      timer = setTimeout(() => void tick(), STATS_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <section
      aria-label={t('streamInfo')}
      data-mpv-overlay=""
      data-mpv-reserved=""
      data-testid="stream-info"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        'player-glass player-glass-edge glass-blur pointer-events-auto absolute z-30 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg border text-on-glass motion-safe:animate-pop-in',
        big ? 'w-96' : columns ? 'w-[30rem]' : 'w-64',
        className,
      )}
    >
      <header className="flex items-center gap-1 border-b border-white/10 ps-3 pe-1">
        <h2 className="min-w-0 flex-1 truncate py-1.5 text-body-sm font-medium">{t('streamInfo')}</h2>
        <Tooltip content={t('streamInfoClose')} shortcut="i" tone="glass" describe={false}>
          <button
            type="button"
            aria-label={t('streamInfoClose')}
            onClick={() => useStreamInfoStore.setState({ open: false })}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-on-glass-muted hover:bg-white/10 hover:text-on-glass pointer-coarse:size-[calc(44rem/15)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </Tooltip>
      </header>
      {stats ? (
        <dl
          className={cn(
            'px-3 py-2.5',
            columns ? 'columns-2 gap-x-6 *:mb-1 *:flex *:break-inside-avoid *:justify-between *:gap-3' : 'grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1',
            big ? 'text-body-sm' : 'text-caption',
          )}
        >
          {statsRows(stats, url, t, i18n.language).map(([label, value]) => (
            <div key={label} className={columns ? undefined : 'contents'}>
              <dt className="player-on-glass-muted">{label}</dt>
              {/* A long value (the decoder's state, a server address) wraps rather than losing its end. */}
              <dd className="text-end font-mono tabular-nums [overflow-wrap:anywhere]" dir="auto">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p role="status" className="player-on-glass-muted px-3 py-3 text-caption">
          {t('streamInfoWaiting')}
        </p>
      )}
    </section>
  );
}
