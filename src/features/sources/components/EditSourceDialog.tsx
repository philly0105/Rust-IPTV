import { CircleAlert, PlugZap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import type { ConnectionTestResult, SourcePatch } from '@/api/rpc';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { EpgLinks, Source } from '@/api/types';
import { parseGuideShift } from '@/lib/guideShift';

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
import { useAutoRefreshHint } from '../lib/useAutoRefreshHint';
import { useFocusInvalid } from '../lib/useFocusInvalid';
import { AccountPanel, hasAccountInfo } from './AccountPanel';
import { CatchupOverrideFields } from './CatchupOverrideFields';
import { PHONE_SHEET_BODY, useDiscardGuard } from './DiscardGuard';
import { EpgLinksEditor, shiftTextOf } from './EpgLinksEditor';
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
  const refreshHint = useAutoRefreshHint();
  const [tab, setTab] = useState<EditTab>(initialTab);
  const [draft, setDraft] = useState<SourceDraft | null>(null);
  const [epg, setEpg] = useState<EpgLinks | null>(null);
  const [errors, setErrors] = useState<DraftErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<RpcError | null>(null);
  // The edited sign-in details did not work, so nothing was saved (Save anyway skips the check).
  const [checkError, setCheckError] = useState<RpcError | null>(null);
  const [checking, setChecking] = useState(false);
  // The Guide tab's time shift as typed: it reaches `epg` only while it is a valid shift.
  const [shiftText, setShiftText] = useState('');
  // The Guide tab's "Add guide URL" text, typed but not added yet.
  const [pendingGuideUrl, setPendingGuideUrl] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  // Focus the field a failed save points at once the error has rendered and the fields are enabled again.
  const focusInvalid = useFocusInvalid(formRef, saving);

  const sourceId = source?.id;
  useEffect(() => {
    if (!source) return;
    setDraft(draftFromSource(source));
    setEpg(source.epg);
    setShiftText(shiftTextOf(source.epg));
    setPendingGuideUrl('');
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

  // Typed changes (SS-1): anything a save would send, an invalid entry included, a shift that
  // is not a number yet, or a guide URL typed but not added. Escape, the close button and Cancel
  // ask before dropping them, and a click on the backdrop does nothing.
  const built = source && draft ? buildUpdatePatch(source, draft, { isDesktop }) : null;
  const dirty =
    !!source &&
    !!epg &&
    !!built &&
    (!built.ok || Object.keys(built.value).length > 0 || epgPatch(source.epg, epg) !== undefined || parseGuideShift(shiftText) === null || pendingGuideUrl.trim() !== '');
  const guard = useDiscardGuard({ open: !!source, dirty: dirty && !saving, onClose });

  if (!source || !draft || !epg) return null;

  const onFieldBlur = (path: string) => setErrors((e) => withFieldError(e, path, blurError(draft, path, source.stalker?.macAddress)));

  const save = async ({ skipCheck = false }: { skipCheck?: boolean } = {}) => {
    setSaveError(null);
    setCheckError(null);
    // The shift field shows its error; saving now would drop what the user typed and report
    // "Saved" (SS-16). Take them to it instead, as the Details tab does for its errors.
    if (parseGuideShift(shiftText) === null) {
      flushSync(() => setTab('epg'));
      formRef.current?.querySelector<HTMLElement>('[data-testid="epg-shift-minutes"]')?.focus();
      return;
    }
    const built = buildUpdatePatch(source, draft, { isDesktop });
    setErrors(built.errors);
    if (!built.ok) {
      setTab('details');
      focusInvalid();
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
          focusInvalid();
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
      // New playlist text, and new connection details (a fixed password, a new address), load
      // at once (SS-5): the card shows the refresh with its Cancel, and clears its failure strip
      // when it works. Before, the old channels and error stayed until the user found "Refresh now".
      const reimport = patchNeedsRefresh(patch, source);
      toast({
        variant: 'success',
        title: t('savedTitle', { name: updated.name }),
        description: reimport && patch.text === undefined ? t('savedRefreshing') : undefined,
      });
      onClose();
      if (reimport) onRefresh(updated);
    } catch (e) {
      const err = RpcError.from(e);
      setSaveError(err);
      const field = fieldForError(err, source.kind, source.m3u?.origin);
      if (field) {
        setErrors((prev) => ({ ...prev, [field]: summaryKey(err) }));
        setTab('details');
        focusInvalid();
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
    <>
      <Dialog
        open
        onClose={guard.request}
        dismissible={!dirty}
        title={t('editSourceTitle', { name: source.name })}
        size="lg"
        sheet
        bodyClassName={PHONE_SHEET_BODY}
        testId="edit-source-dialog"
        footer={
          <>
            <Button variant="ghost" onClick={guard.request}>
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
          <Tabs items={tabs} value={tab} label={t('editTabsLabel')} onChange={(id) => setTab(id as EditTab)} />
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
                // Pasted playlists take new text or a file instead of an address; the headers stay editable.
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
                description={source.m3u?.origin === 'text' ? t('autoRefreshUnavailable') : refreshHint}
              />
            </>
          ) : tab === 'epg' ? (
            <EpgLinksEditor
              value={epg}
              onChange={setEpg}
              disabled={saving}
              shiftText={shiftText}
              onShiftTextChange={setShiftText}
              pendingUrl={pendingGuideUrl}
              onPendingUrlChange={setPendingGuideUrl}
            />
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
      {guard.prompt}
    </>
  );
}
