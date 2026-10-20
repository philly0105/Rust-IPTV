import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronRight, CircleAlert, CircleCheck, Download, FileJson, ShieldCheck, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { BackupImportResult } from '@/api/rpc';
import { RpcError, isDesktop, rpc, rpcRaw } from '@/api/transport';

import { requestPin } from '@/features/parental/gate';
import { holdImportToasts } from '@/shell/effects';
import { applyStatus, currentStatus } from '@/features/parental/status';
import { Button, Dialog, useToast, errorDescription } from '@/ui';
import { downloadText, readFileText } from '../../sources/lib/files';
import { absoluteTime, formatCount } from '../../sources/lib/format';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import { MAX_BACKUP_BYTES, backupFileName, chooseBackupSavePath, inspectBackup, parentalOptionsDiffer, type BackupSummary } from '../lib/backup';
import { ImageCacheRow } from './ImageCacheRow';
import { ResetGroup } from './ResetGroup';
import type { SectionProps } from './types';

type Picked = { name: string; size: number; text: string; summary: BackupSummary };

export function BackupSection({ update }: SectionProps) {
  const { t, i18n } = useTranslation('settings');
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const chooseFileRef = useRef<HTMLButtonElement>(null);
  const chooseAnotherRef = useRef<HTMLButtonElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const fileHintId = useId();
  const summaryId = useId();
  const [includeSecrets, setIncludeSecrets] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [pickError, setPickError] = useState<string | null>(null);
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmReplace, setConfirmReplace] = useState(false);
  // Merge of a file with new parental options while controls are locked: unlock first, or import without them.
  const [askParental, setAskParental] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<BackupImportResult | null>(null);
  const [importError, setImportError] = useState<RpcError | null>(null);
  const [dragOver, setDragOver] = useState(false);
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
      toast({ variant: 'error', title: t('backupExportFailed'), description: errorDescription(e) });
    } finally {
      setExporting(false);
    }
  };

  /**
   * Shows what came of a pick. The summary and the drop zone take turns, so the button that
   * opened the file picker may have just unmounted, which drops focus to <body> and sends the next
   * Tab back to the top of the page. Focus then goes to the choose button now showing: "Choose
   * another file" beside Import, or the drop zone's button after a file it could not read. A
   * file dropped with the pointer leaves focus where it was.
   */
  const settlePick = (next: Picked | null, error: string | null, fromButton: boolean) => {
    flushSync(() => {
      setPickError(error);
      setPicked(next);
    });
    const active = document.activeElement;
    if (fromButton && (!active || active === document.body)) (next ? chooseAnotherRef : chooseFileRef).current?.focus();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const active = document.activeElement;
    const fromButton = active !== null && (active === chooseFileRef.current || active === chooseAnotherRef.current);
    setResult(null);
    setImportError(null);
    setPicked(null);
    if (file.size > MAX_BACKUP_BYTES) {
      settlePick(null, 'backupTooLarge', fromButton);
      return;
    }
    try {
      const text = await readFileText(file);
      const check = inspectBackup(text);
      if (!check.ok) {
        settlePick(null, check.error, fromButton);
        return;
      }
      settlePick({ name: file.name, size: file.size, text, summary: check.summary }, null, fromButton);
    } catch {
      settlePick(null, 'backupReadFailed', fromButton);
    }
  };

  const doImport = async () => {
    if (!picked) return;
    setConfirmReplace(false);
    setAskParental(false);
    setImporting(true);
    setImportError(null);
    // The section's toast and result card report the import, not one shell toast per restored source.
    const release = holdImportToasts();
    try {
      // A merge returns once the sources are written; the ones that still need a catalog load afterwards.
      const r = await rpc('backup.import', { json: picked.text, mode, background: mode === 'merge' });
      // The file's card goes, and with it the Import button that had focus, which would drop focus
      // to <body> and send the next Tab back to the top of the page. Focus goes to the result
      // instead, so a screen reader reads it and Tab goes on from there.
      flushSync(() => {
        setResult(r);
        setPicked(null);
      });
      const active = document.activeElement;
      if (!active || active === document.body) resultRef.current?.focus();
      // Everything may have changed: sources, catalog, favorites, settings.
      await queryClient.invalidateQueries();
      const refreshing = r.refreshing?.length ?? 0;
      // `imported` counts sources added and sources merged into ones you have, so the copy claims neither.
      const counts = t('backupResult', { imported: formatCount(r.imported, lang), skipped: formatCount(r.skipped, lang) });
      toast({
        variant: r.warnings.length ? 'info' : 'success',
        title: t('backupImportDone'),
        description: refreshing > 0 ? `${counts} ${t('backupRefreshing', { count: refreshing })}` : counts,
      });
    } catch (e) {
      const err = RpcError.from(e);
      // Replace removes every source and its parental locks, so the core wants an unlocked session.
      // Ask for the PIN here and run the import again, rather than ending on an error with no way on.
      if (mode === 'replace' && err.code === 'auth') {
        const unlocked = await requestPin({
          title: t('backupReplacePinTitle'),
          description: t('backupReplacePinText'),
          confirmLabel: t('backupReplaceConfirm'),
          danger: true,
          submit: async (pin) => {
            applyStatus(await rpc('parental.unlock', { pin }));
          },
        });
        if (unlocked) await doImport();
        return;
      }
      setImportError(err);
    } finally {
      release();
      setImporting(false);
    }
  };

  /**
   * Merge: the core applies the file's parental options only while controls are unlocked, and
   * otherwise skips them with a warning (importing again re-downloads every source). So when the
   * options would change something and the session is locked, ask first. Replace asks for the PIN
   * on the core's refusal instead.
   */
  const startMerge = async () => {
    if (!picked) return;
    let locked = false;
    try {
      const s = await currentStatus();
      locked = s.enabled && !s.unlocked && parentalOptionsDiffer(picked.summary.parental, s);
    } catch {
      // Unknown status: import, and the result says what was skipped.
    }
    if (locked) setAskParental(true);
    else await doImport();
  };

  const unlockThenImport = async () => {
    setAskParental(false);
    const unlocked = await requestPin({
      title: t('backupParentalPinTitle'),
      confirmLabel: t('backupImportButton'),
      submit: async (pin) => {
        applyStatus(await rpc('parental.unlock', { pin }));
      },
    });
    if (unlocked) await doImport();
  };

  const start = () => (mode === 'replace' ? setConfirmReplace(true) : void startMerge());

  const choose = () => fileRef.current?.click();
  return (
    <SettingsSection title={t('sectionBackup')} description={t('sectionBackupLead')} testId="settings-backup">
      {/* The export is one choice and one action: the action sits in the group's header. A
          secondary button: it is always there, and Import is the page's one primary once a file
          is chosen. */}
      <SettingsGroup
        title={t('backupExport')}
        description={t('backupExportHint')}
        actions={
          <Button variant="secondary" icon={<Download aria-hidden size={16} />} loading={exporting} onClick={() => void exportBackup()} data-testid="backup-export">
            {t('backupExportButton')}
          </Button>
        }
      >
        <SwitchRow
          label={t('backupIncludeSecrets')}
          description={includeSecrets ? <span className="text-warning">{t('backupIncludeSecretsWarning')}</span> : t('backupIncludeSecretsHint')}
          checked={includeSecrets}
          onChange={setIncludeSecrets}
          testId="toggle-include-secrets"
        />
      </SettingsGroup>

      {/* How to import, then the file: the mode decides what Import does (and its label), so it
          comes before the button, which sits with the file it imports. */}
      <SettingsGroup title={t('backupImport')} description={t('backupImportHint')}>
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
          {picked ? (
            <div className="flex flex-col gap-1 rounded-md border border-edge bg-surface-2/60 p-3 text-body-sm" data-testid="backup-summary">
              <div className="flex items-center gap-2">
                <FileJson aria-hidden size={16} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-fg" title={picked.name}>
                  {picked.name}
                </span>
              </div>
              {/* What is in the file, read out with the Import button too. */}
              <div id={summaryId} className="flex flex-col gap-1">
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
                {picked.summary.skipped > 0 ? (
                  <p className="text-warning" data-testid="backup-skipped">
                    {picked.summary.skipped === picked.summary.playlists
                      ? t('backupNoPlaylists')
                      : t('backupSkippedEntries', { count: picked.summary.skipped })}
                  </p>
                ) : null}
                {!picked.summary.includeSecrets && picked.summary.byKind.xtream + picked.summary.byKind.stalker > 0 ? (
                  <p className="text-warning">{t('backupNoSecrets')}</p>
                ) : null}
              </div>
              {/* The file's actions end the card: no row of its own holding only a button. */}
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <Button ref={chooseAnotherRef} size="sm" variant="ghost" onClick={choose} disabled={importing} data-testid="backup-choose-another">
                  {t('backupChooseAnother')}
                </Button>
                <Button
                  size="sm"
                  variant={mode === 'replace' ? 'danger' : 'primary'}
                  icon={<Upload aria-hidden size={16} />}
                  loading={importing}
                  onClick={start}
                  aria-describedby={summaryId}
                  data-testid="backup-import"
                >
                  {mode === 'replace' ? t('backupImportReplaceButton') : t('backupImportButton')}
                </Button>
              </div>
            </div>
          ) : (
            // A drop zone as well as a button: a backup is usually a file the user already has open in a folder.
            <div
              className={clsx(
                'flex flex-col items-center gap-2 rounded-lg border border-dashed px-4 py-6 text-center motion-safe:transition-colors',
                dragOver ? 'border-focus bg-hover' : 'border-border',
              )}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                void onFile(e.dataTransfer.files?.[0]);
              }}
              data-testid="backup-dropzone"
            >
              <Upload aria-hidden size={18} className="text-fg-subtle" />
              {/* Nothing to drag on a touch screen: the button alone. */}
              <p className="text-body-sm text-fg-muted pointer-coarse:hidden">{t('backupDropHint')}</p>
              <Button ref={chooseFileRef} size="sm" variant="secondary" aria-describedby={fileHintId} onClick={choose} disabled={importing}>
                {t('backupChooseFile')}
              </Button>
              <span id={fileHintId} className="text-caption text-fg-subtle">
                {t('backupFileHint')}
              </span>
            </div>
          )}
          {pickError ? (
            <p role="alert" className="flex items-center gap-1.5 text-body-sm text-danger">
              <CircleAlert aria-hidden size={16} className="shrink-0" />
              {t(pickError)}
            </p>
          ) : null}
        </div>
      </SettingsGroup>

      {importError ? (
        <div role="alert" className="flex flex-wrap items-start gap-3 rounded-lg border border-danger/50 bg-danger/10 p-4 text-body-sm" data-testid="backup-import-error">
          <CircleAlert aria-hidden size={16} className="mt-0.5 shrink-0 text-danger" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-fg">{t('backupImportFailed')}</p>
            {/* SS-18: the translated hint for the core's error code leads; its own words follow, small. */}
            <p className="text-fg-muted">{errorDescription(importError)}</p>
          </div>
          {picked ? (
            <Button size="sm" variant="secondary" loading={importing} onClick={start} data-testid="backup-import-retry">
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {result ? (
        <div
          ref={resultRef}
          tabIndex={-1}
          className="flex flex-col gap-3 rounded-lg border border-edge bg-surface p-4 outline-none"
          aria-live="polite"
          data-testid="backup-result"
        >
          <p className="flex items-center gap-2 font-medium text-fg">
            <CircleCheck aria-hidden size={18} className="shrink-0 text-success" />
            {t('backupResult', { imported: formatCount(result.imported, lang), skipped: formatCount(result.skipped, lang) })}
          </p>
          {result.warnings.length > 0 ? (
            // The core writes these notes in English: a translated count leads, the notes themselves fold away.
            <details className="group" data-testid="backup-warnings">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-xs text-body-sm font-medium text-warning [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden size={14} className="group-open:rotate-90 motion-safe:transition-transform rtl:rotate-180 rtl:group-open:rotate-90" />
                {t('backupWarnings', { count: result.warnings.length })}
              </summary>
              <ul className="mt-1.5 flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md bg-surface-2 p-3 text-body-sm text-fg-muted">
                {result.warnings.map((w, i) => (
                  <li key={i} dir="auto">
                    {w}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={askParental}
        onClose={() => setAskParental(false)}
        title={t('backupParentalTitle')}
        size="sm"
        testId="backup-parental"
        footer={
          <>
            <Button variant="ghost" onClick={() => void doImport()} data-testid="backup-parental-skip">
              {t('backupParentalSkip')}
            </Button>
            <Button variant="primary" icon={<ShieldCheck aria-hidden className="size-4" />} onClick={() => void unlockThenImport()} data-autofocus="" data-testid="backup-parental-unlock">
              {t('backupParentalUnlock')}
            </Button>
          </>
        }
      >
        <p className="text-fg-muted">{t('backupParentalBody')}</p>
      </Dialog>

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

      {/* Run 3 C3: the disk image cache (size against the cap, the cap, Clear). Server mode has one too. */}
      <SettingsGroup title={t('storageGroup')}>
        <ImageCacheRow update={update} />
      </SettingsGroup>

      <ResetGroup update={update} />
    </SettingsSection>
  );
}
