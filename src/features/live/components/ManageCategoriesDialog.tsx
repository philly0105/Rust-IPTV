import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { ContentType } from '@/api/types';

import { Button, Dialog, ErrorState, Skeleton, useToast } from '../_shim';

const ROW = 36;

export function ManageCategoriesDialog({
  open,
  onClose,
  sourceId,
  contentType,
}: {
  open: boolean;
  onClose(): void;
  sourceId: string;
  contentType: ContentType;
}) {
  const { t } = useTranslation('live');
  const { toast } = useToast();
  const all = useRpcQuery('catalog.categories', { sourceId, contentType, includeHidden: true }, { enabled: open });
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && all.data) setVisibleIds(new Set(all.data.filter((c) => !c.hidden).map((c) => c.id)));
    if (!open) setFilter('');
  }, [open, all.data]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = all.data ?? [];
    return q ? list.filter((c) => c.name.toLowerCase().includes(q)) : list;
  }, [all.data, filter]);

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
    initialRect: { width: 480, height: 360 },
  });

  const setMany = (on: boolean) =>
    setVisibleIds((prev) => {
      const next = new Set(prev);
      for (const c of shown) (on ? next.add(c.id) : next.delete(c.id));
      return next;
    });

  const save = async () => {
    if (!all.data) return;
    setSaving(true);
    try {
      const hiddenIds = all.data.filter((c) => !visibleIds.has(c.id)).map((c) => c.id);
      await rpc('catalog.setCategoriesHidden', { sourceId, contentType, hiddenIds });
      await invalidate('catalog.');
      toast({ title: t('groupsSaved'), variant: 'success' });
      onClose();
    } catch (err) {
      toast({ title: t('groupsSaveFailed'), description: err instanceof Error ? err.message : undefined, variant: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const total = all.data?.length ?? 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('manageCategories')}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!all.data}>
            {t('saveGroups')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-fg-muted">{t('manageCategoriesHint')}</p>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('filterGroups')}
          aria-label={t('filterGroups')}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-surface-2 px-2 text-sm text-fg outline-none placeholder:text-fg-subtle focus:ring-2 focus:ring-accent"
        />
        <Button size="sm" variant="ghost" onClick={() => setMany(true)}>
          {t('selectAll')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setMany(false)}>
          {t('selectNone')}
        </Button>
      </div>
      <p className="mb-2 text-xs text-fg-subtle" aria-live="polite">
        {t('groupsVisibleOf', { visible: visibleIds.size, total })}
      </p>
      {all.error ? (
        <ErrorState error={all.error} onRetry={() => void all.refetch()} />
      ) : !all.data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-6" />
          ))}
        </div>
      ) : total === 0 ? (
        <p className="py-6 text-center text-sm text-fg-muted">{t('noGroups')}</p>
      ) : (
        <div ref={scrollRef} className="h-[min(360px,50vh)] overflow-y-auto rounded-md border border-border">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const c = shown[v.index]!;
              const checked = visibleIds.has(c.id);
              return (
                <label
                  key={c.id}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${v.start}px)` }}
                  className="flex cursor-pointer items-center gap-3 px-3 text-sm hover:bg-surface-2"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() =>
                      setVisibleIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      })
                    }
                    className="size-4 accent-[var(--color-accent)]"
                  />
                  <span className={`flex-1 truncate ${checked ? 'text-fg' : 'text-fg-subtle line-through'}`}>{c.name}</span>
                  <span className="text-xs tabular-nums text-fg-subtle">{c.itemCount.toLocaleString()}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Dialog>
  );
}
