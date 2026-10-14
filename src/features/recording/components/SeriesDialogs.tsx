/**
 * Confirm dialogs for series recording rules (Run 2 C5): "Record series"
 * from a guide programme, and removing a rule (optionally cancelling the
 * recordings it already scheduled). Shared by the guide popover, the ribbon,
 * the guide search panel and the Scheduled page's rules panel.
 */

import { Repeat } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ItemRef, RecordingRule } from '@/api/types';
import { Button, Dialog } from '@/ui';

import { useRuleActions } from '../hooks';

export interface SeriesTarget {
  ref: ItemRef;
  /** The name the guide shows for the channel. */
  channelName: string;
  title: string;
}

export function RecordSeriesDialog({ target, onClose }: { target: SeriesTarget | null; onClose: () => void }) {
  const { t } = useTranslation('guide');
  const { t: tc } = useTranslation('common');
  const { addRule } = useRuleActions();
  const [busy, setBusy] = useState(false);
  useEffect(() => setBusy(false), [target]);

  const confirm = async () => {
    if (!target || busy) return;
    setBusy(true);
    const ok = await addRule({ ref: target.ref, channelName: target.channelName, title: target.title });
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      size="sm"
      title={t('seriesConfirmTitle')}
      testId="series-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button variant="primary" icon={<Repeat className="size-4" aria-hidden />} loading={busy} onClick={() => void confirm()} data-autofocus="" data-testid="series-confirm-ok">
            {t('recordSeries')}
          </Button>
        </>
      }
    >
      {target ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-md border border-divider bg-surface-2 px-3 py-2.5">
            <Repeat className="mt-0.5 size-4 shrink-0 text-live" aria-hidden />
            <div className="min-w-0">
              <p dir="auto" className="text-sm font-semibold text-fg text-match-parent [overflow-wrap:anywhere]">
                {target.title}
              </p>
              <p dir="auto" className="text-xs text-fg-muted text-match-parent [overflow-wrap:anywhere]">
                {target.channelName}
              </p>
            </div>
          </div>
          <p className="text-sm text-fg-muted">{t('seriesConfirmBody')}</p>
        </div>
      ) : null}
    </Dialog>
  );
}

export function RemoveRuleDialog({ rule, onClose }: { rule: RecordingRule | null; onClose: () => void }) {
  const { t } = useTranslation('guide');
  const { t: tc } = useTranslation('common');
  const { removeRule } = useRuleActions();
  const [cancelScheduled, setCancelScheduled] = useState(true);
  const [busy, setBusy] = useState(false);
  const checkId = useId();
  useEffect(() => {
    setCancelScheduled(true);
    setBusy(false);
  }, [rule?.id]);

  const confirm = async () => {
    if (!rule || busy) return;
    setBusy(true);
    const ok = await removeRule(rule, rule.upcoming > 0 && cancelScheduled);
    setBusy(false);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={!!rule}
      onClose={onClose}
      size="sm"
      title={t('removeTitle')}
      testId="rule-remove-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tc('cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()} data-testid="rule-remove-ok">
            {t('removeRule')}
          </Button>
        </>
      }
    >
      {rule ? (
        <div className="flex flex-col gap-4">
          <p dir="auto" className="text-sm text-fg-muted text-match-parent [overflow-wrap:anywhere]">
            {t('removeBody', { title: rule.title, channel: rule.channelName })}
          </p>
          {rule.upcoming > 0 ? (
            <label htmlFor={checkId} className="flex cursor-pointer items-start gap-3 rounded-md border border-divider bg-surface-2 px-3 py-2.5 text-sm text-fg">
              <input
                id={checkId}
                type="checkbox"
                checked={cancelScheduled}
                onChange={(e) => setCancelScheduled(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-accent)]"
                data-testid="rule-remove-cancel-scheduled"
              />
              <span>{t('removeAlsoCancel', { n: rule.upcoming })}</span>
            </label>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
