import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';

import { Button, Dialog, useToast } from '@/ui';
import { SettingsGroup, SettingsRow } from '../components';
import { diffSettings, type SettingsPatch } from '../lib/patch';
import { useResetSettings } from '../lib/useUpdateSettings';

/**
 * Puts every setting back to its default after a confirm. Sources, favorites,
 * history and downloads are untouched. The toast offers Undo, which sends
 * back only what the reset changed.
 */
export function ResetGroup({ update }: { update: (patch: SettingsPatch) => Promise<boolean> }) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const reset = useResetSettings();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    const before = await reset();
    setBusy(false);
    setOpen(false);
    if (!before) return;
    toast({
      variant: 'success',
      title: t('resetDone'),
      action: {
        label: t('undo'),
        onClick: () => {
          // A failed save already says so, with a retry.
          void rpc('settings.get')
            .catch(() => null)
            .then((now) => {
              const patch = now ? diffSettings(now, before) : before;
              if (Object.keys(patch).length > 0) void update(patch);
            });
        },
      },
    });
  };

  return (
    // The danger zone of Backup and storage (SS-8): the one irreversible action of Settings, last on the page.
    <SettingsGroup title={t('dangerZone')} tone="danger">
      <SettingsRow label={t('resetButton')} description={t('resetHint')}>
        {({ id, describedBy }) => (
          <Button id={id} aria-describedby={describedBy} variant="secondary" icon={<RotateCcw aria-hidden size={16} />} onClick={() => setOpen(true)} data-testid="settings-reset">
            {t('resetButton')}
          </Button>
        )}
      </SettingsRow>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('resetConfirmTitle')}
        description={t('resetConfirmBody')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void confirm()} data-testid="settings-reset-confirm">
              {t('resetConfirm')}
            </Button>
          </>
        }
      />
    </SettingsGroup>
  );
}
