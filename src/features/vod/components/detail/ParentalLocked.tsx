/**
 * The parental gate (C2) for opening a movie or series page in Ask mode. Until the PIN is
 * entered, a locked title shows only this panel: no poster, plot, episodes or play button.
 * Hide mode needs no gate here (the core never lists locked titles there), and with controls
 * off or an unlock running the page opens as usual.
 */

import { Lock, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { useRpcQuery } from '@/api/query';
import { sameRef, type ItemRef } from '@/api/types';
import { ensureUnlocked } from '@/features/parental/gate';
import { useParentalStatus } from '@/features/parental/status';
import { Button, EmptyState } from '@/ui';

export type OpenGateState = 'checking' | 'open' | 'locked' | 'failed';

export interface OpenGateOptions {
  /**
   * The title's category, for sources whose titles are not in the local catalog (Stalker pages
   * its VOD live from the portal): without it the core cannot see a group lock or an adult group.
   */
  categoryId?: string | undefined;
  /** Hold the check (state `checking`) until `categoryId` can be known, e.g. while the details load. */
  waitForCategory?: boolean;
}

/**
 * Whether a detail page may show `ref`. `failed` means the lock check itself failed: the page
 * stays closed (the gate fails closed), with a retry.
 */
export function useOpenGate(ref: ItemRef, opts: OpenGateOptions = {}): { state: OpenGateState; retry(): void } {
  const { categoryId, waitForCategory = false } = opts;
  const status = useParentalStatus();
  const s = status.data;
  const asks = !!s && s.enabled && s.mode === 'ask' && !s.unlocked;
  const check = useRpcQuery(
    'parental.check',
    { items: [categoryId ? { ref, categoryId } : { ref }] },
    { enabled: asks && !waitForCategory, staleTime: 0 },
  );
  const retry = () => {
    void status.refetch();
    if (asks) void check.refetch();
  };

  // A core without parental controls has nothing locked.
  if (status.error?.code === 'unsupported') return { state: 'open', retry };
  if (!s) return { state: status.isError ? 'failed' : 'checking', retry };
  if (!asks) return { state: 'open', retry };
  if (waitForCategory) return { state: 'checking', retry };
  if (check.isError) return { state: check.error.code === 'unsupported' ? 'open' : 'failed', retry };
  if (!check.data) return { state: 'checking', retry };
  return { state: check.data.some((r) => sameRef(r, ref)) ? 'locked' : 'open', retry };
}

/** The closed page: unlock with the PIN, or go back. */
export function ParentalLocked({
  itemRef,
  categoryId,
  title,
  failed,
  onRetry,
  fallbackHref,
}: {
  itemRef: ItemRef;
  /** The title's category when known (see {@link OpenGateOptions.categoryId}). */
  categoryId?: string | undefined;
  /** Names the title in the PIN prompt once its details are known. */
  title?: string | undefined;
  failed: boolean;
  onRetry(): void;
  /** Where Back goes when the page was opened cold. */
  fallbackHref: string;
}) {
  const { t } = useTranslation(['parental', 'common']);
  const navigate = useNavigate();
  const location = useLocation();
  const [busy, setBusy] = useState(false);

  const back = () => {
    if (location.key !== 'default') void navigate(-1);
    else void navigate(fallbackHref);
  };
  const unlock = async () => {
    setBusy(true);
    try {
      // A good PIN unlocks the session; the status change then opens the page.
      await ensureUnlocked([{ ref: itemRef, ...(title ? { title } : {}), ...(categoryId ? { categoryId } : {}) }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center" data-testid="parental-locked">
      <EmptyState
        icon={failed ? <ShieldAlert aria-hidden size={28} /> : <Lock aria-hidden size={28} />}
        title={failed ? t('parental:checkFailedTitle') : t('parental:unlockTitle')}
        description={
          failed ? t('parental:checkFailedText') : title ? t('parental:unlockNamedText', { title }) : t('parental:unlockText')
        }
        action={
          <>
            {failed ? (
              <Button variant="primary" onClick={onRetry}>
                {t('common:retry')}
              </Button>
            ) : (
              <Button variant="primary" icon={<Lock aria-hidden size={16} />} loading={busy} onClick={() => void unlock()}>
                {t('parental:unlock')}
              </Button>
            )}
            <Button variant="secondary" onClick={back}>
              {t('parental:back')}
            </Button>
          </>
        }
      />
    </div>
  );
}
