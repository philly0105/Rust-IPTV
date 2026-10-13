import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

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
export function StreamInfoPanel({ className }: { className?: string }) {
  const open = useStreamInfoStore((s) => s.open);
  const hasSource = usePlayerStore((s) => !!s.source);
  if (!open || !hasSource) return null;
  return <OpenPanel className={className} />;
}

function OpenPanel({ className }: { className?: string }) {
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
        'pointer-events-auto absolute z-30 w-64 max-w-[calc(100%-1rem)] overflow-y-auto rounded-lg border border-white/10 bg-[rgb(10_14_22/0.9)] text-white shadow-2 backdrop-blur-md motion-safe:animate-pop-in',
        className,
      )}
    >
      <header className="flex items-center gap-1 border-b border-white/10 ps-3 pe-1">
        <h2 className="min-w-0 flex-1 truncate py-1.5 text-sm font-medium">{t('streamInfo')}</h2>
        <button
          type="button"
          aria-label={t('streamInfoClose')}
          title={`${t('streamInfoClose')} (I)`}
          onClick={() => useStreamInfoStore.setState({ open: false })}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-sm text-white/80 hover:bg-white/10 hover:text-white"
        >
          <X className="size-4" aria-hidden />
        </button>
      </header>
      {stats ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 px-3 py-2 text-xs">
          {statsRows(stats, url, t, i18n.language).map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-white/60">{label}</dt>
              <dd className="truncate text-end font-mono tabular-nums" title={value} dir="auto">
                {value}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p role="status" className="px-3 py-3 text-xs text-white/70">
          {t('streamInfoWaiting')}
        </p>
      )}
    </section>
  );
}
