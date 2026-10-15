/**
 * Asks before stopping a recording that is writing now: a stopped recording
 * cannot be resumed, so this is the one recording action that confirms. The
 * file written so far is kept. Used by the Scheduled page, the programme
 * dialog and the ribbon's record menu.
 */

import { Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { Recording } from '@/api/types';
import { Button, Dialog } from '@/ui';

import { useCancelPending, useScheduleActions } from '../hooks';

export interface StopRecordingDialogProps {
  /** The running recording to stop; null keeps the dialog closed. */
  recording: Recording | null;
  onClose: () => void;
}

export function StopRecordingDialog({ recording, onClose }: StopRecordingDialogProps) {
  const { t } = useTranslation('library');
  const actions = useScheduleActions();
  const [busy, setBusy] = useState(false);
  const pending = useCancelPending(recording?.id);
  const name = recording ? (recording.title ?? recording.channelName) : '';

  const stop = async () => {
    if (!recording || busy) return;
    setBusy(true);
    try {
      await actions.cancelRecording(recording);
    } finally {
      setBusy(false);
      onClose();
    }
  };

  return (
    <Dialog
      open={recording !== null}
      onClose={onClose}
      title={t('stopConfirmTitle')}
      description={t('stopConfirmBody', { title: name })}
      size="sm"
      footer={
        <>
          {/* The safe choice takes focus: Enter on an open dialog keeps recording. */}
          <Button variant="ghost" onClick={onClose} data-autofocus>
            {t('stopConfirmKeep')}
          </Button>
          <Button
            variant="danger"
            icon={<Square size={16} aria-hidden />}
            loading={busy || pending}
            onClick={() => void stop()}
            data-testid="stop-recording-confirm"
          >
            {t('stopConfirmAction')}
          </Button>
        </>
      }
    />
  );
}
