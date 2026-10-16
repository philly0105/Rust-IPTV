import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import type { SourcesAddArgs } from '@/api/rpc';
import { RpcError, isDesktop, rpc, rpcRaw } from '@/api/transport';
import type { Source, SourceKind } from '@/api/types';

import { Button, Dialog, Input, Tabs, Toggle, useToast } from '@/ui';
import {
  blurError,
  buildAddArgs,
  buildUpdatePatch,
  clearChangedErrors,
  emptyDraft,
  withFieldError,
  type DraftErrors,
  type SourceDraft,
} from '../lib/draft';
import { enabledEpgUrls, refreshGuides, useGuideProgressFeed } from '../lib/epgRefresh';
import { claimImportErrors, duplicateSourceId, duplicateSourceName, failedSourceId, fieldForError, nextStepKey, summaryKey } from '../lib/errors';
import {
  beginImport,
  cancelImport,
  useImportProgressFeed,
  useImportProgressStore,
  useNewSourceProgress,
  useSourceProgress,
  wasCancelled,
} from '../lib/progress';
import { flushPendingRemovals, isRemovalPending, removeOnUnload, scheduleRemoval } from '../lib/pendingRemoval';
import { redactText } from '../lib/redact';
import { useFocusInvalid } from '../lib/useFocusInvalid';
import { useNextFrame } from '../lib/useNextFrame';
import { checkHttpUrl, displayHost, parseXtreamLink, suggestName } from '../lib/validate';
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

/** Host a draft's import contacts, for the progress line; none for a file or pasted playlist. */
export function draftHost(d: SourceDraft): string | undefined {
  const raw = d.kind === 'm3u' ? (d.m3u.origin === 'url' ? d.m3u.url : '') : d.kind === 'xtream' ? d.xtream.serverUrl : d.stalker.portalUrl;
  const check = checkHttpUrl(raw);
  return check.ok ? displayHost(check.url) : undefined;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  // Source ids that existed when the submit started. The live list would absorb the new source as soon as
  // `sources.list` refetches mid-import, and the dialog would lose its progress and Cancel button.
  const [idsAtSubmit, setIdsAtSubmit] = useState<readonly string[]>([]);
  const [submitError, setSubmitError] = useState<RpcError | null>(null);
  // Set once `sources.add` created a source whose import failed. Further submits retry that source
  // (update + re-import, or replace it when the kind or origin changed) instead of adding another.
  const [failed, setFailed] = useState<{ id: string; name: string } | null>(null);
  // The last submit's import was cancelled (C8); shows the cancelled note until the next submit.
  const [cancelled, setCancelled] = useState(false);
  // Source whose import the user asked to stop, so the rejection that follows reads as the cancel.
  const cancelIdRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLFormElement>(null);
  const cancelledRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const scrollFrame = useNextFrame();
  /**
   * Bumped whenever the dialog opens, closes or unmounts. A submit left running by "Close, keep
   * importing" finishes in the background (the source card shows it), but once its opening is
   * over it no longer drives this form, and never closes the dialog the user opened since.
   */
  const runRef = useRef(0);
  /**
   * Import errors this dialog reports itself, so the shell does not toast them as well:
   * the source a failed add left behind, and, from the first submit until one succeeds,
   * any source that was not in the list when it started (the one `sources.add` creates).
   */
  const claimRef = useRef<{ failedId: string | null; knownAtSubmit: Set<string> | null }>({ failedId: null, knownAtSubmit: null });

  // Reset whenever the dialog opens with a (possibly new) initial request.
  const initialKey = JSON.stringify(initial ?? null);
  useEffect(
    () => () => {
      runRef.current += 1;
    },
    [open, initialKey],
  );
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(initial));
    setErrors({});
    setNameTouched(Boolean(initial?.name));
    setSuggested('');
    setSubmitting(false);
    setSubmitError(null);
    setStartedAt(null);
    setIdsAtSubmit([]);
    setFailed(null);
    setCancelled(false);
    cancelIdRef.current = null;
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
  const newProgress = useNewSourceProgress(idsAtSubmit, startedAt);
  const retryProgress = useSourceProgress(failed?.id);
  const progress = failed ? retryProgress : newProgress;
  const cancellingImport = useImportProgressStore((s) => (progress ? s.cancelling[progress.sourceId] === true : false));

  const onCancelImport = () => {
    const id = progress?.sourceId;
    if (!id) return;
    cancelIdRef.current = id;
    cancelImport(id).catch((e: unknown) => {
      cancelIdRef.current = null;
      toast({ variant: 'error', title: t('cancelFailed'), description: t(summaryKey(RpcError.from(e))) });
    });
  };

  const suggest = (input: string) => setSuggested(suggestName(input));

  // An inline error goes away as soon as the user edits its field.
  const prevDraft = useRef(draft);
  useEffect(() => {
    const prev = prevDraft.current;
    prevDraft.current = draft;
    if (prev !== draft) setErrors((e) => clearChangedErrors(prev, draft, e));
  }, [draft]);
  // When a run ends, the progress view (and the Cancel button that may hold focus) unmounts and focus
  // falls to <body>, outside the dialog, where Escape and Tab no longer reach it. Put it back inside:
  // on the cancelled notice, the error, or the submit button. A field the error points at wins (the
  // focusFirstInvalid effect below runs after this one, in the same commit).
  const wasSubmitting = useRef(false);
  useEffect(() => {
    const ended = wasSubmitting.current && !submitting;
    wasSubmitting.current = submitting;
    if (!ended) return;
    const panel = bodyRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (!panel || panel.contains(document.activeElement)) return;
    const target = cancelledRef.current ?? errorRef.current ?? panel.querySelector<HTMLElement>('[data-testid="add-source-submit"]') ?? panel;
    target.focus({ preventScroll: true });
  }, [submitting]);

  // On a short window the progress (and its Cancel) sits below the fold: bring it into view as the run starts.
  useEffect(() => {
    if (!submitting) return;
    scrollFrame(() => progressRef.current?.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }));
  }, [submitting, scrollFrame]);

  const onFieldBlur = (path: string) => setErrors((e) => withFieldError(e, path, blurError(draft, path)));

  const setKind = (kind: SourceKind) => {
    setDraft((d) => ({ ...d, kind }));
    setErrors({});
    setSubmitError(null);
  };

  // After the render that marks the field and re-enables the form, not a frame later (L3-app-9).
  const focusFirstInvalid = useFocusInvalid(bodyRef, submitting);

  // The source a failed add left behind goes when the dialog closes (discardFailed). A reload or a
  // closed window ends the dialog without that, and the broken entry stayed in the list (L3-app-5).
  const failedId = failed?.id;
  useEffect(() => {
    if (!open || submitting || !failedId) return;
    return removeOnUnload(failedId);
  }, [open, submitting, failedId]);

  /** `afterFlush`: the second try once a pending removal of the duplicated source went through. */
  const submit = async (afterFlush = false) => {
    const run = runRef.current;
    const live = () => run === runRef.current;
    setSubmitError(null);
    setCancelled(false);
    cancelIdRef.current = null;
    const named = draft.name.trim() ? draft : { ...draft, name: suggested };
    const built = buildAddArgs(named, { isDesktop });
    setErrors(built.errors);
    if (!built.ok) {
      focusFirstInvalid();
      return;
    }
    setSubmitting(true);
    setStartedAt(Date.now());
    setIdsAtSubmit(knownIds);
    claimRef.current.knownAtSubmit ??= new Set(knownIds);
    try {
      const source = failed ? await retry(failed.id, named, built.value, live) : await rpc('sources.add', built.value);
      if (!source) {
        if (live()) focusFirstInvalid();
        return;
      }
      // Load the guide right away (playlist url-tvg, Xtream xmltv.php). It runs in the
      // background; the source card shows its progress.
      const guides = enabledEpgUrls(source.epg);
      if (guides.length > 0) void refreshGuides(guides);
      await Promise.all([invalidate('sources.'), invalidate('catalog.'), invalidate('epg.')]);
      // Every item the import counted, radio included, so the toast agrees with the progress bar.
      const total = source.channelCount + (source.radioCount ?? 0) + source.movieCount + source.seriesCount;
      toast({
        variant: 'success',
        title: t('addedTitle', { name: source.name }),
        description: t(guides.length > 0 ? 'addedDescriptionGuide' : 'addedDescription', { count: total }),
        action: { label: t('open'), onClick: () => navigate(`/s/${source.id}/live`) },
      });
      // Closed meanwhile ("Close, keep importing"): the toast is the whole answer.
      if (!live()) return;
      claimRef.current = { failedId: null, knownAtSubmit: null };
      onAdded?.(source);
      onClose();
    } catch (e) {
      const err = RpcError.from(e);
      if (!live()) {
        // The card shows how the background import ended; the shell toasts a failure no open dialog claims.
        void invalidate('sources.');
        return;
      }
      // The address is already a source: nothing was created, so there is no failed source to keep.
      const duplicate = duplicateSourceId(err);
      if (duplicate) {
        // It is the one the user just removed and can still undo: let the removal finish, then add again.
        if (!afterFlush && isRemovalPending(duplicate)) {
          await flushPendingRemovals();
          if (live()) await submit(true);
          return;
        }
        setSubmitError(err);
        return;
      }
      const createdId = failedSourceId(err);
      if (cancelIdRef.current !== null && wasCancelled(cancelIdRef.current, err)) {
        // The user stopped it. A source this submit created has no channels yet: take it away
        // again so Cancel leaves nothing behind. A retried source keeps its earlier state.
        const orphan = failed ? null : (createdId ?? cancelIdRef.current);
        if (orphan) {
          try {
            await rpc('sources.remove', { id: orphan });
          } catch {
            // Gone already, or the backend is unreachable: the list refetch below shows the truth.
          }
          claimRef.current = { failedId: null, knownAtSubmit: null };
        }
        cancelIdRef.current = null;
        setCancelled(true);
        void invalidate('sources.');
        return;
      }
      setSubmitError(err);
      // Point at the field to fix (the login for rejected credentials, the address for a dead server).
      const field = fieldForError(err, built.value.kind, built.value.m3u?.origin);
      if (field) {
        setErrors((prev) => ({ ...prev, [field]: summaryKey(err) }));
        focusFirstInvalid();
      }
      // The core keeps a source whose import failed (with lastError) and names it in the error.
      // Remember it so the next submit retries it rather than adding a duplicate. A transport
      // failure (proxy 504, network blip during a long import) names nothing although the core
      // may already have created the row: look for it among the sources that are new since submit.
      const id = createdId ?? (failed ? null : await adoptCreatedSource(built.value));
      if (!live()) return;
      if (id) claimRef.current.failedId = id;
      if (id) setFailed({ id, name: built.value.name });
      else setFailed((f) => (f ? { ...f, name: built.value.name } : f));
      void invalidate('sources.');
    } finally {
      if (live()) setSubmitting(false);
    }
  };

  /**
   * Closing the dialog after a failed add takes the source that add left behind with it, so a
   * broken entry never stays in the list (and in every Refresh all) unasked. The toast offers Undo.
   */
  const discardFailed = (f: { id: string; name: string }) => {
    scheduleRemoval({
      id: f.id,
      toast: { variant: 'info', title: t('removedTitle', { name: f.name }), description: t('discardedFailedHint') },
      undoLabel: t('undo'),
      remove: async (call) => {
        try {
          await rpcRaw('sources.remove', { id: f.id }, call);
        } catch (e) {
          if (RpcError.from(e).code !== 'not_found') throw e;
        }
      },
      onRemoved: () => {
        useImportProgressStore.getState().clear(f.id);
        void invalidate('sources.');
      },
      onFailed: (e) => {
        void invalidate('sources.');
        toast({
          variant: 'error',
          title: t('removeFailed', { name: f.name }),
          description: `${t(summaryKey(RpcError.from(e)))} ${t('removeFailedKept')}`,
        });
      },
      onUndone: () => void invalidate('sources.'),
    });
  };

  /** Cancel, Escape or the close button. "Close, keep importing" leaves a running import alone. */
  const dismiss = () => {
    if (!submitting && failed) discardFailed(failed);
    onClose();
  };

  // The source a refused add duplicates: the error offers to open or refresh it instead.
  const duplicateId = submitError ? duplicateSourceId(submitError) : null;
  const duplicateName = duplicateId && submitError ? (sources.data?.find((s) => s.id === duplicateId)?.name ?? duplicateSourceName(submitError)) : null;
  // Leaving the page closes the dialog. Not through onClose: the host clears its `?add` params with a
  // navigation of its own, which would cancel this one. Replace, so Back does not reopen the dialog.
  const openDuplicate = (id: string) => {
    if (failed) discardFailed(failed);
    navigate(`/s/${id}/live`, { replace: true });
  };
  const refreshDuplicate = (id: string) => {
    // The source card shows the refresh, and the shell toasts how it ends.
    beginImport(id);
    void rpc('sources.refresh', { id }).then(
      () => Promise.all([invalidate('sources.'), invalidate('catalog.')]),
      () => invalidate('sources.'),
    );
    dismiss();
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
  const retry = async (id: string, named: SourceDraft, args: SourcesAddArgs, live: () => boolean): Promise<Source | null> => {
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
        if (live()) setErrors(patch.errors);
        return null;
      }
      if (Object.keys(patch.value).length > 0) await rpc('sources.update', { id, patch: patch.value });
      // Drop the previous attempt's error entry and cancel request so the progress view starts fresh.
      beginImport(id);
      return rpc('sources.refresh', { id });
    }
    if (existing) await rpc('sources.remove', { id });
    if (live()) setFailed(null);
    return rpc('sources.add', args);
  };

  // Locked while an import runs: switching kind mid-import would show a form that is not the one importing.
  // The current tab stays enabled so it keeps its place in the tab order.
  // On a phone the three full names do not fit in one row: the tabs show the short name, and the
  // full one stays the tab's accessible name.
  const kinds: { id: SourceKind; label: ReactNode; disabled: boolean }[] = (
    [
      ['m3u', t('kindM3u'), t('kindM3uShort')],
      ['xtream', t('kindXtream'), t('kindXtreamShort')],
      ['stalker', t('kindStalker'), t('kindStalkerShort')],
    ] as const
  ).map(([id, label, short]) => ({
    id,
    label: (
      <>
        <span aria-hidden className="sm:hidden">
          {short}
        </span>
        <span className="max-sm:sr-only">{label}</span>
      </>
    ),
    disabled: submitting && id !== draft.kind,
  }));

  const isTextOrigin = draft.kind === 'm3u' && draft.m3u.origin !== 'url' && !(draft.m3u.origin === 'file' && isDesktop);

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title={t('addSource')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={dismiss}>
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
            onFieldBlur={onFieldBlur}
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
            onFieldBlur={onFieldBlur}
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
            onFieldBlur={onFieldBlur}
          />
        ) : null}

        <Toggle
          checked={draft.autoRefresh && !isTextOrigin}
          disabled={submitting || isTextOrigin}
          onChange={(autoRefresh) => setDraft((d) => ({ ...d, autoRefresh }))}
          label={t('autoRefresh')}
          description={isTextOrigin ? t('autoRefreshUnavailable') : t('autoRefreshHint')}
        />

        {submitting ? (
          <div ref={progressRef} className="scroll-my-4">
            <ImportProgressView
              entry={progress}
              kind={draft.kind}
              host={draftHost(draft)}
              startedAt={startedAt ?? undefined}
              onCancel={progress ? onCancelImport : undefined}
              cancelling={cancellingImport}
            />
          </div>
        ) : null}

        {cancelled && !submitting ? (
          <div ref={cancelledRef} tabIndex={-1} role="status" className="rounded-md border border-border bg-surface-2/60 p-3 outline-none" data-testid="add-source-cancelled">
            <ImportProgressView
              entry={{ sourceId: '', phase: 'cancelled', done: 0, at: 0 }}
              cancelledNote={t(failed ? 'cancelledRetryNote' : 'cancelledAddNote')}
            />
          </div>
        ) : null}

        {submitError ? (
          <div ref={errorRef} tabIndex={-1} role="alert" className="flex gap-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm outline-none" data-testid="add-source-error">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1">
              {duplicateId ? (
                // Nothing failed: the address is already a source. Name it, and offer it right here.
                <p className="font-medium text-fg" dir="auto">
                  {duplicateName ? t('duplicateTitle', { name: duplicateName }) : t('errorSummaryConflict')}
                </p>
              ) : (
                <>
                  <p className="font-medium text-fg">{t('addFailed')}</p>
                  <p className="text-fg">{t(summaryKey(submitError))}</p>
                  <p className="text-fg-muted">{t(nextStepKey(submitError, draft.kind))}</p>
                  {failed ? (
                    <p className="text-fg-muted" data-testid="add-source-retry-note">
                      {t('addRetryNote', { name: failed.name })}
                    </p>
                  ) : null}
                </>
              )}
              {/* The way out comes before the technical details, so it stays in view on a short window. */}
              {duplicateId ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => openDuplicate(duplicateId)} data-testid="add-source-open-existing">
                    {t('open')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => refreshDuplicate(duplicateId)} data-testid="add-source-refresh-existing">
                    {t('refresh')}
                  </Button>
                </div>
              ) : failed ? null : (
                /* With a failed source on file the footer button already reads "Try again". */
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void submit()} data-testid="add-source-retry">
                    {t('tryAgain')}
                  </Button>
                </div>
              )}
              <details className="mt-1 text-fg-muted">
                <summary className="w-fit cursor-pointer select-none rounded-sm text-xs hover:underline">{t('technicalDetails')}</summary>
                <p className="mt-1 break-words font-mono text-xs" dir="ltr">
                  {redactText(submitError.message)}
                </p>
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
