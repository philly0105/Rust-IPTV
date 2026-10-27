import { CircleAlert, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import type { SourcesAddArgs } from '@/api/rpc';
import { RpcError, isDesktop, rpc, rpcRaw } from '@/api/transport';
import type { Source, SourceKind } from '@/api/types';

import { sourceHomePath } from '@/shell/railLinks';
import { Button, Dialog, Input, Tabs, Toggle, useToast } from '@/ui';
import {
  blurError,
  buildAddArgs,
  buildUpdatePatch,
  clearChangedErrors,
  emptyDraft,
  withFieldError,
  type DraftErrors,
  type HeadersDraft,
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
import { useAutoRefreshHint } from '../lib/useAutoRefreshHint';
import { useNextFrame } from '../lib/useNextFrame';
import { checkHttpUrl, displayHost, parseXtreamLink, suggestName } from '../lib/validate';
import { sameDraft, useDiscardGuard } from './DiscardGuard';
import { Field } from './Field';
import { HeadersFields } from './HeadersFields';
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

/**
 * Draft for an initial request (deep link / onboarding tile). With no kind, an address opens as
 * the playlist it most likely is, and a bare Add opens on Xtream, the most common kind (the one
 * the empty Sources page puts first).
 */
export function initialDraft(initial: AddSourceInitial | undefined): SourceDraft {
  const url = initial?.url?.trim() ?? '';
  const xt = url ? parseXtreamLink(url) : null;
  if (xt && (initial?.kind === undefined || initial.kind === 'xtream')) {
    const d = emptyDraft('xtream');
    d.xtream = { ...d.xtream, ...xt };
    d.name = initial?.name ?? suggestName(xt.serverUrl);
    return d;
  }
  const kind = initial?.kind ?? (url ? 'm3u' : 'xtream');
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

/**
 * The name an add uses when the optional Name field is left empty: the one the current address or
 * file suggests, or `pasted` for a pasted playlist, which has neither.
 */
export function defaultName(d: SourceDraft, pasted: string): string {
  if (d.kind === 'xtream') return suggestName(d.xtream.serverUrl);
  if (d.kind === 'stalker') return suggestName(d.stalker.portalUrl);
  if (d.m3u.origin === 'url') return suggestName(d.m3u.url);
  if (d.m3u.origin === 'file') return suggestName(d.m3u.filePath || d.m3u.fileName);
  return pasted;
}

/** The kind's name, for the import heading while the source has no name yet. */
const KIND_NAME: Record<SourceKind, string> = { m3u: 'kindM3u', xtream: 'kindXtream', stalker: 'kindStalker' };

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
  /** `first`: the list was empty when the add started (SS-6: the host opens the new source). */
  onAdded?: (source: Source, first: boolean) => void;
}) {
  const { t } = useTranslation('sources');
  const navigate = useNavigate();
  const { toast } = useToast();
  useImportProgressFeed();
  useGuideProgressFeed();
  const refreshHint = useAutoRefreshHint();

  const [draft, setDraft] = useState<SourceDraft>(() => initialDraft(initial));
  const [errors, setErrors] = useState<DraftErrors>({});
  const [nameTouched, setNameTouched] = useState(Boolean(initial?.name));
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

  // A kind picked with the pointer moves focus to its address field, the one the user came to
  // fill (SS-2). Arrow keys keep focus on the tabs, so the kinds stay one keypress apart.
  const pointerPick = useRef(false);
  const focusFrame = useNextFrame();
  const setKind = (kind: SourceKind) => {
    setDraft((d) => ({ ...d, kind }));
    setErrors({});
    setSubmitError(null);
    if (pointerPick.current) {
      pointerPick.current = false;
      focusFrame(() => bodyRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus());
    }
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
    const named = draft.name.trim() ? draft : { ...draft, name: defaultName(draft, t('originPasted')) };
    const built = buildAddArgs(named, { isDesktop });
    // An empty Name is optional: it takes the address's name. With no address yet there is none to
    // take, and the address's own error already says what is missing, so Name is not marked too.
    const { name: nameError, ...otherErrors } = built.errors;
    const nameFromAddress = !draft.name.trim() && nameError === 'errorRequired' && Object.keys(otherErrors).length > 0;
    setErrors(nameFromAddress ? otherErrors : built.errors);
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
        // A source without live channels (VOD only) opens on its movies or series.
        action: { label: t('open'), onClick: () => navigate(sourceHomePath(source)) },
      });
      // Closed meanwhile ("Close, keep importing"): the toast is the whole answer.
      if (!live()) return;
      const first = (claimRef.current.knownAtSubmit?.size ?? knownIds.length) === 0;
      claimRef.current = { failedId: null, knownAtSubmit: null };
      onAdded?.(source, first);
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

  // Typed details (SS-1): anything that differs from the form the dialog opened with. Switching
  // the kind alone changes nothing the user typed. A running import is never lost by closing
  // ("Close, keep importing"), so it needs no prompt.
  const baseline = useMemo(() => initialDraft(initial), [initialKey]);
  const dirty =
    !submitting &&
    !(
      draft.name === baseline.name &&
      draft.autoRefresh === baseline.autoRefresh &&
      sameDraft(draft.m3u, baseline.m3u) &&
      sameDraft(draft.xtream, baseline.xtream) &&
      sameDraft(draft.stalker, baseline.stalker)
    );
  const guard = useDiscardGuard({ open, dirty, onClose: dismiss });

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
  // full one stays the tab's accessible name. Xtream first, as on the empty Sources page.
  const kinds: { id: SourceKind; label: ReactNode; disabled: boolean }[] = (
    [
      ['xtream', t('kindXtream'), t('kindXtreamShort')],
      ['m3u', t('kindM3u'), t('kindM3uShort')],
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

  // The name comes after the address: it is optional, and the app suggests one from the address.
  const nameField = (
    <Field label={t('sourceName')} optional optionalLabel={t('optional')} error={errors.name ? t(errors.name) : null}>
      {(p) => (
        <Input
          {...p}
          autoComplete="off"
          disabled={submitting}
          maxLength={120}
          // The name a submit uses when this is left empty, as a placeholder so it never lands in the middle of
          // what the user is typing.
          placeholder={defaultName(draft, t('originPasted')) || t('sourceNamePlaceholder')}
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
  );

  const isTextOrigin = draft.kind === 'm3u' && draft.m3u.origin !== 'url' && !(draft.m3u.origin === 'file' && isDesktop);
  // The request headers are an advanced option: last in the form, after the name and auto refresh.
  const setHeaders = (headers: HeadersDraft) =>
    setDraft((d) =>
      d.kind === 'm3u' ? { ...d, m3u: { ...d.m3u, headers } } : d.kind === 'xtream' ? { ...d, xtream: { ...d.xtream, headers } } : { ...d, stalker: { ...d.stalker, headers } },
    );

  return (
    <>
      <Dialog
        open={open}
        onClose={guard.request}
        // A click on the backdrop never throws typed details away (SS-1); Escape and Cancel ask first.
        dismissible={!dirty}
        title={t('addSource')}
        description={t('addSourceLead')}
        size="lg"
        // As tall as the window allows on a phone, whatever the kind: a sheet as tall as its form
        // moved the kind and origin choices under the finger at every switch.
        className="max-sm:h-[calc(100dvh-1.5rem)]"
        testId="add-source-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={guard.request}>
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
          <div
            onPointerDown={() => {
              pointerPick.current = true;
            }}
            onKeyDown={() => {
              pointerPick.current = false;
            }}
          >
            <Tabs items={kinds} value={draft.kind} label={t('sourceType')} onChange={(id) => setKind(id as SourceKind)} />
          </div>

          {draft.kind === 'm3u' ? (
            <M3uForm
              mode="add"
              autoFocusAddress
              value={draft.m3u}
              onChange={(m3u) => setDraft((d) => ({ ...d, m3u }))}
              errors={errors}
              isDesktop={isDesktop}
              disabled={submitting}
              onFieldBlur={onFieldBlur}
              showHeaders={false}
              onUseXtream={(xtream) => {
                setDraft((d) => ({ ...d, kind: 'xtream', xtream: { ...d.xtream, ...xtream } }));
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
              autoFocusAddress
              onFieldBlur={onFieldBlur}
              showHeaders={false}
            />
          ) : null}
          {draft.kind === 'stalker' ? (
            <StalkerForm
              value={draft.stalker}
              onChange={(stalker) => setDraft((d) => ({ ...d, stalker }))}
              errors={errors}
              onErrors={setErrors}
              disabled={submitting}
              autoFocusAddress
              onFieldBlur={onFieldBlur}
              showHeaders={false}
            />
          ) : null}

          {nameField}

          <Toggle
            checked={draft.autoRefresh && !isTextOrigin}
            disabled={submitting || isTextOrigin}
            onChange={(autoRefresh) => setDraft((d) => ({ ...d, autoRefresh }))}
            label={t('autoRefresh')}
            description={isTextOrigin ? t('autoRefreshUnavailable') : refreshHint}
          />

          <HeadersFields value={draft[draft.kind].headers} onChange={setHeaders} errors={errors} prefix={`${draft.kind}.headers`} disabled={submitting} />

          {submitting ? (
            <div ref={progressRef} className="flex scroll-my-4 flex-col gap-3 rounded-lg border border-edge bg-surface-2 p-4" data-testid="add-source-progress">
              <p className="flex items-center gap-2 text-body-sm font-medium text-fg">
                <LoaderCircle aria-hidden size={16} className="shrink-0 text-accent motion-safe:animate-spin" />
                <span className="min-w-0 truncate" dir="auto">
                  {t('importingTitle', { name: draft.name.trim() || defaultName(draft, t('originPasted')) || t(KIND_NAME[draft.kind]) })}
                </span>
              </p>
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
            <div ref={cancelledRef} tabIndex={-1} role="status" className="rounded-md border border-edge bg-surface-2/60 p-3 outline-none" data-testid="add-source-cancelled">
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
      {guard.prompt}
    </>
  );
}
