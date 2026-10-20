/** "Saving to <folder>" strip with change (desktop dialog) and open-folder actions. */

import { FolderCog, FolderOpen, HardDrive, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { isDesktop, rpc } from '@/api/transport';

import { Button, Skeleton, useToast, errorDescription } from '../deps';

/** Opens the native folder picker. Returns undefined when the user cancels. */
export async function pickFolder(defaultPath?: string): Promise<string | undefined> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, ...(defaultPath ? { defaultPath } : {}) });
  if (typeof picked === 'string' && picked.length > 0) return picked;
  return undefined;
}

/**
 * Splits a folder path before its last segment ("D:\Media\" + "Videos"), so a
 * long path can lose its middle and keep the drive and the folder's own name.
 */
export function splitPath(path: string): { head: string; tail: string } {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (at <= 0) return { head: '', tail: path };
  return { head: trimmed.slice(0, at + 1), tail: trimmed.slice(at + 1) };
}

/**
 * `pageError`: the page body is already showing an error state (an outage
 * usually fails both reads); the bar then stays quiet instead of stacking a
 * second alert with its own retry.
 */
export function FolderBar({ pageError = false }: { pageError?: boolean }) {
  const { t } = useTranslation('library');
  const { toast } = useToast();
  const dir = useRpcQuery('downloads.dir', undefined, { staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const path = dir.data?.path;

  const change = async () => {
    setBusy(true);
    try {
      const next = await pickFolder(path);
      if (!next || next === path) return;
      await rpc('downloads.setDir', { path: next });
      await invalidate('downloads.dir');
      toast({ title: t('folderChanged'), description: next, variant: 'success' });
    } catch (err) {
      toast({ title: t('folderChangeFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!path) return;
    try {
      await rpc('app.openPath', { path });
    } catch (err) {
      toast({ title: t('folderOpenFailed'), description: errorDescription(err), variant: 'error' });
    }
  };

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-edge bg-surface px-4 py-2">
      <HardDrive aria-hidden size={18} className="shrink-0 text-fg-subtle" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-fg-subtle">{t('savingTo')}</span>
        {dir.isLoading ? (
          <Skeleton className="mt-1 h-3.5 w-64" />
        ) : dir.isError && pageError ? (
          // The page already shows the error and its retry; one alert is enough.
          <span className="text-[calc(13rem/15)] text-fg-muted" data-testid="downloads-dir-unavailable">
            {t('folderUnavailable')}
          </span>
        ) : dir.isError ? (
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[calc(13rem/15)] text-danger" role="alert" data-testid="downloads-dir-error">
            <span>{t('folderLoadFailed')}</span>
            <Button
              size="sm"
              variant="secondary"
              icon={<RotateCw size={14} aria-hidden />}
              loading={dir.isFetching}
              onClick={() => void dir.refetch()}
            >
              {t('tryAgain')}
            </Button>
          </span>
        ) : (
          <FolderPath path={path} unknown={t('folderUnknown')} />
        )}
      </div>
      {isDesktop && (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" icon={<FolderOpen size={16} aria-hidden />} onClick={() => void openFolder()} disabled={!path}>
            {t('openFolder')}
          </Button>
          <Button size="sm" icon={<FolderCog size={16} aria-hidden />} loading={busy} onClick={() => void change()}>
            {t('changeFolder')}
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The path on one line, cut in the middle when it does not fit: the start
 * (drive, parents) gives way first and the folder's own name stays whole. The
 * full path is in the tooltip and, once, for screen readers. Paths read left
 * to right in every locale.
 */
function FolderPath({ path, unknown }: { path: string | undefined; unknown: string }) {
  const cls = 'font-mono text-[calc(13rem/15)] text-fg';
  if (!path) return <span className={cls}>{unknown}</span>;
  const { head, tail } = splitPath(path);
  return (
    // An RTL page still lines the path up with its "Saving to" label, on the right.
    <span dir="ltr" className={`flex min-w-0 rtl:justify-end ${cls}`} title={path} data-testid="downloads-dir">
      <span className="sr-only">{path}</span>
      {head && (
        <span aria-hidden className="min-w-0 truncate">
          {head}
        </span>
      )}
      {/* Never shrinks for the head; truncates itself only when it alone is too long. */}
      <span aria-hidden className="max-w-full shrink-0 truncate">
        {tail}
      </span>
    </span>
  );
}
