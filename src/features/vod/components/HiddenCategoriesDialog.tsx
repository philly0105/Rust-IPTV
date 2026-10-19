import { Check, EyeOff } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcMutation, useRpcQuery } from '@/api/query';
import type { ContentType } from '@/api/types';

import { Button, Dialog, ErrorState, SearchInput, SkeletonGrid, cn, useListVirtualizer, useToast, errorDescription } from '@/ui';

export interface HiddenCategoriesDialogProps {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  contentType: ContentType;
}

const ROW_H = 44;

/** Choose which categories appear in the movies/series index (replaces the hidden set on save). */
export function HiddenCategoriesDialog({ open, onClose, sourceId, contentType }: HiddenCategoriesDialogProps) {
  const { t } = useTranslation('vod');
  const { toast } = useToast();
  const cats = useRpcQuery('catalog.categories', { sourceId, contentType, includeHidden: true }, { enabled: open });
  const save = useRpcMutation('catalog.setCategoriesHidden');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && cats.data) setHidden(new Set(cats.data.filter((c) => c.hidden).map((c) => c.id)));
    if (!open) setFilter('');
  }, [open, cats.data]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (cats.data ?? []).filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [cats.data, filter]);

  const v = useListVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setAll = (hide: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      for (const c of visible) {
        if (hide) next.add(c.id);
        else next.delete(c.id);
      }
      return next;
    });

  const onSave = () => {
    save.mutate(
      { sourceId, contentType, hiddenIds: [...hidden] },
      {
        onSuccess: () => {
          void invalidate('catalog.');
          toast({ title: t('categoriesSaved'), variant: 'success' });
          onClose();
        },
        onError: (err) => toast({ title: t('categoriesSaveFailed'), description: errorDescription(err), variant: 'error' }),
      },
    );
  };

  const total = cats.data?.length ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      title={t('manageCategories')}
      description={t('manageCategoriesHint', { hidden: hidden.size, total })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={!cats.data} onClick={onSave}>
            {t('saveCategories')}
          </Button>
        </>
      }
    >
      {cats.isError ? (
        <ErrorState error={cats.error} onRetry={() => void cats.refetch()} />
      ) : !cats.data ? (
        <SkeletonGrid count={6} aspect={8} minColumnWidth={400} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <SearchInput value={filter} onChange={setFilter} placeholder={t('filterCategories')} className="min-w-48 flex-1" size="sm" />
            <Button size="sm" variant="ghost" onClick={() => setAll(false)}>
              {t('showAll')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
              {t('hideAll')}
            </Button>
          </div>
          <div ref={scrollRef} className="h-[min(50vh,440px)] overflow-y-auto rounded-md border border-border" role="group" aria-label={t('manageCategories')}>
            <div style={{ height: v.getTotalSize(), position: 'relative' }}>
              {v.getVirtualItems().map((row) => {
                const c = visible[row.index];
                if (!c) return null;
                const isHidden = hidden.has(c.id);
                return (
                  <label
                    key={c.id}
                    className={cn(
                      'absolute start-0 flex w-full cursor-pointer items-center gap-3 border-b border-divider px-3 text-sm',
                      'hover:bg-surface-2 has-focus-visible:bg-surface-2',
                      isHidden ? 'text-fg-subtle' : 'text-fg',
                    )}
                    style={{ top: row.start, height: ROW_H }}
                  >
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={!isHidden}
                      onChange={() => toggle(c.id)}
                    />
                    <span
                      aria-hidden
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border',
                        'peer-focus-visible:ring-2 peer-focus-visible:ring-focus',
                        isHidden ? 'border-border' : 'border-accent bg-accent text-accent-fg',
                      )}
                    >
                      {!isHidden && <Check size={14} strokeWidth={3} />}
                    </span>
                    <span dir="auto" className="min-w-0 flex-1 truncate text-match-parent">{c.name}</span>
                    {isHidden && <EyeOff aria-hidden size={14} />}
                    {c.itemCount > 0 && <span className="tabular text-xs text-fg-subtle">{c.itemCount}</span>}
                  </label>
                );
              })}
            </div>
            {visible.length === 0 && <p className="p-6 text-center text-sm text-fg-muted">{t('noCategoryMatch')}</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
