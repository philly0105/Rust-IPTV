import { LoaderCircle, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { itemKey, type ItemRef } from '@/api/types';

import { addToWall } from '../addChannel';
import { Button, cn, toast } from '../deps';
import { LAYOUTS } from '../layout';
import type { MultiviewChannelInput, MultiviewLayout } from '../types';
import { ChannelMark } from './ChannelMark';
import { LayoutGlyph } from './LayoutGlyph';
import { LAYOUT_LABEL_KEYS } from './WallToolbar';

/** Most quick picks shown. */
export const QUICK_PICKS = 6;

interface QuickPick {
  ref: ItemRef;
  title: string;
  logo?: string;
}

/** Live channels from Recent, then Favorites, without repeats. */
function useQuickPicks(): QuickPick[] {
  const recent = useRpcQuery('recent.list', { limit: 24 }, { staleTime: 30_000 });
  const favorites = useRpcQuery('favorites.list', {}, { staleTime: 30_000 });
  return useMemo(() => {
    const out: QuickPick[] = [];
    const seen = new Set<string>();
    for (const e of [...(recent.data ?? []), ...(favorites.data ?? [])]) {
      if (out.length >= QUICK_PICKS) break;
      if (e.ref.contentType !== 'live' || e.snapshot.contentType !== 'live') continue;
      const k = itemKey(e.ref);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(e.snapshot.posterUrl ? { ref: e.ref, title: e.snapshot.title, logo: e.snapshot.posterUrl } : { ref: e.ref, title: e.snapshot.title });
    }
    return out;
  }, [recent.data, favorites.data]);
}

export interface EmptyIntroProps {
  layout: MultiviewLayout;
  onLayout(l: MultiviewLayout): void;
  onPick(): void;
}

/**
 * What an empty wall says above its free frames: what multi-view does, the layout to fill,
 * the way in (pick channels) and, when there are any, live channels watched lately to put
 * up with one click.
 */
export function EmptyIntro({ layout, onLayout, onPick }: EmptyIntroProps) {
  const { t } = useTranslation('multiview');
  const picks = useQuickPicks();
  const [pending, setPending] = useState<string | null>(null);

  const quickAdd = async (p: QuickPick) => {
    if (pending) return;
    setPending(itemKey(p.ref));
    try {
      const input: MultiviewChannelInput = p.logo ? { ref: p.ref, title: p.title, logo: p.logo } : { ref: p.ref, title: p.title };
      const r = await addToWall(input);
      if (r === 'gateFailed') toast({ variant: 'error', title: t('toastGateFailed'), description: t('toastGateFailedHint') });
    } finally {
      setPending(null);
    }
  };

  return (
    <section
      aria-labelledby="multiview-empty-title"
      data-testid="multiview-empty"
      className="@container/intro flex flex-col gap-4 border-b border-divider bg-surface px-4 py-5 sm:px-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="max-w-[60ch]">
          <h2 id="multiview-empty-title" className="font-display text-xl font-semibold text-balance text-fg">
            {t('emptyTitle')}
          </h2>
          <p className="mt-1 text-sm text-pretty text-fg-muted">{t('emptyBody')}</p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {/* Narrow, the layouts are their glyphs (named for screen readers and on hover), as in
              the toolbar; with room the names show on one line each, and the group wraps
              rather than overflow when a translation is long. */}
          <div role="group" aria-label={t('layoutLabel')} className="flex min-w-0 max-w-full flex-wrap items-center gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {LAYOUTS.map((l) => {
              const checked = l === layout;
              const label = t(LAYOUT_LABEL_KEYS[l]);
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={checked}
                  title={label}
                  data-testid={`multiview-empty-layout-${l}`}
                  onClick={() => onLayout(l)}
                  className={cn(
                    'inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus',
                    'motion-safe:transition-colors motion-safe:duration-150',
                    checked ? 'bg-surface text-fg shadow-1' : 'text-fg-muted hover:bg-surface-3 hover:text-fg active:bg-pressed',
                  )}
                >
                  <LayoutGlyph layout={l} className="h-4 w-7 shrink-0" />
                  <span data-testid="multiview-empty-layout-label" className="sr-only @2xl/intro:not-sr-only">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
          <Button variant="primary" icon={<Plus aria-hidden size={16} />} onClick={onPick} data-testid="multiview-pick">
            {t('pickChannels')}
          </Button>
        </div>
      </div>

      {picks.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 id="multiview-quick-title" className="text-sm font-medium text-fg-muted">
            {t('quickPicksTitle')}
          </h3>
          <ul aria-labelledby="multiview-quick-title" className="flex flex-wrap gap-2" data-testid="multiview-quick-picks">
            {picks.map((p) => {
              const k = itemKey(p.ref);
              const busy = pending === k;
              return (
                <li key={k} className="min-w-0 max-w-full">
                  <button
                    type="button"
                    aria-label={t('pickerAddLabel', { name: p.title })}
                    aria-busy={busy || undefined}
                    disabled={pending !== null && !busy}
                    onClick={() => void quickAdd(p)}
                    className={cn(
                      'inline-flex h-10 max-w-full min-w-0 items-center gap-2 rounded-md border border-border bg-surface-2 ps-1 pe-3 text-sm font-medium text-fg outline-none',
                      'hover:bg-surface-3 active:bg-pressed focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-50',
                      'motion-safe:transition-colors motion-safe:duration-150',
                    )}
                  >
                    <ChannelMark src={p.logo} name={p.title} className="size-8" />
                    <span dir="auto" className="truncate">
                      {p.title}
                    </span>
                    {busy ? (
                      <LoaderCircle aria-hidden className="size-4 shrink-0 text-fg-muted motion-safe:animate-spin" />
                    ) : (
                      <Plus aria-hidden className="size-4 shrink-0 text-fg-muted" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
