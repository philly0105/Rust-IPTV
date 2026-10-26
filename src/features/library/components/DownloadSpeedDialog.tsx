import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Download } from '@/api/types';
import { Button, Dialog, Input, Select, errorDescription } from '@/ui';

export const MIB = 1024 * 1024;

export function DownloadSpeedDialog({ download, globalLimit, onClose }: {
  download?: Download;
  globalLimit: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('library');
  const initial = download ? download.rateLimitBps : globalLimit;
  const [mode, setMode] = useState(initial === undefined ? 'default' : initial === 0 ? 'unlimited' : 'custom');
  const [amount, setAmount] = useState(String((initial || globalLimit || MIB) / MIB));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>();
  const numeric = Number(amount);
  const valid = mode !== 'custom' || (amount.trim() !== '' && Number.isFinite(numeric) && numeric > 0 && numeric <= 1024 && Math.round(numeric * MIB) >= 1);
  const formattedGlobal = globalLimit === 0 ? t('speedUnlimited') : t('speedValue', { value: (globalLimit / MIB).toLocaleString(i18n.language, { maximumFractionDigits: 6 }) });

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const bps = mode === 'default' ? null : mode === 'unlimited' ? 0 : Math.round(numeric * MIB);
      if (download) {
        await rpc('downloads.setRateLimit', { id: download.id, bytesPerSecond: bps });
        await invalidate('downloads.list');
      } else {
        await rpc('settings.update', { patch: { downloadRateLimitBps: bps ?? 0 } });
        await invalidate('settings.get');
      }
      onClose();
    } catch (err) {
      setError(errorDescription(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={() => { if (!busy) onClose(); }}
      dismissible={!busy}
      title={download ? t('speedDownloadTitle', { title: download.subtitle || download.title }) : t('speedGlobalTitle')}
      description={download ? t('speedDownloadHint') : t('speedGlobalHint')}
      size="sm"
    >
      <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Select
          label={t('speedMode')}
          value={mode}
          disabled={busy}
          onChange={(event) => setMode(event.target.value)}
          options={[
            ...(download ? [{ value: 'default', label: t('speedUseDefault', { speed: formattedGlobal }) }] : []),
            { value: 'custom', label: t('speedCustom') },
            { value: 'unlimited', label: t('speedUnlimited') },
          ]}
        />
        {mode === 'custom' && (
          <Input
            type="number"
            label={t('speedLimitLabel')}
            hint={t('speedUnitsHint')}
            min={1 / MIB}
            max={1024}
            step="any"
            value={amount}
            onValueChange={setAmount}
            disabled={busy}
            error={!valid ? t('speedInvalid') : undefined}
          />
        )}
        {error && <p role="alert" className="text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('speedCancel')}</Button>
          <Button type="submit" loading={busy} disabled={!valid}>{t('speedSave')}</Button>
        </div>
      </form>
    </Dialog>
  );
}
