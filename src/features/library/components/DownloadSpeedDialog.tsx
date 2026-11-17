import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Download } from '@/api/types';
import { Button, Dialog, Input, Select, errorDescription } from '@/ui';

import { formatSpeedLimit } from '../lib/format';
import { downloadNames } from '../lib/queue';

export const MIB = 1024 * 1024;

/**
 * Limits most people want, in the MB/s the rows show for the live speed (binary megabytes, as
 * formatBytes counts them). Anything else is Custom, in MB/s to one decimal.
 */
const PRESETS_MB = [1, 2, 5, 10] as const;

/** The dialog's choice for a stored limit: a preset when it is one, else Custom. */
function modeFor(bps: number | undefined): string {
  if (bps === undefined) return 'default';
  if (bps === 0) return 'unlimited';
  const preset = PRESETS_MB.find((mb) => mb * MIB === bps);
  return preset ? String(preset) : 'custom';
}

/** A stored limit in MB/s for the Custom field: one decimal, never below 0.1 (an old 0.38147 reads 0.4). */
function customAmount(bps: number): string {
  return String(Math.max(0.1, Math.round((bps / MIB) * 10) / 10));
}

export function DownloadSpeedDialog({ download, globalLimit, onClose }: {
  download?: Download;
  globalLimit: number;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation('library');
  const lang = i18n.language;
  const initial = download ? download.rateLimitBps : globalLimit;
  const [mode, setMode] = useState(() => modeFor(initial));
  const [amount, setAmount] = useState(() => customAmount(initial || globalLimit || MIB));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReactNode>();
  const numeric = Number(amount);
  const valid = mode !== 'custom' || (amount.trim() !== '' && Number.isFinite(numeric) && numeric > 0 && numeric <= 1024);
  const formattedGlobal = globalLimit === 0 ? t('speedUnlimited') : formatSpeedLimit(globalLimit, lang);

  const save = async () => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    try {
      const bps = mode === 'default' ? null : mode === 'unlimited' ? 0 : mode === 'custom' ? Math.round(numeric * MIB) : Number(mode) * MIB;
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
      title={download ? t('speedDownloadTitle', { title: downloadNames(download).title }) : t('speedGlobalTitle')}
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
            { value: 'unlimited', label: t('speedUnlimited') },
            ...PRESETS_MB.map((mb) => ({ value: String(mb), label: formatSpeedLimit(mb * MIB, lang) })),
            { value: 'custom', label: t('speedCustom') },
          ]}
        />
        {mode === 'custom' && (
          <Input
            type="number"
            label={t('speedLimitLabel')}
            hint={t('speedUnitsHint')}
            min={0.1}
            max={1024}
            step={0.1}
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
