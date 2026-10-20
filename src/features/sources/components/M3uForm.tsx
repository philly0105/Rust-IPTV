import { FileText, FolderOpen, Upload } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { M3uOrigin } from '@/api/types';

import { Button, Input, Tabs, Textarea } from '@/ui';
import type { DraftErrors, M3uDraft } from '../lib/draft';
import { MAX_WEB_FILE_BYTES, PLAYLIST_EXTENSIONS, baseName, formatFileSize, pickPathDesktop, readFileText } from '../lib/files';
import { usePlaylistPreview } from '../lib/usePreview';
import { parseXtreamLink } from '../lib/validate';
import { Field } from './Field';
import { HeadersFields } from './HeadersFields';
import { PreviewPanel } from './PreviewPanel';

export interface M3uFormProps {
  value: M3uDraft;
  onChange: (next: M3uDraft) => void;
  errors: DraftErrors;
  isDesktop: boolean;
  disabled?: boolean;
  /** Add mode lets the user switch origin; edit mode keeps the stored origin. */
  mode: 'add' | 'edit';
  /** Called when the user accepts the "this is an Xtream link" suggestion. */
  onUseXtream?: (cfg: { serverUrl: string; username: string; password: string }) => void;
  /** Lets the dialog suggest a name from a URL or file. */
  onSuggestName?: (input: string) => void;
  /** Validates one field (error path, e.g. `m3u.url`) when the user leaves it. */
  onFieldBlur?: (path: string) => void;
}

export function M3uForm({ value, onChange, errors, isDesktop, disabled, mode, onUseXtream, onSuggestName, onFieldBlur }: M3uFormProps) {
  const { t, i18n } = useTranslation('sources');
  const fileInput = useRef<HTMLInputElement>(null);
  const fileHintId = useId();
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const set = (patch: Partial<M3uDraft>) => onChange({ ...value, ...patch });

  // Edit mode of a pasted playlist: a chosen file replaces the typed text.
  const editText = value.origin === 'text' && mode === 'edit';
  const previewText = editText && value.fileText ? value.fileText : value.origin === 'text' ? value.text : value.origin === 'file' ? value.fileText : '';
  const preview = usePlaylistPreview(previewText);
  const xtreamLink = value.origin === 'url' ? parseXtreamLink(value.url) : null;

  const err = (k: string) => {
    const key = errors[k];
    return key ? t(key) : null;
  };

  const chooseDesktopFile = async () => {
    setFileError(null);
    try {
      const path = await pickPathDesktop({ title: t('chooseFile'), filterName: t('playlistFiles'), extensions: PLAYLIST_EXTENSIONS });
      if (path) {
        set({ filePath: path, fileName: baseName(path), fileText: '' });
        onSuggestName?.(path);
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    }
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    setFileError(null);
    // Reading a huge file into one string can stall or crash the page; such lists belong at a URL.
    if (file.size > MAX_WEB_FILE_BYTES) {
      setFileError(t('errorFileTooLarge', { size: formatFileSize(file.size, i18n.language) }));
      return;
    }
    setReading(true);
    try {
      const text = await readFileText(file);
      set({ fileText: text, fileName: file.name, filePath: '', ...(editText ? { text: '' } : {}) });
      onSuggestName?.(file.name);
    } catch (e) {
      setFileError(t('errorFileRead', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setReading(false);
    }
  };

  // Reads the file in the page; the core gets its text (web uploads, and new text for a pasted playlist).
  const uploadButton = (
    <>
      <input
        ref={fileInput}
        type="file"
        accept=".m3u,.m3u8,.txt,audio/x-mpegurl,application/vnd.apple.mpegurl,application/x-mpegurl,text/plain"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        data-testid="m3u-file-input"
        onChange={(e) => {
          void onFileChosen(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <Button
        icon={<Upload aria-hidden className="size-4" />}
        loading={reading}
        disabled={disabled}
        aria-describedby={fileHintId}
        onClick={() => fileInput.current?.click()}
      >
        {value.fileName ? t('chooseAnotherFile') : t('chooseFile')}
      </Button>
    </>
  );
  const chosenFile = value.fileName ? (
    <span className="flex min-w-0 items-center gap-1.5 text-sm text-fg-muted" title={value.filePath || value.fileName}>
      <FileText aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{value.fileName}</span>
    </span>
  ) : null;

  const origins: { id: M3uOrigin; label: string }[] = [
    { id: 'url', label: t('originUrl') },
    { id: 'file', label: t('originFile') },
    { id: 'text', label: t('originText') },
  ];

  return (
    <div className="flex flex-col gap-5">
      {mode === 'add' ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg" id={`${fileHintId}-origin`}>
            {t('m3uOriginLabel')}
          </span>
          <Tabs items={origins} value={value.origin} onChange={(id) => set({ origin: id as M3uOrigin })} />
        </div>
      ) : null}

      {value.origin === 'url' ? (
        <>
          <Field label={t('playlistUrl')} error={err('m3u.url')} hint={t('playlistUrlHint')}>
            {(p) => (
              <Input
                {...p}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
                placeholder="https://provider.example/playlist.m3u"
                value={value.url}
                onChange={(e) => set({ url: e.target.value })}
                onBlur={() => {
                  onSuggestName?.(value.url);
                  onFieldBlur?.('m3u.url');
                }}
              />
            )}
          </Field>
          {xtreamLink && onUseXtream ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-edge bg-surface-2 px-3 py-2.5 text-sm">
              <p className="min-w-0 flex-1 text-fg">{t('xtreamLinkDetected')}</p>
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onUseXtream(xtreamLink)}>
                {t('useXtreamImport')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {value.origin === 'file' ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-fg">{t('playlistFile')}</span>
          <div className="flex flex-wrap items-center gap-3">
            {isDesktop ? (
              <Button icon={<FolderOpen aria-hidden className="size-4" />} disabled={disabled} onClick={() => void chooseDesktopFile()}>
                {value.filePath ? t('chooseAnotherFile') : t('chooseFile')}
              </Button>
            ) : (
              uploadButton
            )}
            {chosenFile}
          </div>
          <p id={fileHintId} className="text-sm text-fg-muted">
            {isDesktop ? t('fileHintDesktop') : t('fileHintWeb')}
          </p>
          {fileError || err('m3u.file') ? (
            <p role="alert" className="text-sm text-danger">
              {fileError ?? err('m3u.file')}
            </p>
          ) : null}
        </div>
      ) : null}

      {editText ? (
        <>
          <p className="rounded-md border border-edge bg-surface-2/60 p-3 text-sm text-fg-muted" data-testid="m3u-text-origin-note">
            {t('textOriginReplaceNote')}
          </p>
          <Field label={t('replacePlaylistText')} error={err('m3u.text')} hint={t('replacePlaylistTextHint')}>
            {(p) => (
              <Textarea
                {...p}
                rows={6}
                spellCheck={false}
                disabled={disabled}
                className="font-mono text-sm"
                data-testid="m3u-replace-text"
                value={value.text}
                onChange={(e) => set({ text: e.target.value, fileText: '', fileName: '' })}
              />
            )}
          </Field>
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-3">
              {uploadButton}
              {chosenFile}
            </div>
            <p id={fileHintId} className="text-sm text-fg-muted">
              {t('replacePlaylistFileHint')}
            </p>
            {fileError || err('m3u.file') ? (
              <p role="alert" className="text-sm text-danger">
                {fileError ?? err('m3u.file')}
              </p>
            ) : null}
          </div>
        </>
      ) : null}

      {value.origin === 'text' && mode === 'add' ? (
        <Field label={t('playlistText')} error={err('m3u.text')} hint={t('playlistTextHint')}>
          {(p) => (
            <Textarea
              {...p}
              rows={8}
              spellCheck={false}
              disabled={disabled}
              className="font-mono text-sm"
              placeholder={'#EXTM3U\n#EXTINF:-1 tvg-id="news.1" group-title="News",News One\nhttps://example.com/news1.m3u8'}
              value={value.text}
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
        </Field>
      ) : null}

      {value.origin === 'file' || (value.origin === 'text' && mode === 'add') || (editText && previewText) ? <PreviewPanel state={preview} /> : null}

      <HeadersFields
        value={value.headers}
        onChange={(headers) => set({ headers })}
        errors={errors}
        prefix="m3u.headers"
        disabled={disabled}
      />
    </div>
  );
}
