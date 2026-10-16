import { CircleAlert, PlugZap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import type { ConnectionTestResult, SourcePatch } from '@/api/rpc';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { EpgLinks, Source } from '@/api/types';

import { Button, Dialog, Input, Tabs, Toggle, useToast } from '@/ui';
import {
  blurError,
  buildUpdatePatch,
  clearChangedErrors,
  draftFromSource,
  patchNeedsRefresh,
  withFieldError,
  type DraftErrors,
  type SourceDraft,
} from '../lib/draft';
import { epgPatch } from '../lib/epgLinks';
import { newlyEnabledEpgUrls, refreshGuides } from '../lib/epgRefresh';
import { fieldForError, importErrorCode, nextStepKey, summaryKey } from '../lib/errors';
import { redactText } from '../lib/redact';
import { useNextFrame } from '../lib/useNextFrame';
import { AccountPanel, hasAccountInfo } from './AccountPanel';
import { CatchupOverrideFields } from './CatchupOverrideFields';
import { EpgLinksEditor } from './EpgLinksEditor';
import { Field } from './Field';
import { M3uForm } from './M3uForm';
import { StalkerForm } from './StalkerForm';
import { XtreamForm } from './XtreamForm';

export type EditTab = 'details' | 'epg' | 'account';

/**
 * Signs in with the edited connection details, as the Add dialog's import does, before they are
 * saved. Null when the patch leaves the connection alone (or it is an M3U address, which has no
 * sign-in to test), or when the details work; otherwise the reason they do not.
 */
export async function checkConnection(patch: SourcePatch): Promise<RpcError | null> {
  let run: Promise<ConnectionTestResult>;
  if (patch.xtream) run = rpc('xtream.test', { config: patch.xtream });
  else if (patch.stalker) run = rpc('stalker.test', { config: patch.stalker });
  else return null;
  try {
    const r = await run;
    // Signed in, even to an account the provider marks inactive: the Add dialog imports those too.
    if (r.ok) return null;
    return new RpcError(importErrorCode(r.message), r.message ?? '');
  } catch (e) {
    return RpcError.from(e);
  }
}

export function EditSourceDialog({
  source,
  onClose,
  onRefresh,
  initialTab = 'details',
}: {
  source: Source | null;
  onClose: () => void;
  onRefresh: (source: Source) => void;
  initialTab?: EditTab;
}) {
  const { t } = useTranslation('sources');
  const { toast } = useToast();
  const [tab, setTab] = useState<EditTab>(initialTab);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [epg, setEpg] = useState<EpgLinks | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<RpcError | null>(null);
  // The edited sign-in details did not work, so nothing was saved (Save anyway skips the check).
  const [checkError, setCheckError] = useState<RpcError | null>(null);
  const [checking, setChecking] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const nextFrame = useNextFrame();

  const sourceId = source?.id;
  useEffect(() => {
    if (!source) return;
    setDraft(draftFromSource(source));
    setEpg(source.epg);
    setErrors({});
    setSaveError(null);
    setCheckError(null);
    setTab(initialTab === 'account' && !hasAccountInfo(source) ? 'details' : initialTab);
    // Only re-seed when a different source opens, not on background refetches.
  }, [sourceId, initialTab]);

  // An inline error goes away as soon as the user edits its field.
  const prevDraft = useRef(draft);
  useEffect(() => {
    const prev = prevDraft.current;
    prevDraft.current = draft;
    if (prev && draft && prev !== draft) {
      setErrors((e) => clearChangedErrors(prev, draft, e));
      // A verdict on other details no longer applies.
      setCheckError(null);
    }
  }, [draft]);

  if (!source || !draft || !epg) return null;

  const onFieldBlur = (path: string) => setErrors((e) => withFieldError(e, path, blurError(draft, path, source.stalker?.macAddress)));

  const save = async ({ skipCheck = false }: { skipCheck?: boolean } = {}) => {
    setSaveError(null);
    setCheckError(null);
    const built = buildUpdatePatch(source, draft, { isDesktop });
    setErrors(built.errors);
    if (!built.ok) {
      setTab('details');
      nextFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    const patch = { ...built.value };
    const ep = epgPatch(source.epg, epg);
    if (ep) patch.epg = ep;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    if (!skipCheck && (patch.xtream || patch.stalker)) {
      setChecking(true);
      const failure = await checkConnection(patch);
      setChecking(false);
      if (failure) {
        setSaving(false);
        setCheckError(failure);
        const field = fieldForError(failure, source.kind, source.m3u?.origin);
        if (field) {
          setErrors((prev) => ({ ...prev, [field]: summaryKey(failure) }));
          setTab('details');
          nextFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
        }
        return;
      }
    }
    try {
      const updated = await rpc('sources.update', { id: source.id, patch });
      // A new or re-enabled guide URL loads at once; the source card shows its progress.
      const guides = ep ? newlyEnabledEpgUrls(source.epg, updated.epg) : [];
      if (guides.length > 0) void refreshGuides(guides);
      await Promise.all([invalidate('sources.'), ep ? invalidate('epg.') : Promise.resolve()]);
      toast({
        variant: 'success',
        title: t('savedTitle', { name: updated.name }),
        description: patchNeedsRefresh(patch, source) ? t('savedNeedsRefresh') : undefined,
        action: patchNeedsRefresh(patch, source) ? { label: t('refreshNow'), onClick: () => onRefresh(updated) } : undefined,
      });
      onClose();
    } catch (e) {
      const err = RpcError.from(e);
      setSaveError(err);
      const field = fieldForError(err, source.kind, source.m3u?.origin);
      if (field) {
        setErrors((prev) => ({ ...prev, [field]: summaryKey(err) }));
        setTab('details');
        nextFrame(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      }
    } finally {
      setSaving(false);
    }
  };

  const tabs: { id: EditTab; label: string }[] = [
    { id: 'details', label: t('tabDetails') },
    { id: 'epg', label: t('tabEpg') },
  ];
  if (hasAccountInfo(source)) tabs.push({ id: 'account', label: t('tabAccount') });

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('editSourceTitle', { name: source.name })}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()} data-testid="edit-source-save">
            {checking ? t('testing') : t('saveChanges')}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        noValidate
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Tabs items={tabs} value={tab} onChange={(id) => setTab(id as EditTab)} />
        {tab === 'details' ? (
          <>
            <Field label={t('sourceName')} error={errors.name ? t(errors.name) : null}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  maxLength={120}
                  disabled={saving}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              )}
            </Field>
            {source.kind === 'm3u' ? (
              // Pasted playlists hide the content inputs inside the form but keep the headers editable.
              <M3uForm
                mode="edit"
                value={draft.m3u}
                onChange={(m3u) => setDraft({ ...draft, m3u })}
                errors={errors}
                isDesktop={isDesktop}
                disabled={saving}
                onFieldBlur={onFieldBlur}
              />
            ) : null}
            {/* guide: per-source catch-up override for M3U channels. */}
            {source.kind === 'm3u' ? (
              <CatchupOverrideFields
                value={draft.m3u.catchup}
                onChange={(catchup) => setDraft({ ...draft, m3u: { ...draft.m3u, catchup } })}
                errors={errors}
                disabled={saving}
              />
            ) : null}
            {source.kind === 'xtream' ? (
              <XtreamForm
                value={draft.xtream}
                onChange={(xtream) => setDraft({ ...draft, xtream })}
                errors={errors}
                onErrors={setErrors}
                disabled={saving}
                onFieldBlur={onFieldBlur}
              />
            ) : null}
            {source.kind === 'stalker' ? (
              <StalkerForm
                value={draft.stalker}
                onChange={(stalker) => setDraft({ ...draft, stalker })}
                errors={errors}
                onErrors={setErrors}
                disabled={saving}
                storedMac={source.stalker?.macAddress}
                onFieldBlur={onFieldBlur}
              />
            ) : null}
            <Toggle
              checked={draft.autoRefresh}
              disabled={saving || source.m3u?.origin === 'text'}
              onChange={(autoRefresh) => setDraft({ ...draft, autoRefresh })}
              label={t('autoRefresh')}
              description={source.m3u?.origin === 'text' ? t('autoRefreshUnavailable') : t('autoRefreshHint')}
            />
          </>
        ) : tab === 'epg' ? (
          <EpgLinksEditor value={epg} onChange={setEpg} disabled={saving} />
        ) : (
          <AccountPanel source={source} />
        )}

        {checkError ? (
          <div role="alert" className="flex gap-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm" data-testid="edit-source-check-failed">
            <PlugZap aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-fg">{t('checkFailedTitle')}</p>
              <p className="text-fg">
                {/* An unclassified refusal: the portal's own words say more than a generic summary. */}
                {checkError.code !== 'internal' ? t(summaryKey(checkError)) : checkError.message ? redactText(checkError.message) : t('testFailedGeneric')}
              </p>
              <p className="text-fg-muted">{t(nextStepKey(checkError, source.kind))}</p>
              <p className="text-fg-muted">{t('checkFailedNote')}</p>
              {checkError.message && checkError.code !== 'internal' ? (
                <details className="text-fg-muted">
                  <summary className="w-fit cursor-pointer select-none rounded-sm text-xs hover:underline">{t('technicalDetails')}</summary>
                  <p className="mt-1 break-words font-mono text-xs" dir="ltr">
                    {redactText(checkError.message)}
                  </p>
                </details>
              ) : null}
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={saving} onClick={() => void save()} data-testid="edit-source-check-again">
                  {t('tryAgain')}
                </Button>
                <Button size="sm" variant="ghost" disabled={saving} onClick={() => void save({ skipCheck: true })} data-testid="edit-source-save-anyway">
                  {t('saveAnyway')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {saveError ? (
          <div role="alert" className="flex gap-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm" data-testid="edit-source-error">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-fg">{t('saveFailed')}</p>
              {/* "Something went wrong while importing" does not describe a save; the core's text does. */}
              {saveError.code === 'internal' ? (
                <p className="break-words text-fg-muted">{redactText(saveError.message)}</p>
              ) : (
                <>
                  <p className="text-fg">{t(summaryKey(saveError))}</p>
                  <details className="text-fg-muted">
                    <summary className="w-fit cursor-pointer select-none rounded-sm text-xs hover:underline">{t('technicalDetails')}</summary>
                    <p className="mt-1 break-words font-mono text-xs" dir="ltr">
                      {redactText(saveError.message)}
                    </p>
                  </details>
                </>
              )}
              <p className="text-fg-muted">{t(nextStepKey(saveError, source.kind))}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" loading={saving} onClick={() => void save({ skipCheck: true })} data-testid="edit-source-retry">
                  {t('tryAgain')}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
