import { FolderOpen, FolderSearch, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, useToast } from '@/ui';
import { CommitInput, SettingsRow } from '../components';
import { cleanPath, type SettingsPatch } from '../lib/patch';
import { pickDirectoryDesktop } from './DownloadsFolderRow';

/** `<downloads>/recordings`, joined with the separator the downloads path already uses. */
export function defaultRecordingsDir(downloads: string): string {
  if (!downloads) return '';
  const sep = downloads.includes('\\') ? '\\' : '/';
  return `${downloads.replace(/[\\/]+$/, '')}${sep}recordings`;
}

/**
 * Where live recordings (`mpv.record`) go: `settings.recordingsDir`, or
 * `<downloads>/recordings` when unset (null).
 */
export function RecordingsFolderRow({ value, update }: { value: string | null; update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const downloads = useRpcQuery('downloads.dir', undefined, { staleTime: 60_000 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fallback = defaultRecordingsDir(downloads.data?.path ?? '');
  const shown = value ?? fallback;

  const save = async (next: string | null) => {
    setBusy(true);
    setError(null);
    const ok = await update({ recordingsDir: next });
    setBusy(false);
    if (ok) toast({ variant: 'success', title: next ? t('recordingsFolderSaved') : t('recordingsFolderReset'), description: next ?? undefined });
  };

  const choose = async () => {
    try {
      const picked = await pickDirectoryDesktop(t('chooseRecordingsFolder'), shown || undefined);
      if (picked && picked !== value) await save(picked);
    } catch (e) {
      setError(RpcError.from(e).message);
    }
  };

  const openFolder = async () => {
    try {
      await rpc('app.openPath', { path: shown });
    } catch (e) {
      toast({ variant: 'error', title: t('openFolderFailed'), description: RpcError.from(e).message });
    }
  };

  const resetButton = value ? (
    <Button variant="ghost" icon={<RotateCcw aria-hidden className="size-4" />} disabled={busy} onClick={() => void save(null)} data-testid="recordings-dir-reset">
      {t('useDefaultFolder')}
    </Button>
  ) : null;

  return (
    <SettingsRow
      label={t('recordingsFolder')}
      description={value ? t('recordingsFolderHintCustom') : t('recordingsFolderHint')}
      error={error}
      stack
    >
      {({ id, describedBy, invalid }) =>
        isDesktop ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            <output
              id={id}
              aria-describedby={describedBy}
              className="flex h-10 min-w-0 flex-1 items-center truncate rounded-md border border-border bg-surface-2 px-3 font-mono text-sm text-fg"
              title={shown}
              data-testid="recordings-dir-path"
            >
              {shown || t('downloadsFolderUnknown')}
            </output>
            <Button icon={<FolderSearch aria-hidden className="size-4" />} loading={busy} onClick={() => void choose()} data-testid="recordings-dir-choose">
              {t('chooseFolder')}
            </Button>
            <Button variant="ghost" icon={<FolderOpen aria-hidden className="size-4" />} disabled={!shown} onClick={() => void openFolder()}>
              {t('openFolder')}
            </Button>
            {resetButton}
          </div>
        ) : (
          <div className="flex w-full items-center gap-2">
            <CommitInput
              id={id}
              describedBy={describedBy}
              invalid={invalid}
              mono
              value={value ?? ''}
              placeholder={fallback || 'D:\\Videos\\recordings'}
              disabled={busy}
              onError={(key) => setError(key ? t(key) : null)}
              validate={(v) => (/[\r\n]/.test(v) ? 'errorPathNewline' : null)}
              onCommit={(v) => void save(cleanPath(v) || null)}
              testId="input-recordingsDir"
            />
            {resetButton}
          </div>
        )
      }
    </SettingsRow>
  );
}
