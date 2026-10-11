import { CircleAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { invalidate, useRpcQuery } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { Source, SourceKind } from '@/api/types';

import { Button, Dialog, Input, Tabs, Toggle, useToast } from '../_shim';
import { buildAddArgs, emptyDraft, type DraftErrors, type SourceDraft } from '../lib/draft';
import { enabledEpgUrls, refreshGuides, useGuideProgressFeed } from '../lib/epgRefresh';
import { nextStepKey } from '../lib/errors';
import { useImportProgressFeed, useNewSourceProgress } from '../lib/progress';
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
  const [submitting, setSubmitting] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<RpcError | null>(null);
  const bodyRef = useRef<HTMLFormElement>(null);
  const nextFrame = useNextFrame();

  // Reset whenever the dialog opens with a (possibly new) initial request.
  const initialKey = JSON.stringify(initial ?? null);
  useEffect(() => {
    if (!open) return;
    setDraft(initialDraft(initial));
    setErrors({});
    setNameTouched(Boolean(initial?.name) || Boolean(initial?.url));
    setSubmitError(null);
    setStartedAt(null);
  }, [open, initialKey]);

  const sources = useRpcQuery('sources.list', undefined, { enabled: open });
  const knownIds = useMemo(() => (sources.data ?? []).map((s) => s.id), [sources.data]);
  const progress = useNewSourceProgress(knownIds, startedAt);

  const suggest = (input: string) => {
    if (nameTouched) return;
    const name = suggestName(input);
    if (name) setDraft((d) => ({ ...d, name }));
  };

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
    const built = buildAddArgs(draft, { isDesktop });
    setErrors(built.errors);
    if (!built.ok) {
      focusFirstInvalid();
      return;
    }
    setSubmitting(true);
    setStartedAt(Date.now());
    try {
      const source = await rpc('sources.add', built.value);
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
      onAdded?.(source);
      onClose();
    } catch (e) {
      const err = RpcError.from(e);
      setSubmitError(err);
      // The core keeps a source whose import failed (with lastError); show it in the list.
      void invalidate('sources.');
    } finally {
      setSubmitting(false);
    }
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
            {submitting ? t('adding') : t('addSourceSubmit')}
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
              placeholder={t('sourceNamePlaceholder')}
              value={draft.name}
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
              setDraft((d) => ({ ...d, kind: 'xtream', xtream, name: nameTouched ? d.name : suggestName(xtream.serverUrl) }));
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
              <p className="break-words text-fg-muted">{redactText(submitError.message)}</p>
              <p className="text-fg-muted">{t(nextStepKey(submitError))}</p>
            </div>
          </div>
        ) : null}

        {/* Enter in any field submits. */}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
