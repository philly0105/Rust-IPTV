import { RotateCcw } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { RpcError } from '@/api/transport';
import type { Channel } from '@/api/types';
import { trimName } from '@/lib/names';
import { Button, Dialog, Input, Skeleton, cn } from '@/ui';

import { failureText, renameChannel, renamedToast } from './actions';
import { findEdit, useDisplayName, useSourceEdits } from './edits';
import { NAME_MAX, nameLength, planRename, type RenamePlan } from './name';

export interface RenameDialogProps {
  channel: Channel;
  onClose: () => void;
}

/**
 * Renames one channel or station (C2). The field starts with the name shown
 * now; the provider's name stays in view underneath with a one-click way back
 * to it. Clearing the field also goes back. Save checks the core's rules
 * first (1 to 120 characters after trimming, something visible, no control
 * characters or line breaks) and sends nothing when the name did not change;
 * a refusal stays in the dialog, next to the field.
 */
export function RenameDialog({ channel, onClose }: RenameDialogProps) {
  const { t } = useTranslation('channels');
  const display = useDisplayName();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const edits = useSourceEdits(channel.ref.sourceId);
  const edit = findEdit(edits.data, channel.ref);
  // Until the edits answer it is unknown whether `channel.name` is the provider's name or a custom one.
  const known = edits.isSuccess || edits.isError;
  const renamed = edit?.name !== undefined;
  const provider = edit?.name !== undefined ? edit.originalName : channel.name;

  const [value, setValue] = useState(channel.name);
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // The whole name selected, ready to be typed over.
  useEffect(() => inputRef.current?.select(), []);

  const plan: RenamePlan = useMemo(
    () => planRename(value, { current: channel.name, provider, renamed }),
    [value, channel.name, provider, renamed],
  );
  const length = nameLength(trimName(value));
  const over = length > NAME_MAX;
  const invalidText =
    plan.kind !== 'invalid'
      ? null
      : plan.reason === 'tooLong'
        ? t('nameTooLong', { max: NAME_MAX })
        : plan.reason === 'control'
          ? t('nameControl')
          : t('nameEmpty');
  // "Too long" shows as soon as it happens; "empty" and "control" only once Save was tried, not while retyping.
  const fieldError = failure ?? (over || touched ? invalidText : null);
  const radio = channel.ref.contentType === 'radio';

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (saving) return;
    setTouched(true);
    setFailure(null);
    if (plan.kind === 'invalid') {
      inputRef.current?.focus();
      return;
    }
    if (plan.kind === 'unchanged') {
      onClose();
      return;
    }
    setSaving(true);
    try {
      const next = plan.kind === 'reset' ? null : plan.name;
      await renameChannel(channel.ref, next, provider);
      renamedToast(channel.ref, display(next ?? provider), edit?.name ?? null, next === null, t, provider);
      onClose();
    } catch (err) {
      const e = RpcError.from(err);
      setFailure(e.code === 'invalid' ? e.message : t('renameFailedReason', { message: failureText(err, t) }));
      setSaving(false);
      inputRef.current?.focus();
    }
  };

  const fillProvider = () => {
    setValue(provider);
    setFailure(null);
    inputRef.current?.focus();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={radio ? t('renameStationTitle') : t('renameTitle')}
      size="sm"
      initialFocus={inputRef}
      testId="channel-rename-dialog"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            loading={saving}
            disabled={!known}
            data-testid="channel-rename-save"
          >
            {t('save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={(e) => void save(e)} className="flex flex-col gap-1.5" noValidate>
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor={`${formId}-name`} className="text-sm font-medium text-fg">
            {t('nameLabel')}
          </label>
          <span
            aria-hidden
            className={cn('text-xs tabular-nums', over ? 'font-medium text-danger' : 'text-fg-subtle')}
            data-testid="channel-rename-count"
          >
            {length}/{NAME_MAX}
          </span>
        </div>
        <Input
          ref={inputRef}
          id={`${formId}-name`}
          value={value}
          dir="auto"
          autoComplete="off"
          spellCheck={false}
          onValueChange={(v) => {
            setValue(v);
            setFailure(null);
          }}
          error={fieldError ?? undefined}
          hint={t('renameHint')}
          data-testid="channel-rename-input"
        />
        <div className="mt-2 min-h-9 rounded-md border border-divider bg-surface-2 px-3 py-2 text-sm" data-testid="channel-rename-provider">
          {!known ? (
            <Skeleton className="h-4 w-3/5" />
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="min-w-0 flex-1 text-fg-muted">
                {t('providerNameLabel')}{' '}
                <bdi className="font-medium break-words text-fg">{provider}</bdi>
              </p>
              {value.trim() !== provider ? (
                <Button size="sm" variant="ghost" icon={<RotateCcw aria-hidden size={14} />} onClick={fillProvider} className="-me-2">
                  {t('useProviderName')}
                </Button>
              ) : null}
            </div>
          )}
        </div>
      </form>
    </Dialog>
  );
}
