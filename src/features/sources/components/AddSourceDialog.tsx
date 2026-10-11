import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import type { SourcesAddArgs } from '@/api/rpc';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { Source, SourceKind } from '@/api/types';

import { Button, Dialog, Input, Tabs, Toggle, useToast } from '@/ui';
import { buildAddArgs, buildUpdatePatch, emptyDraft, type DraftErrors, type SourceDraft } from '../lib/draft';
import { enabledEpgUrls, refreshGuides, useGuideProgressFeed } from '../lib/epgRefresh';
import { claimImportErrors, failedSourceId, nextStepKey, summaryKey } from '../lib/errors';
import { useImportProgressFeed, useImportProgressStore, useNewSourceProgress, useSourceProgress } from '../lib/progress';
import { redactText } from '../lib/redact';
import { useNextFrame } from '../lib/useNextFrame';
import { parseXtreamLink, suggestName } from '../lib/validate';
import { Field } from './Field';
import { ImportProgressView } from './ImportProgressView';
import { M3uForm } from './M3uForm';
import { StalkerForm } from './StalkerForm';
import { XtreamForm } from './XtreamForm';

export interface AddSourceInitial {
  kind?: SourceKind;
  /** Prefills the M3U URL, or the Xtream fields when it is a `get.php` link. */
  url?: string;
  name?: string;
}

/** Draft for an initial request (deep link / onboarding tile). */
export function initialDraft(initial: AddSourceInitial | undefined): SourceDraft {
  const url = initial?.url?.trim() ?? '';
  const xt = url ? parseXtreamLink(url) : null;
  if (xt && (initial?.kind === undefined || initial.kind === 'xtream')) {
    const d = emptyDraft('xtream');
    d.xtream = xt;
    d.name = initial?.name ?? suggestName(xt.serverUrl);
    return d;
  }
  const kind = initial?.kind ?? 'm3u';
  const d = emptyDraft(kind);
  if (url) {
    if (kind === 'm3u') d.m3u.url = url;
    else if (kind === 'xtream') d.xtream.serverUrl = url;
    else d.stalker.portalUrl = url;
    d.name = suggestName(url);
  }
  if (initial?.name) d.name = initial.name;
  return d;
}

export function AddSourceDialog({
  open,
  onClose,
  initial,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  initial?: AddSourceInitial;
  onAdded?: (source: Source) => void;
}) {
  const { t } = useTranslation('sources');
  const navigate = useNavigate();
  const { toast } = useToast();
  useImportProgressFeed();
  useGuideProgressFeed();

  const [draft, setDraft] = useState<SourceDraft>(() => initialDraft(initial));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [nameTouched, setNameTouched] = useState(Boolean(initial?.name));
  // A name derived from the URL or file. It shows as the placeholder and is used only when the name is left empty,
  // so it never lands in the middle of what the user is typing.
  const [suggested, setSuggested] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<RpcError | null>(null);
  // Set once `sources.add` created a source whose import failed. Further submits retry that source
  // (update + re-import, or replace it when the kind or origin changed) instead of adding another.
  const [failed, setFailed] = useState<{ id: string; name: string } | null>(null);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nextFrame = useNextFrame();
  /**
   * Import errors this dialog reports itself, so the shell does not toast them as well:
   * the source a failed add left behind, and, from the first submit until one succeeds,
   * any source that was not in the list when it started (the one `sources.add` creates).
   */
  const claimRef = useRef<{ failedId: string | null; knownAtSubmit: Set<string> | null }>({ failedId: null, knownAtSubmit: null });

  // Reset whenever the dialog opens with a (possibly new) initial request.
  const initialKey = JSON.stringify(initial ?? null);
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(initial));
    setErrors({});
    setNameTouched(Boolean(initial?.name));
    setSuggested('');
    setSubmitError(null);
    setStartedAt(null);
    setFailed(null);
    claimRef.current = { failedId: null, knownAtSubmit: null };
  }, [open, initialKey]);

  useEffect(() => {
    if (!open) return;
    return claimImportErrors((id) => {
      const c = claimRef.current;
      return id === c.failedId || (c.knownAtSubmit !== null && !c.knownAtSubmit.has(id));
    });
  }, [open]);

  const sources = useRpcQuery('sources.list', undefined, { enabled: open });
  const knownIds = useMemo(() => (sources.data ?? []).map((s) => s.id), [sources.data]);
  const newProgress = useNewSourceProgress(knownIds, startedAt);
  const retryProgress = useSourceProgress(failed?.id);
  const progress = failed ? retryProgress : newProgress;

  const suggest = (input: string) => setSuggested(suggestName(input));

  const setKind = (kind: SourceKind) => {
    setDraft((d) => ({ ...d, kind }));
    setErrors({});
    setSubmitError(null);
  };

  const focusFirstInvalid = () => {
    nextFrame(() => {
      bodyRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    });
  };

  const submit = async () => {
    setSubmitError(null);
    const named = draft.name.trim() ? draft : { ...draft, name: suggested };
    const built = buildAddArgs(named, { isDesktop });
    setErrors(built.errors);
    if (!built.ok) {
      focusFirstInvalid();
      return;
    }
    setSubmitting(true);
    setStartedAt(Date.now());
    claimRef.current.knownAtSubmit ??= new Set(knownIds);
    try {
      const source = failed ? await retry(failed.id, named, built.value) : await rpc('sources.add', built.value);
      if (!source) {
        focusFirstInvalid();
        return;
      }
      // Load the guide right away (playlist url-tvg, Xtream xmltv.php). It runs in the
      // background; the source card shows its progress.
      const guides = enabledEpgUrls(source.epg);
      if (guides.length > 0) void refreshGuides(guides);
      await Promise.all([invalidate('sources.'), invalidate('catalog.'), invalidate('epg.')]);
      const total = source.channelCount + source.movieCount + source.seriesCount;
      toast({
        variant: 'success',
        title: t('addedTitle', { name: source.name }),
        description: t(guides.length > 0 ? 'addedDescriptionGuide' : 'addedDescription', { count: total }),
        action: { label: t('open'), onClick: () => navigate(`/s/${source.id}/live`) },
      });
      claimRef.current = { failedId: null, knownAtSubmit: null };
      onAdded?.(source);
      onClose();
    } catch (e) {
      const err = RpcError.from(e);
      setSubmitError(err);
      // The core keeps a source whose import failed (with lastError) and names it in the error.
      // Remember it so the next submit retries it rather than adding a duplicate. A transport
      // failure (proxy 504, network blip during a long import) names nothing although the core
      // may already have created the row: look for it among the sources that are new since submit.
      const id = failedSourceId(err) ?? (failed ? null : await adoptCreatedSource(built.value));
      if (id) claimRef.current.failedId = id;
      if (id) setFailed({ id, name: built.value.name });
      else setFailed((f) => (f ? { ...f, name: built.value.name } : f));
      void invalidate('sources.');
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * The source this dialog's `sources.add` created when the response never arrived: the one id
   * not known at the first submit (or, when several are new, the one with this kind and name).
   */
  const adoptCreatedSource = async (args: SourcesAddArgs): Promise<string | null> => {
    const known = claimRef.current.knownAtSubmit;
    if (!known) return null;
    let list: Source[];
    try {
      list = await rpc('sources.list');
    } catch {
      return null;
    }
    const fresh = list.filter((s) => !known.has(s.id));
    if (fresh.length === 1) return fresh[0]!.id;
    const same = fresh.filter((s) => s.kind === args.kind && s.name === args.name);
    return same.length === 1 ? same[0]!.id : null;
  };

  /**
   * Retries the source a failed add left behind. Same kind and M3U origin: save the edited details
   * and re-import it. Otherwise (or when it is gone) the config cannot be patched, so it is replaced.
   */
  const retry = async (id: string, named: SourceDraft, args: SourcesAddArgs): Promise<Source | null> => {
    let existing: Source | null = null;
    try {
      existing = await rpc('sources.get', { id });
    } catch (e) {
      if (RpcError.from(e).code !== 'not_found') throw e;
    }
    const patchable =
      existing !== null &&
      existing.kind === args.kind &&
      (args.kind !== 'm3u' || (existing.m3u?.origin === args.m3u?.origin && args.m3u?.origin !== 'text'));
    if (existing && patchable) {
      const patch = buildUpdatePatch(existing, named, { isDesktop });
      if (!patch.ok) {
        setErrors(patch.errors);
        return null;
      }
      if (Object.keys(patch.value).length > 0) await rpc('sources.update', { id, patch: patch.value });
      // Drop the previous attempt's error entry so the progress view starts fresh.
      useImportProgressStore.getState().clear(id);
      return rpc('sources.refresh', { id });
    }
    if (existing) await rpc('sources.remove', { id });
    setFailed(null);
    return rpc('sources.add', args);
  };

  const kinds: { id: SourceKind; label: string }[] = [
    { id: 'm3u', label: t('kindM3u') },
    { id: 'xtream', label: t('kindXtream') },
    { id: 'stalker', label: t('kindStalker') },
  ];

  const isTextOrigin = draft.kind === 'm3u' && draft.m3u.origin !== 'url' && !(draft.m3u.origin === 'file' && isDesktop);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('addSource')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {submitting ? t('closeKeepImporting') : t('cancel')}
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void submit()} data-testid="add-source-submit">
            {submitting ? t(failed ? 'retrying' : 'adding') : t(failed ? 'retryImport' : 'addSourceSubmit')}
          </Button>
        </>
      }
    >
      <form
        ref={bodyRef}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Tabs items={kinds} value={draft.kind} onChange={(id) => setKind(id as SourceKind)} />

        <Field label={t('sourceName')} error={errors.name ? t(errors.name) : null}>
          {(p) => (
            <Input
              {...p}
              autoComplete="off"
              disabled={submitting}
              maxLength={120}
              placeholder={suggested || t('sourceNamePlaceholder')}
              value={draft.name}
              // A prefilled name (deep link) is replaced by the first keystroke until the user edits it.
              onFocus={(e) => {
                if (!nameTouched && draft.name) e.currentTarget.select();
              }}
              onChange={(e) => {
                setNameTouched(e.target.value.length > 0);
                setDraft((d) => ({ ...d, name: e.target.value }));
              }}
            />
          )}
        </Field>

        {draft.kind === 'm3u' ? (
          <M3uForm
            mode="add"
            value={draft.m3u}
            onChange={(m3u) => setDraft((d) => ({ ...d, m3u }))}
            errors={errors}
            isDesktop={isDesktop}
            disabled={submitting}
            onSuggestName={suggest}
            onUseXtream={(xtream) => {
              setDraft((d) => ({ ...d, kind: 'xtream', xtream }));
              setSuggested(suggestName(xtream.serverUrl));
              setErrors({});
            }}
          />
        ) : null}
        {draft.kind === 'xtream' ? (
          <XtreamForm
            value={draft.xtream}
            onChange={(xtream) => setDraft((d) => ({ ...d, xtream }))}
            errors={errors}
            onErrors={setErrors}
            disabled={submitting}
            onSuggestName={suggest}
          />
        ) : null}
        {draft.kind === 'stalker' ? (
          <StalkerForm
            value={draft.stalker}
            onChange={(stalker) => setDraft((d) => ({ ...d, stalker }))}
            errors={errors}
            onErrors={setErrors}
            disabled={submitting}
            onSuggestName={suggest}
          />
        ) : null}

        <Toggle
          checked={draft.autoRefresh && !isTextOrigin}
          disabled={submitting || isTextOrigin}
          onChange={(autoRefresh) => setDraft((d) => ({ ...d, autoRefresh }))}
          label={t('autoRefresh')}
          description={isTextOrigin ? t('autoRefreshUnavailable') : t('autoRefreshHint')}
        />

        {submitting ? <ImportProgressView entry={progress} /> : null}

        {submitError ? (
          <div role="alert" className="flex gap-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm" data-testid="add-source-error">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-fg">{t('addFailed')}</p>
              <p className="text-fg">{t(summaryKey(submitError))}</p>
              <p className="text-fg-muted">{t(nextStepKey(submitError))}</p>
              {failed ? (
                <p className="text-fg-muted" data-testid="add-source-retry-note">
                  {t('addRetryNote', { name: failed.name })}
                </p>
              ) : null}
              <details className="text-fg-muted">
                <summary className="cursor-pointer select-none text-xs">{t('technicalDetails')}</summary>
                <p className="mt-1 break-words font-mono text-xs">{redactText(submitError.message)}</p>
              </details>
            </div>
          </div>
        ) : null}

        {/* Enter in any field submits. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
