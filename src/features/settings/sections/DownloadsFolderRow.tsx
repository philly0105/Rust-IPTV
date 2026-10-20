import { FolderOpen, FolderSearch, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, Skeleton, useToast, errorDescription } from '@/ui';
import { redactText } from '../../sources/lib/redact';
import { SettingsRow } from '../components';

/** Desktop only: native folder picker. Undefined when canceled. */
export async function pickDirectoryDesktop(title: string, defaultPath?: string): Promise<string | undefined> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ title, directory: true, multiple: false, ...(defaultPath ? { defaultPath } : {}) });
  return typeof picked === 'string' && picked.length > 0 ? picked : undefined;
}

/**
 * Downloads folder (`downloads.dir` / `downloads.setDir`). Desktop picks with
 * the native dialog; the core checks the folder exists and is writable, and
 * its message is shown inline when it refuses. In the browser the folder is
 * fixed by the server (`downloads.setDir` refuses there), so the row only
 * names it. `custom` = settings.downloadsDir is set.
 */
export function DownloadsFolderRow({ custom }: { custom: boolean }) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const dir = useRpcQuery('downloads.dir', undefined, { staleTime: 60_000 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const path = dir.data?.path ?? '';

  const apply = async (next: string) => {
    setBusy(true);
    setError(null);
    try {
      await rpc('downloads.setDir', { path: next });
      await Promise.all([invalidate('downloads.'), invalidate('settings.get')]);
      toast({
        variant: 'success',
        title: next ? t('downloadsFolderSaved') : t('downloadsFolderReset'),
        description: next || undefined,
      });
    } catch (e) {
      setError(t('downloadsFolderFailed', { message: redactText(RpcError.from(e).message) }));
    } finally {
      setBusy(false);
    }
  };

  const choose = async () => {
    try {
      const picked = await pickDirectoryDesktop(t('chooseDownloadsFolder'), path || undefined);
      if (picked && picked !== path) await apply(picked);
    } catch (e) {
      setError(t('downloadsFolderFailed', { message: RpcError.from(e).message }));
    }
  };

  const openFolder = async () => {
    try {
      await rpc('app.openPath', { path });
    } catch (e) {
      toast({ variant: 'error', title: t('openFolderFailed'), description: errorDescription(e) });
    }
  };

  return (
    <SettingsRow
      label={t('downloadsFolder')}
      description={isDesktop ? t('downloadsFolderHint') : t('downloadsFolderHintServer')}
      error={error}
      stack
    >
      {({ id, describedBy }) =>
        dir.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : dir.isError ? (
          <div role="alert" className="flex w-full flex-wrap items-start gap-3 text-body-sm" data-testid="downloads-dir-error">
            <span className="min-w-0 flex-1">
              <span className="block text-danger">{t('downloadsFolderLoadFailed')}</span>
              <span className="block text-fg-muted">{errorDescription(dir.error)}</span>
            </span>
            <Button size="sm" variant="secondary" onClick={() => void dir.refetch()}>
              {t('retry')}
            </Button>
          </div>
        ) : isDesktop ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <output
              id={id}
              aria-describedby={describedBy}
              className="flex h-10 min-w-0 flex-1 items-center truncate rounded-md border border-edge bg-surface-2 px-3 font-mono text-sm text-fg"
              title={path}
              data-testid="downloads-dir-path"
            >
              {path || t('downloadsFolderUnknown')}
            </output>
            <Button icon={<FolderSearch aria-hidden className="size-4" />} loading={busy} onClick={() => void choose()} data-testid="downloads-dir-choose">
              {t('chooseFolder')}
            </Button>
            <Button variant="ghost" icon={<FolderOpen aria-hidden className="size-4" />} disabled={!path} onClick={() => void openFolder()}>
              {t('openFolder')}
            </Button>
            {custom ? (
              <Button variant="ghost" icon={<RotateCcw aria-hidden className="size-4" />} disabled={busy} onClick={() => void apply('')}>
                {t('useDefaultFolder')}
              </Button>
            ) : null}
          </div>
        ) : (
          <output
            id={id}
            aria-describedby={describedBy}
            className="flex h-10 w-full min-w-0 items-center truncate rounded-md border border-edge bg-surface-2 px-3 font-mono text-sm text-fg"
            title={path}
            data-testid="downloads-dir-path"
          >
            {path || t('downloadsFolderUnknown')}
          </output>
        )
      }
    </SettingsRow>
  );
}
