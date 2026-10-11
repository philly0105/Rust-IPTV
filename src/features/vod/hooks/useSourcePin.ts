import { useCallback, useMemo, useState } from 'react';

import type { ItemRef, VodItem } from '@/api/types';

import { clearPin, getPin, matchKey, setPin, type SourcePin } from '../lib/pins';

/** Preferred-source pin for a title, plus the copy it points at when that copy is among `others`. */
export function useSourcePin(item: Pick<VodItem, 'title' | 'titleBase' | 'year'> | undefined, others: VodItem[]) {
  const key = item ? matchKey(item) : undefined;
  const [version, setVersion] = useState(0);
  // version forces a re-read after this page writes the pin
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pin = useMemo<SourcePin | undefined>(() => (key ? getPin(key) : undefined), [key, version]);

  const update = useCallback(
    (ref: ItemRef | null) => {
      if (!key) return;
      if (ref) setPin(key, ref);
      else clearPin(key);
      setVersion((v) => v + 1);
    },
    [key],
  );

  const pinnedOther = pin ? others.find((o) => o.ref.sourceId === pin.sourceId && o.ref.itemId === pin.itemId) : undefined;
  return { pin, setPin: update, pinnedOther };
}
