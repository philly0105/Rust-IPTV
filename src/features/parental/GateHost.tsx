import { useEffect, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';
import { toast } from '@/ui';

import { PinDialog } from './PinDialog';
import { registerGateHost, setCheckFailureReporter, settleGate, useGateStore, type PinRequest, type UnlockRequest } from './gate';
import { useUnlockDuration } from './labels';
import { applyStatus, useParentalStatus } from './status';

/**
 * Shows the PIN dialogs that {@link ensureUnlocked} and {@link requestPin}
 * ask for, one at a time. Mount once, in the shell (C2); with no host the
 * gate refuses rather than waiting.
 */
export function ParentalGateHost(): JSX.Element {
  const { t } = useTranslation('parental');
  const current = useGateStore((s) => s.queue[0]);

  useEffect(() => registerGateHost(), []);

  useEffect(
    () =>
      setCheckFailureReporter(() =>
        toast({ variant: 'error', title: t('checkFailedTitle'), description: t('checkFailedText'), id: 'parental-check-failed' }),
      ),
    [t],
  );

  if (!current) return <></>;
  return current.kind === 'unlock' ? <UnlockDialog key={current.id} request={current} /> : <PinRequestDialog key={current.id} request={current} />;
}

/** "Enter the PIN to watch": unlocks the session for the configured time. */
function UnlockDialog({ request }: { request: UnlockRequest }) {
  const { t } = useTranslation('parental');
  const { data: status, dataUpdatedAt } = useParentalStatus();
  const duration = useUnlockDuration(status?.unlockMinutes ?? 15);

  // Unlocked or switched off elsewhere (another window, the remote) since the core said "locked": let it through.
  const nowAllowed = !!status && dataUpdatedAt >= request.openedAt && (!status.enabled || status.unlocked);
  useEffect(() => {
    if (nowAllowed) settleGate(request.id, true);
  }, [nowAllowed, request.id]);

  const titles = request.items.map((i) => i.title).filter((x): x is string => !!x);
  const description =
    request.items.length > 1
      ? t('unlockManyText', { count: request.items.length })
      : titles[0]
        ? t('unlockNamedText', { title: titles[0] })
        : t('unlockText');

  return (
    <PinDialog
      open
      title={t('unlockTitle')}
      description={description}
      footnote={status?.unlockMinutes === 0 ? t('unlockUntilRestart') : t('unlockFor', { duration })}
      confirmLabel={t('unlock')}
      onSubmit={async (pin) => {
        const next = await rpc('parental.unlock', { pin });
        applyStatus(next);
        settleGate(request.id, true);
      }}
      onCancel={() => settleGate(request.id, false)}
      testId="parental-unlock"
    />
  );
}

/** A one-off PIN prompt for an action (removing a lock from a menu). */
function PinRequestDialog({ request }: { request: PinRequest }) {
  return (
    <PinDialog
      open
      title={request.title}
      description={request.description}
      confirmLabel={request.confirmLabel}
      danger={request.danger}
      onSubmit={async (pin) => {
        await request.submit(pin);
        settleGate(request.id, true);
      }}
      onCancel={() => settleGate(request.id, false)}
      testId="parental-pin"
    />
  );
}
