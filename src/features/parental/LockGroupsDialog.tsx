import { useVirtualizer } from '@tanstack/react-virtual';
import { ShieldAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { rpc, RpcError } from '@/api/transport';
import type { ContentType, ParentalLock, ParentalLockTarget, ParentalStatus, Source } from '@/api/types';
import { Badge, Button, Dialog, EmptyState, ErrorState, SearchInput, Skeleton, Tabs, cn, toast, tabPanelProps } from '@/ui';

import { useContentTypeText } from './labels';
import { PinDialog } from './PinDialog';
import { afterLockChange } from './status';

const ROW = 40;
const TYPES: readonly ContentType[] = ['live', 'radio', 'movie', 'series'];
/** Lock changes sent at once. */
const PARALLEL = 4;

type Picks = Record<ContentType, Map<string, string>>;

const emptyPicks = (): Picks => ({ live: new Map(), radio: new Map(), movie: new Map(), series: new Map() });

/** Case- and accent-insensitive form for the group filter, as in the Live sidebar: "espana" finds "España". */
const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** How many items of each content type a source has. */
export function contentCounts(source: Source): Record<ContentType, number> {
  return {
    live: source.channelCount,
    radio: typeof source.radioCount === 'number' ? source.radioCount : 0,
    movie: source.movieCount,
    series: source.seriesCount,
  };
}

/** Content types this source has, in tab order; types with locks count even when now empty. */
function typesOf(source: Source, locks: readonly ParentalLock[]): ContentType[] {
  const counts = contentCounts(source);
  const out = TYPES.filter((ct) => counts[ct] > 0 || locks.some((l) => l.kind === 'category' && l.contentType === ct));
  return out.length > 0 ? out : ['live'];
}

async function inBatches<T>(list: readonly T[], run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < list.length; i += PARALLEL) await Promise.all(list.slice(i, i + PARALLEL).map(run));
}

export interface LockGroupsDialogProps {
  source: Source;
  status: ParentalStatus;
  /** This source's locks when the dialog opened. */
  locks: readonly ParentalLock[];
  onClose: () => void;
}

/**
 * Picks which groups of one source are locked, per content type. Groups the
 * adult-content rule locks show checked and fixed. Adding locks needs no PIN;
 * unticking a locked group asks for it once on save, unless the session is
 * unlocked.
 */
export function LockGroupsDialog({ source, status, locks, onClose }: LockGroupsDialogProps) {
  const { t } = useTranslation('parental');
  const typeText = useContentTypeText();
  const types = useMemo(() => typesOf(source, locks), [source, locks]);
  const [tab, setTab] = useState<ContentType>(types[0]!);
  const panelPrefix = `lock-groups-${source.id}`;

  const initial = useMemo(() => {
    const p = emptyPicks();
    for (const l of locks) if (l.kind === 'category' && l.sourceId === source.id) p[l.contentType].set(l.targetId, l.name);
    return p;
  }, [locks, source.id]);
  const [picks, setPicks] = useState<Picks>(() => {
    const p = emptyPicks();
    for (const ct of TYPES) p[ct] = new Map(initial[ct]);
    return p;
  });
  const [saving, setSaving] = useState(false);
  const [askPin, setAskPin] = useState(false);

  const changes = useMemo(() => {
    const add: ParentalLockTarget[] = [];
    const remove: ParentalLockTarget[] = [];
    for (const ct of TYPES) {
      for (const [id, name] of picks[ct])
        if (!initial[ct].has(id)) add.push({ sourceId: source.id, contentType: ct, kind: 'category', targetId: id, name });
      for (const [id, name] of initial[ct])
        if (!picks[ct].has(id)) remove.push({ sourceId: source.id, contentType: ct, kind: 'category', targetId: id, name });
    }
    return { add, remove };
  }, [picks, initial, source.id]);
  const changeCount = changes.add.length + changes.remove.length;

  /** Removals first, so a refused PIN changes nothing. Throws the core's error. */
  const apply = async (pin?: string) => {
    const off = (target: ParentalLockTarget) =>
      rpc('parental.setLocked', pin === undefined ? { target, locked: false } : { target, locked: false, pin });
    try {
      const [first, ...rest] = changes.remove;
      if (first) await off(first);
      await inBatches(rest, off);
      await inBatches(changes.add, (target) => rpc('parental.setLocked', { target, locked: true }));
    } finally {
      afterLockChange();
    }
    toast({ variant: 'success', title: t('groupLocksSaved', { count: changeCount }) });
    onClose();
  };

  const save = async () => {
    if (changeCount === 0) {
      onClose();
      return;
    }
    if (changes.remove.length > 0 && !status.unlocked) {
      setAskPin(true);
      return;
    }
    setSaving(true);
    try {
      await apply();
    } catch (err) {
      const e = RpcError.from(err);
      // The unlock ran out while the dialog was open.
      if (e.code === 'auth') setAskPin(true);
      else toast({ variant: 'error', title: t('lockChangeFailed'), description: e.message });
    } finally {
      setSaving(false);
    }
  };

  const setOne = (ct: ContentType, id: string, name: string, on: boolean) =>
    setPicks((prev) => {
      const next = { ...prev, [ct]: new Map(prev[ct]) };
      if (on) next[ct].set(id, name);
      else next[ct].delete(id);
      return next;
    });

  const setMany = (ct: ContentType, rows: readonly GroupRow[], on: boolean) =>
    setPicks((prev) => {
      const next = { ...prev, [ct]: new Map(prev[ct]) };
      for (const r of rows) {
        if (r.auto) continue;
        if (on) next[ct].set(r.id, r.name);
        else next[ct].delete(r.id);
      }
      return next;
    });

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('lockGroupsTitle', { source: source.name })}
        description={t('lockGroupsText')}
        size="md"
        testId="lock-groups-dialog"
        footer={
          <>
            <span className="me-auto text-[calc(13rem/15)] text-fg-subtle" aria-live="polite" data-testid="lock-groups-changes">
              {changeCount > 0 ? t('unsavedChanges', { count: changeCount }) : null}
            </span>
            <Button variant="ghost" onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button onClick={() => void save()} loading={saving} data-testid="lock-groups-save">
              {t('saveLocks')}
            </Button>
          </>
        }
      >
        {types.length > 1 ? (
          <Tabs
            items={types.map((ct) => ({
              id: ct,
              label: typeText(ct),
              badge: picks[ct].size > 0 ? <Badge variant="outline">{picks[ct].size}</Badge> : undefined,
            }))}
            value={tab}
            onChange={(id) => setTab(id as ContentType)}
            label={t('contentTypes')}
            panelIdPrefix={panelPrefix}
            className="mb-3"
          />
        ) : null}
        <div {...(types.length > 1 ? tabPanelProps(panelPrefix, tab) : {})} className="outline-none">
          <GroupList
            key={tab}
            sourceId={source.id}
            contentType={tab}
            autoAdult={status.autoAdult}
            picks={picks[tab]}
            lockedNames={initial[tab]}
            onToggle={(id, name, on) => setOne(tab, id, name, on)}
            onMany={(rows, on) => setMany(tab, rows, on)}
          />
        </div>
      </Dialog>
      {askPin ? (
        <PinDialog
          open
          title={t('removeLocksTitle')}
          description={t('removeLocksText', { count: changes.remove.length })}
          confirmLabel={t('saveLocks')}
          onSubmit={(pin) => apply(pin)}
          onCancel={() => setAskPin(false)}
          testId="lock-groups-pin"
        />
      ) : null}
    </>
  );
}

interface GroupRow {
  id: string;
  name: string;
  count?: number;
  adult: boolean;
  /** Locked by the adult-content rule: shown checked, cannot be changed here. */
  auto: boolean;
}

function GroupList({
  sourceId,
  contentType,
  autoAdult,
  picks,
  lockedNames,
  onToggle,
  onMany,
}: {
  sourceId: string;
  contentType: ContentType;
  autoAdult: boolean;
  picks: ReadonlyMap<string, string>;
  lockedNames: ReadonlyMap<string, string>;
  onToggle: (id: string, name: string, on: boolean) => void;
  onMany: (rows: readonly GroupRow[], on: boolean) => void;
}) {
  const { t, i18n } = useTranslation('parental');
  const fmt = useMemo(() => new Intl.NumberFormat(i18n.language), [i18n.language]);
  const [filter, setFilter] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const cats = useRpcQuery('catalog.categories', { sourceId, contentType, includeHidden: true });
  const adult = useRpcQuery('parental.adultCategories', { sourceId, contentType });

  const { rows, unnamedAdult } = useMemo(() => {
    const adultIds = new Set(adult.data ?? []);
    const out: GroupRow[] = [];
    const seen = new Set<string>();
    for (const c of cats.data ?? []) {
      seen.add(c.id);
      const isAdult = adultIds.has(c.id);
      out.push({ id: c.id, name: c.name, count: c.itemCount, adult: isAdult, auto: isAdult && autoAdult });
    }
    // Hide mode leaves locked groups out of the catalog; their lock still names them.
    for (const [id, name] of lockedNames) {
      if (seen.has(id)) continue;
      seen.add(id);
      const isAdult = adultIds.has(id);
      out.push({ id, name, adult: isAdult, auto: isAdult && autoAdult });
    }
    // Adult groups Hide mode left out, with no lock to name them.
    const unnamed = autoAdult ? [...adultIds].filter((id) => !seen.has(id)).length : 0;
    return { rows: out, unnamedAdult: unnamed };
  }, [cats.data, adult.data, lockedNames, autoAdult]);

  const shown = useMemo(() => {
    const q = fold(filter.trim());
    return q ? rows.filter((r) => fold(r.name).includes(q)) : rows;
  }, [rows, filter]);

  const lockedCount = rows.filter((r) => r.auto || picks.has(r.id)).length;

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW,
    overscan: 10,
    initialRect: { width: 480, height: 360 },
  });

  if (cats.error) return <ErrorState size="inline" error={cats.error} onRetry={() => void cats.refetch()} />;
  if (!cats.data) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={t('loadingGroups')}>
        {Array.from({ length: 7 }, (_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (rows.length === 0) {
    return <EmptyState size="inline" title={t('noGroupsTitle')} description={t('noGroupsText')} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={filter}
          onChange={setFilter}
          placeholder={t('filterGroups')}
          size="sm"
          className="min-w-40 flex-1"
          data-testid="lock-groups-filter"
        />
        <Button size="sm" variant="ghost" onClick={() => onMany(shown, true)}>
          {t('lockAllShown')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onMany(shown, false)}>
          {t('unlockAllShown')}
        </Button>
      </div>
      <p className="text-xs text-fg-subtle tabular" aria-live="polite">
        {t('groupsLockedOf', { locked: fmt.format(lockedCount), total: fmt.format(rows.length) })}
      </p>
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t('noGroupsMatch')}</p>
      ) : (
        <div ref={scrollRef} className="h-[min(360px,45vh)] overflow-y-auto rounded-md border border-border bg-surface">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((v) => {
              const r = shown[v.index]!;
              const checked = r.auto || picks.has(r.id);
              return (
                <label
                  key={r.id}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW, transform: `translateY(${v.start}px)` }}
                  className={cn(
                    'flex items-center gap-3 px-3 text-sm ring-inset',
                    'has-[:focus-visible]:bg-surface-2 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus',
                    r.auto ? 'cursor-default' : 'cursor-pointer hover:bg-surface-2',
                  )}
                  data-testid="lock-group-row"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={r.auto}
                    onChange={(e) => onToggle(r.id, r.name, e.target.checked)}
                    className="size-4 shrink-0 accent-[var(--color-accent)] focus-visible:outline-none"
                  />
                  <span dir="auto" className={cn('min-w-0 flex-1 truncate text-match-parent', checked ? 'text-fg' : 'text-fg-muted')}>
                    {r.name}
                  </span>
                  {r.adult ? (
                    <Badge variant={r.auto ? 'danger' : 'outline'} title={r.auto ? t('adultAutoHint') : t('adultOffHint')}>
                      <ShieldAlert aria-hidden size={12} />
                      {t('adultBadge')}
                    </Badge>
                  ) : null}
                  {r.count !== undefined ? <span className="text-xs text-fg-subtle tabular">{fmt.format(r.count)}</span> : null}
                </label>
              );
            })}
          </div>
        </div>
      )}
      {unnamedAdult > 0 ? (
        <p className="flex items-center gap-2 text-xs text-fg-muted" data-testid="lock-groups-adult-hidden">
          <ShieldAlert aria-hidden size={14} className="shrink-0 text-danger" />
          {t('adultHiddenCount', { count: unnamedAdult })}
        </p>
      ) : null}
    </div>
  );
}
