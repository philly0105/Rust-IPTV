import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Settings } from '@/api/types';
import { DownloadSpeedDialog } from '@/features/library/components/DownloadSpeedDialog';
import { formatSpeedLimit } from '@/features/library/lib/format';
import { Button } from '@/ui';

import { SettingsRow } from '../components';

/**
 * downloads: the default speed limit of each download (`settings.downloadRateLimitBps`, 0 for
 * none), set in the same dialog as the button on /downloads, so it can be found from Settings too.
 */
export function DownloadSpeedRow({ settings }: { settings: Settings }) {
  // library: the dialog's own words, and its name for no limit.
  const { t, i18n } = useTranslation(['settings', 'library']);
  const [open, setOpen] = useState(false);
  const limit = settings.downloadRateLimitBps ?? 0;
  const value = limit === 0 ? t('library:speedUnlimited') : formatSpeedLimit(limit, i18n.language);
  return (
    <SettingsRow label={t('downloadSpeed')} description={t('downloadSpeedHint')}>
      {({ id, describedBy }) => (
        <>
          <Button id={id} aria-describedby={describedBy} variant="secondary" icon={<Gauge size={16} aria-hidden />} onClick={() => setOpen(true)} data-testid="settings-download-speed">
            {value}
          </Button>
          {open && <DownloadSpeedDialog globalLimit={limit} onClose={() => setOpen(false)} />}
        </>
      )}
    </SettingsRow>
  );
}
