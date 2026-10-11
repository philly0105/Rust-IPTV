import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, Input } from '@/ui';
import { confirmWordMatches } from '../lib/confirmWord';
import { Field } from './Field';

/**
 * Confirms "Remove all playlists" by typing a word, so a stray click or Enter
 * cannot wipe every source.
 */
export function RemoveAllDialog({
  open,
  count,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  count: number;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation('sources');
  const [typed, setTyped] = useState('');
  const word = t('removeAllWord');
  const ok = confirmWordMatches(typed, word);

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={() => (busy ? undefined : onClose())}
      title={t('removeAllTitle', { count })}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={!ok} onClick={onConfirm} data-testid="sources-remove-all-confirm">
            {t('removeAllConfirm', { count })}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) onConfirm();
        }}
      >
        <p className="text-fg-muted">{t('removeAllBody', { count })}</p>
        <Field label={t('removeAllTypeLabel', { word })}>
          {(p) => (
            <Input
              {...p}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              data-testid="sources-remove-all-input"
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
