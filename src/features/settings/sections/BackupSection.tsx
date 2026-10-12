import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Download, FileJson, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { BackupImportResult } from '@/api/rpc';
import { RpcError, isDesktop, rpc, rpcRaw } from '@/api/transport';

import { Button, Dialog, useToast } from '@/ui';
import { downloadText, readFileText } from '../../sources/lib/files';
import { absoluteTime, formatCount } from '../../sources/lib/format';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { MAX_BACKUP_BYTES, backupFileName, chooseBackupSavePath, inspectBackup, type BackupSummary } from '../lib/backup';
import type { SectionProps } from './types';

type Picked = { name: string; size: number; text: string; summary: BackupSummary };

export function BackupSection(_props: SectionProps) {
  const { t, i18n } = useTranslation('settings');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const fileHintId = useId();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BackupImportResult | null>(null);
  const [importError, setImportError] = useState<RpcError | null>(null);
  const lang = i18n.language;

  /**
   * Desktop: the native save dialog picks the file and the core writes it
   * (`backup.export` with `path`). A core that predates `path` answers with the
   * JSON instead, which then goes through the browser download like the web build.
   */
  const exportDesktop = async (): Promise<string | null> => {
    const path = await chooseBackupSavePath(t('backupSaveTitle'), backupFileName(), t('backupFileFilter'));
    if (!path) return null;
    const res = (await rpcRaw('backup.export', { includeSecrets, path })) as { json?: string; fileName?: string };
    if (res.json) {
      downloadText(backupFileName(), res.json);
      return res.fileName || backupFileName();
    }
    return path;
  };

  const exportWeb = async (): Promise<string> => {
    const { json, fileName } = await rpc('backup.export', { includeSecrets });
    const name = fileName || backupFileName();
    downloadText(name, json);
    return name;
  };

  const exportBackup = async () => {
    setExporting(true);
    try {
      const saved = isDesktop ? await exportDesktop() : await exportWeb();
      if (saved) toast({ variant: 'success', title: t('backupExported'), description: saved });
    } catch (e) {
      toast({ variant: 'error', title: t('backupExportFailed'), description: RpcError.from(e).message });
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setResult(null);
    setImportError(null);
    setPicked(null);
    if (file.size > MAX_BACKUP_BYTES) {
      setPickError('backupTooLarge');
      return;
    }
    try {
      const text = await readFileText(file);
      const check = inspectBackup(text);
      if (!check.ok) {
        setPickError(check.error);
        return;
      }
      setPickError(null);
      setPicked({ name: file.name, size: file.size, text, summary: check.summary });
    } catch {
      setPickError('backupReadFailed');
    }
  };

  const doImport = async () => {
    if (!picked) return;
    setConfirmReplace(false);
    setImporting(true);
    setImportError(null);
    try {
      const r = await rpc('backup.import', { json: picked.text, mode });
      setResult(r);
      setPicked(null);
      // Everything may have changed: sources, catalog, favorites, settings.
      await queryClient.invalidateQueries();
      toast({ variant: r.warnings.length ? 'info' : 'success', title: t('backupImported', { count: r.imported }) });
    } catch (e) {
      setImportError(RpcError.from(e));
    } finally {
      setImporting(false);
    }
  };

  const start = () => (mode === 'replace' ? setConfirmReplace(true) : void doImport());

  return (
    <SettingsSection title={t('sectionBackup')} description={t('sectionBackupLead')} testId="settings-backup">
      <SettingsGroup title={t('backupExport')} description={t('backupExportHint')}>
        <SwitchRow
          label={t('backupIncludeSecrets')}
          description={includeSecrets ? <span className="text-warning">{t('backupIncludeSecretsWarning')}</span> : t('backupIncludeSecretsHint')}
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          testId="toggle-include-secrets"
        />
        <div className="flex justify-end px-4 py-3">
          <Button variant="primary" icon={<Download aria-hidden className="size-4" />} loading={exporting} onClick={() => void exportBackup()} data-testid="backup-export">
            {t('backupExportButton')}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup title={t('backupImport')} description={t('backupImportHint')}>
        <div className="flex flex-col gap-3 px-4 py-4">
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            data-testid="backup-file-input"
            onChange={(e) => {
              void onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={<Upload aria-hidden className="size-4" />} aria-describedby={fileHintId} onClick={() => fileRef.current?.click()} disabled={importing}>
              {picked ? t('backupChooseAnother') : t('backupChooseFile')}
            </Button>
            <span id={fileHintId} className="text-sm text-fg-muted">
              {t('backupFileHint')}
            </span>
          </div>
          {pickError ? (
            <p role="alert" className="flex items-center gap-1.5 text-sm text-danger">
              <CircleAlert aria-hidden className="size-4" />
              {t(pickError)}
            </p>
          ) : null}
          {picked ? (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-2/60 p-3 text-sm" data-testid="backup-summary">
              <p className="flex items-center gap-2 font-medium text-fg">
                <FileJson aria-hidden className="size-4 text-accent" />
                <span className="truncate">{picked.name}</span>
              </p>
              <p className="text-fg-muted">
                {t('backupSummary', {
                  count: picked.summary.playlists,
                  m3u: picked.summary.byKind.m3u,
                  xtream: picked.summary.byKind.xtream,
                  stalker: picked.summary.byKind.stalker,
                })}
              </p>
              {picked.summary.exportedAt ? (
                <p className="text-fg-muted">{t('backupExportedAt', { when: absoluteTime(picked.summary.exportedAt, lang) })}</p>
              ) : null}
              {!picked.summary.includeSecrets && picked.summary.byKind.xtream + picked.summary.byKind.stalker > 0 ? (
                <p className="text-warning">{t('backupNoSecrets')}</p>
              ) : null}
            </div>
          ) : null}
        </div>
        <SettingsRow label={t('backupMode')} description={mode === 'merge' ? t('backupMergeHint') : t('backupReplaceHint')}>
          {({ id }) => (
            <Segmented<'merge' | 'replace'>
              id={id}
              label={t('backupMode')}
              value={mode}
              options={[
                { value: 'merge', label: t('backupMerge') },
                { value: 'replace', label: t('backupReplace') },
              ]}
              onChange={setMode}
            />
          )}
        </SettingsRow>
        <div className="flex justify-end px-4 py-3">
          <Button
            variant={mode === 'replace' ? 'danger' : 'primary'}
            loading={importing}
            disabled={!picked}
            onClick={start}
            data-testid="backup-import"
          >
            {mode === 'replace' ? t('backupImportReplaceButton') : t('backupImportButton')}
          </Button>
        </div>
      </SettingsGroup>

      {importError ? (
        <div role="alert" className="flex flex-wrap items-start gap-3 rounded-md border border-danger/50 bg-danger/10 p-4 text-sm" data-testid="backup-import-error">
          <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-fg">{t('backupImportFailed')}</p>
            <p className="text-fg-muted">{importError.message}</p>
          </div>
          {picked ? (
            <Button size="sm" variant="secondary" loading={importing} onClick={start} data-testid="backup-import-retry">
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4" aria-live="polite" data-testid="backup-result">
          <p className="flex items-center gap-2 font-medium text-fg">
            <CircleCheck aria-hidden className="size-5 text-success" />
            {t('backupResult', { imported: formatCount(result.imported, lang), skipped: formatCount(result.skipped, lang) })}
          </p>
          {result.warnings.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-medium text-warning">{t('backupWarnings', { count: result.warnings.length })}</p>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md bg-surface-2 p-3 text-sm text-fg-muted">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={confirmReplace}
        onClose={() => setConfirmReplace(false)}
        title={t('backupReplaceConfirmTitle')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReplace(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" onClick={() => void doImport()} data-testid="backup-replace-confirm">
              {t('backupReplaceConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-fg-muted">{t('backupReplaceConfirmBody')}</p>
      </Dialog>
    </SettingsSection>
  );
}
