/**
 * Settings row for the disk image cache (Run 3 contracts C1 and C3,
 * docs/architecture/image-cache.md): how much the cache holds against its
 * cap, a cap select and Clear. I-integration mounts it in General.
 *
 * Sizes use the cap's own units: the core counts `imageCacheMaxMb` in MiB
 * (`imagecache::max_bytes`), and the select calls 1000 of them "1 GB", so the
 * usage line and the select always agree ("120 MB of 1 GB"). Units come from
 * `Intl.NumberFormat`'s unit style, so every locale gets its own symbols.
 */

import { useQueryClient } from '@tanstack/react-query';
import { ImageOff, Trash2 } from 'lucide-react';
import { useId, useState, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { rpcKey, useRpcQuery } from '@/api/query';
import { RpcError, rpc } from '@/api/transport';
import { IMAGE_CACHE_MAX_MB_MAX, IMAGE_CACHE_MAX_MB_MIN, type ImageCacheStats } from '@/api/types';
import { Button, Dialog, Select, Skeleton, cn, useToast } from '@/ui';

import { SettingsRow } from '../components';
import { useSettingsQuery, useUpdateSettings } from '../lib/useUpdateSettings';

/** The cap select's choices, in `settings.imageCacheMaxMb` units. */
export const IMAGE_CACHE_CAPS_MB = [250, 500, 1000, 2000, 5000] as const;

const MIB = 1024 * 1024;

function unitFormat(locale: string, unit: 'kilobyte' | 'megabyte' | 'gigabyte', digits: number): Intl.NumberFormat {
  try {
    return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits });
  } catch {
    return new Intl.NumberFormat('en', { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: digits });
  }
}

/** A cap in settings units: `250 MB`, `1 GB`, `2.5 GB` (1 GB = 1000 MB of the setting). */
export function formatCacheMb(mb: number, locale: string): string {
  if (mb >= 1000) return unitFormat(locale, 'gigabyte', 1).format(mb / 1000);
  return unitFormat(locale, 'megabyte', 0).format(mb);
}

/** A byte count in the same units as the cap: `0 MB`, `640 KB`, `12.5 MB`, `120 MB`, `1.2 GB`. */
export function formatCacheBytes(bytes: number, locale: string): string {
  const safe = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (safe === 0) return unitFormat(locale, 'megabyte', 0).format(0);
  if (safe < MIB) return unitFormat(locale, 'kilobyte', 0).format(Math.max(1, Math.round(safe / 1024)));
  const mb = safe / MIB;
  if (mb < 1000) return unitFormat(locale, 'megabyte', mb < 10 ? 1 : 0).format(mb);
  return unitFormat(locale, 'gigabyte', 1).format(mb / 1000);
}

/** The select's options: the fixed choices, plus the current value when it was set elsewhere (CLI, backup). */
export function capOptions(current: number | undefined, locale: string): { value: string; label: string }[] {
  const values = new Set<number>(IMAGE_CACHE_CAPS_MB);
  if (current !== undefined && Number.isInteger(current) && current >= IMAGE_CACHE_MAX_MB_MIN && current <= IMAGE_CACHE_MAX_MB_MAX) values.add(current);
  return [...values].sort((a, b) => a - b).map((mb) => ({ value: String(mb), label: formatCacheMb(mb, locale) }));
}

/** Image cache size against the cap, the cap select and Clear (confirm, then the toast "Image cache cleared"). */
export function ImageCacheRow(): JSX.Element {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  const { toast } = useToast();
  const qc = useQueryClient();
  const settings = useSettingsQuery();
  const update = useUpdateSettings();
  // Always fresh on open: browsing elsewhere fills the cache without any event.
  const stats = useRpcQuery('images.stats', undefined, { staleTime: 0 });
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const capId = useId();

  const capMb = settings.data?.imageCacheMaxMb;
  const data = stats.data;
  const unsupported = stats.isError && RpcError.from(stats.error).code === 'unsupported';
  const empty = !!data && data.bytes === 0 && data.files === 0;

  const setCap = async (value: string) => {
    const mb = Number(value);
    if (!Number.isInteger(mb) || mb === capMb) return;
    // A lower cap evicts on the next stats call; refetch so the meter shows what is left.
    if (await update({ imageCacheMaxMb: mb })) void stats.refetch();
  };

  const clear = async () => {
    setClearing(true);
    try {
      const next = await rpc('images.clear');
      qc.setQueryData<ImageCacheStats>(rpcKey('images.stats'), next);
      setConfirming(false);
      toast({ variant: 'success', title: t('imageCacheCleared') });
    } catch (e) {
      setConfirming(false);
      toast({
        variant: 'error',
        title: t('imageCacheClearFailed'),
        description: RpcError.from(e).message,
        action: { label: t('retry'), onClick: () => void clear() },
      });
    } finally {
      setClearing(false);
    }
  };

  return (
    <div data-testid="image-cache-row">
      <SettingsRow label={t('imageCache')} description={t('imageCacheHint')} stack>
        {({ id, describedBy }) =>
          stats.isPending ? (
            <div className="flex w-full flex-col gap-3" aria-busy="true" data-testid="image-cache-loading">
              <Skeleton className="h-2 w-full rounded-full" />
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-4 w-36" />
                <Skeleton className="h-4 w-20" />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Skeleton className="h-10 w-40 rounded-md" />
                <Skeleton className="h-10 w-32 rounded-md" />
              </div>
            </div>
          ) : unsupported ? (
            <p id={id} className="flex items-start gap-2 text-sm text-fg-muted" data-testid="image-cache-unavailable">
              <ImageOff aria-hidden className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
              {t('imageCacheUnavailable')}
            </p>
          ) : stats.isError ? (
            <div role="alert" className="flex w-full flex-wrap items-center gap-3 text-sm" data-testid="image-cache-error">
              <span className="min-w-0 flex-1 text-danger">{t('imageCacheLoadFailed', { message: stats.error.message })}</span>
              <Button size="sm" variant="secondary" onClick={() => void stats.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : (
            <UsageAndControls
              id={id}
              describedBy={describedBy}
              stats={data!}
              capMb={capMb}
              capId={capId}
              locale={locale}
              empty={empty}
              refreshing={stats.isFetching}
              onCap={(v) => void setCap(v)}
              onClear={() => setConfirming(true)}
            />
          )
        }
      </SettingsRow>
      <Dialog
        open={confirming}
        onClose={() => !clearing && setConfirming(false)}
        title={t('imageCacheClearTitle')}
        description={t('imageCacheClearBody', { size: formatCacheBytes(data?.bytes ?? 0, locale) })}
        size="sm"
        testId="image-cache-clear-dialog"
        footer={
          <>
            <Button variant="ghost" disabled={clearing} onClick={() => setConfirming(false)}>
              {t('cancel')}
            </Button>
            <Button variant="primary" loading={clearing} onClick={() => void clear()} data-testid="image-cache-clear-confirm">
              {t('imageCacheClear')}
            </Button>
          </>
        }
      />
    </div>
  );
}

function UsageAndControls({
  id,
  describedBy,
  stats,
  capMb,
  capId,
  locale,
  empty,
  refreshing,
  onCap,
  onClear,
}: {
  id: string;
  describedBy: string | undefined;
  stats: ImageCacheStats;
  capMb: number | undefined;
  capId: string;
  locale: string;
  empty: boolean;
  refreshing: boolean;
  onCap: (value: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('settings');
  // The cap as set; the core's figure until settings arrive.
  const limit = capMb !== undefined ? formatCacheMb(capMb, locale) : formatCacheBytes(stats.maxBytes, locale);
  const used = formatCacheBytes(stats.bytes, locale);
  const usage = t('imageCacheUsage', { used, limit });
  const pct = stats.maxBytes > 0 ? Math.min(100, (stats.bytes / stats.maxBytes) * 100) : 0;
  return (
    <div className="flex w-full flex-col gap-3">
      <div
        id={id}
        role="meter"
        aria-label={t('imageCache')}
        aria-describedby={describedBy}
        aria-valuemin={0}
        aria-valuemax={stats.maxBytes}
        aria-valuenow={Math.min(stats.bytes, stats.maxBytes)}
        aria-valuetext={usage}
        data-testid="image-cache-meter"
        className="relative h-2 w-full overflow-hidden rounded-full bg-surface-3"
      >
        <div
          className="h-full rounded-full bg-accent motion-safe:transition-[width] motion-safe:duration-300"
          // A sliver for a cache that holds anything at all, so "not empty" shows.
          style={{ width: `${empty ? 0 : Math.max(pct, 1.5)}%` }}
        />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-sm">
        <span className={cn('tabular text-fg', refreshing && 'text-fg-muted')} data-testid="image-cache-size" data-bytes={stats.bytes}>
          {usage}
        </span>
        <span className="tabular text-fg-muted" data-testid="image-cache-files">
          {empty ? t('imageCacheEmpty') : t('imageCachePictures', { count: stats.files })}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label htmlFor={capId} className="text-sm text-fg-muted">
            {t('imageCacheLimit')}
          </label>
          <Select
            id={capId}
            value={capMb !== undefined ? String(capMb) : ''}
            disabled={capMb === undefined}
            options={capOptions(capMb, locale)}
            onValueChange={onCap}
            data-testid="image-cache-cap"
          />
        </div>
        <Button variant="secondary" icon={<Trash2 aria-hidden className="size-4" />} disabled={empty} onClick={onClear} data-testid="image-cache-clear">
          {t('imageCacheClear')}
        </Button>
      </div>
    </div>
  );
}
