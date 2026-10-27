import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, cn, Tooltip } from '../deps';
import { LAYOUTS } from '../layout';
import type { MultiviewLayout } from '../types';
import { LayoutGlyph } from './LayoutGlyph';
import { LAYOUT_LABEL_KEYS } from './WallToolbar';

export interface EmptyIntroProps {
  layout: MultiviewLayout;
  onLayout(l: MultiviewLayout): void;
  onPick(): void;
}

/**
 * What an empty wall says above its free frames: what multi-view does, the layout to fill and
 * the way in (pick channels). Channels watched lately wait in the first free frame (FreeSlot).
 */
export function EmptyIntro({ layout, onLayout, onPick }: EmptyIntroProps) {
  const { t } = useTranslation('multiview');
  return (
    <section
      aria-labelledby="multiview-empty-title"
      data-testid="multiview-empty"
      className="@container/intro flex flex-col border-b border-divider bg-surface px-4 py-5 sm:px-6"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between lg:gap-8">
        <div className="max-w-[60ch]">
          <h2 id="multiview-empty-title" className="text-title text-balance text-fg">
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
                <Tooltip key={l} content={label} describe={false}>
                  <button
                    type="button"
                    aria-pressed={checked}
                    data-testid={`multiview-empty-layout-${l}`}
                    onClick={() => onLayout(l)}
                    className={cn(
                      'inline-flex h-9 shrink-0 items-center gap-2 rounded-md px-2.5 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-focus',
                      'motion-safe:transition-colors motion-safe:duration-150',
                      checked ? 'bg-surface text-fg shadow-1' : 'text-fg-muted hover:bg-hover hover:text-fg active:bg-active',
                    )}
                  >
                    <LayoutGlyph layout={l} className="h-4 w-7 shrink-0" />
                    <span data-testid="multiview-empty-layout-label" className="sr-only @2xl/intro:not-sr-only">
                      {label}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </div>
          <Button variant="primary" icon={<Plus aria-hidden size={16} />} onClick={onPick} data-testid="multiview-pick">
            {t('pickChannels')}
          </Button>
        </div>
      </div>
    </section>
  );
}
