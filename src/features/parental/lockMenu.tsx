import type { TFunction } from 'i18next';
import { FolderLock, Lock, LockOpen, ShieldAlert } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { rpc, RpcError } from '@/api/transport';
import type { ParentalLock, ParentalLockTarget, ParentalStatus } from '@/api/types';
import { toast, type MenuAction } from '@/ui';

import { requestPin } from './gate';
import { afterLockChange, useParentalStatus } from './status';

const LOCKS_STALE_MS = 30_000;

const sameTarget = (a: ParentalLockTarget, b: ParentalLock): boolean =>
  a.sourceId === b.sourceId && a.contentType === b.contentType && a.kind === b.kind && a.targetId === b.targetId;

/**
 * Lock and remove-lock entries for a channel, station, movie, series or
 * group context menu (C2). Empty while parental controls are off (set a PIN
 * in Settings first) or when `target` is null.
 *
 * For an item, pass its `categoryId`: when that group is locked (by a lock or
 * the adult-content rule) the menu says "Locked with its group" instead of
 * offering a lock that would change nothing.
 *
 * Locking needs no PIN. Removing a lock goes straight through while the
 * session is unlocked, and asks for the PIN otherwise. A group that the
 * adult-content rule already locks shows that, without an action. The array
 * keeps its identity while nothing it shows changes, so callers can memoize
 * their menus on it.
 */
export function useLockMenuItems(target: ParentalLockTarget | null, opts?: { categoryId?: string }): MenuAction[] {
  const { t } = useTranslation('parental');
  const { data: status } = useParentalStatus();
  const on = target !== null && status?.enabled === true;

  const locks = useRpcQuery('parental.locks', { sourceId: target?.sourceId ?? '' }, { enabled: on, staleTime: LOCKS_STALE_MS });
  const categoryId = target?.kind === 'item' ? opts?.categoryId : undefined;
  const adultApplies = on && (target?.kind === 'category' || !!categoryId) && status?.autoAdult === true;
  const adult = useRpcQuery(
    'parental.adultCategories',
    { sourceId: target?.sourceId ?? '', contentType: target?.contentType ?? 'live' },
    { enabled: adultApplies, staleTime: LOCKS_STALE_MS },
  );

  // Callers usually build the target inline; its fields, not its identity, decide the entries.
  const sourceId = target?.sourceId;
  const contentType = target?.contentType;
  const kind = target?.kind;
  const targetId = target?.targetId;
  const name = target?.name;

  return useMemo((): MenuAction[] => {
    if (sourceId === undefined || contentType === undefined || kind === undefined || targetId === undefined || name === undefined) return [];
    if (!status?.enabled) return [];
    const tgt: ParentalLockTarget = { sourceId, contentType, kind, targetId, name };

    if (kind === 'category' && adultApplies && adult.data?.includes(targetId)) {
      return [
        {
          id: 'parental-adult',
          label: t('menuLockedAdult'),
          icon: <ShieldAlert aria-hidden size={16} />,
          disabled: true,
          onSelect: () => undefined,
        },
      ];
    }

    if (kind === 'item' && categoryId) {
      const groupLocked =
        locks.data?.some((l) => l.kind === 'category' && l.sourceId === sourceId && l.contentType === contentType && l.targetId === categoryId) ||
        (adultApplies && adult.data?.includes(categoryId));
      // An item lock of its own still offers "Remove lock" below.
      if (groupLocked && !locks.data?.some((l) => sameTarget(tgt, l))) {
        return [
          {
            id: 'parental-group-locked',
            label: t('menuLockedWithGroup'),
            icon: <FolderLock aria-hidden size={16} />,
            disabled: true,
            onSelect: () => undefined,
          },
        ];
      }
    }

    if (locks.data?.some((l) => sameTarget(tgt, l))) {
      return [
        {
          id: 'parental-remove-lock',
          label: t('menuRemoveLock'),
          icon: <LockOpen aria-hidden size={16} />,
          onSelect: () => void removeLock(tgt, status, t),
        },
      ];
    }

    return [
      {
        id: 'parental-lock',
        label: lockLabel(tgt, t),
        icon: <Lock aria-hidden size={16} />,
        // Until the lock list arrives it is unknown whether this is "Lock" or "Remove lock".
        disabled: locks.isPending,
        onSelect: () => void addLock(tgt, status, t),
      },
    ];
  }, [sourceId, contentType, kind, targetId, name, categoryId, status, adultApplies, adult.data, locks.data, locks.isPending, t]);
}

type T = TFunction<'parental'>;

function lockLabel(target: ParentalLockTarget, t: T): string {
  if (target.kind === 'category') return t('menuLockGroup');
  switch (target.contentType) {
    case 'live':
      return t('menuLockChannel');
    case 'radio':
      return t('menuLockStation');
    case 'movie':
      return t('menuLockMovie');
    case 'series':
      return t('menuLockSeries');
  }
}

function failed(t: T, err: unknown): void {
  toast({ variant: 'error', title: t('lockChangeFailed'), description: RpcError.from(err).message });
}

async function addLock(target: ParentalLockTarget, status: ParentalStatus, t: T): Promise<void> {
  try {
    await rpc('parental.setLocked', { target, locked: true });
  } catch (err) {
    failed(t, err);
    return;
  }
  afterLockChange();
  toast({
    variant: 'success',
    title: t('lockedToast', { name: target.name }),
    description: status.unlocked ? t('lockedWhileUnlocked') : status.mode === 'hide' ? t('lockedHidden') : t('lockedAsk'),
  });
}

async function removeLock(target: ParentalLockTarget, status: ParentalStatus, t: T): Promise<void> {
  const run = (pin?: string) => rpc('parental.setLocked', pin === undefined ? { target, locked: false } : { target, locked: false, pin });
  const done = () => {
    afterLockChange();
    toast({ variant: 'success', title: t('lockRemovedToast', { name: target.name }) });
  };

  if (status.unlocked) {
    try {
      await run();
      done();
      return;
    } catch (err) {
      // The unlock ran out in the meantime: fall through to the PIN.
      if (RpcError.from(err).code !== 'auth') {
        failed(t, err);
        return;
      }
    }
  }

  const ok = await requestPin({
    title: t('removeLockTitle'),
    description: t('removeLockText', { name: target.name }),
    confirmLabel: t('removeLock'),
    submit: async (pin) => {
      await run(pin);
    },
  });
  if (ok) done();
}
