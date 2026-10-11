import { CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import type { EpgLinks, Source } from '@/api/types';

import { Button, Dialog, Input, Tabs, Toggle, useToast } from '@/ui';
import { buildUpdatePatch, draftFromSource, patchNeedsRefresh, type DraftErrors, type SourceDraft } from '../lib/draft';
import { epgPatch } from '../lib/epgLinks';
import { newlyEnabledEpgUrls, refreshGuides } from '../lib/epgRefresh';
import { nextStepKey } from '../lib/errors';
import { redactText } from '../lib/redact';
import { useNextFrame } from '../lib/useNextFrame';
import { AccountPanel, hasAccountInfo } from './AccountPanel';
import { EpgLinksEditor } from './EpgLinksEditor';
import { Field } from './Field';
import { M3uForm } from './M3uForm';
import { StalkerForm } from './StalkerForm';
import { XtreamForm } from './XtreamForm';

export type EditTab = 'details' | 'epg' | 'account';

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
  const formRef = useRef<HTMLFormElement>(null);
  const nextFrame = useNextFrame();

  const sourceId = source?.id;
  useEffect(() => {
    if (!source) return;
    setDraft(draftFromSource(source));
    setEpg(source.epg);
    setErrors({});
    setSaveError(null);
    setTab(initialTab === 'account' && !hasAccountInfo(source) ? 'details' : initialTab);
    // Only re-seed when a different source opens, not on background refetches.
  }, [sourceId, initialTab]);

  if (!source || !draft || !epg) return null;

  const save = async () => {
    setSaveError(null);
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
    try {
      const updated = await rpc('sources.update', { id: source.id, patch });
      // A new or re-enabled guide URL loads at once; the source card shows its progress.
      const guides = ep ? newlyEnabledEpgUrls(source.epg, updated.epg) : [];
      if (guides.length > 0) void refreshGuides(guides);
      await Promise.all([invalidate('sources.'), ep ? invalidate('epg.') : Promise.resolve()]);
      toast({
        variant: 'success',
        title: t('savedTitle', { name: updated.name }),
        description: patchNeedsRefresh(patch) ? t('savedNeedsRefresh') : undefined,
        action: patchNeedsRefresh(patch) ? { label: t('refreshNow'), onClick: () => onRefresh(updated) } : undefined,
      });
      onClose();
    } catch (e) {
      setSaveError(RpcError.from(e));
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
            {t('saveChanges')}
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
              />
            ) : null}
            {source.kind === 'xtream' ? (
              <XtreamForm value={draft.xtream} onChange={(xtream) => setDraft({ ...draft, xtream })} errors={errors} onErrors={setErrors} disabled={saving} />
            ) : null}
            {source.kind === 'stalker' ? (
              <StalkerForm
                value={draft.stalker}
                onChange={(stalker) => setDraft({ ...draft, stalker })}
                errors={errors}
                onErrors={setErrors}
                disabled={saving}
                storedMac={source.stalker?.macAddress}
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

        {saveError ? (
          <div role="alert" className="flex gap-3 rounded-md border border-danger/50 bg-danger/10 p-3 text-sm">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-medium text-fg">{t('saveFailed')}</p>
              <p className="break-words text-fg-muted">{redactText(saveError.message)}</p>
              <p className="text-fg-muted">{t(nextStepKey(saveError))}</p>
            </div>
          </div>
        ) : null}
        <button type="submit" hidden tabIndex={-1} aria-hidden />
      </form>
    </Dialog>
  );
}
