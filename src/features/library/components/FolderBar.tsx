/** "Saving to <folder>" strip with change (desktop dialog) and open-folder actions. */

import { FolderCog, FolderOpen, HardDrive } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, Skeleton, useToast } from '../deps';

/** Opens the native folder picker. Returns undefined when the user cancels. */
export async function pickFolder(defaultPath?: string): Promise<string | undefined> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false, ...(defaultPath ? { defaultPath } : {}) });
  if (typeof picked === 'string' && picked.length > 0) return picked;
  return undefined;
}

export function FolderBar({ summary }: { summary?: string }) {
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
      toast({ title: t('folderChangeFailed'), description: RpcError.from(err).message, variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async () => {
    if (!path) return;
    try {
      await rpc('app.openPath', { path });
    } catch (err) {
      toast({ title: t('folderOpenFailed'), description: RpcError.from(err).message, variant: 'error' });
    }
  };

  return (
    <div className="flex min-h-12 flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-2">
      <HardDrive aria-hidden size={18} className="shrink-0 text-fg-subtle" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-fg-subtle">{t('savingTo')}</span>
        {dir.isLoading ? (
          <Skeleton className="mt-1 h-3.5 w-64" />
        ) : (
          <span className="truncate font-mono text-[13px] text-fg" title={path} data-testid="downloads-dir">
            {path ?? t('folderUnknown')}
          </span>
        )}
      </div>
      {summary && <span className="hidden text-[13px] text-fg-muted lg:inline">{summary}</span>}
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
