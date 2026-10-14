import { Suspense, type JSX } from 'react';

import { lazyDialog } from './DialogHost';
import type { HiddenChannelsPanelProps } from './HiddenChannelsPanel';

const HiddenChannelsPanel = lazyDialog<HiddenChannelsPanelProps>(async () => (await import('./HiddenChannelsPanel')).HiddenChannelsPanel);

export interface HiddenChannelsDialogProps {
  sourceId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/**
 * The hidden channels and stations of one source (C2): search, Unhide per
 * row, and Unhide all (both with Undo), with designed loading, error and
 * empty states. The dialog's code downloads the first time it opens.
 */
export function HiddenChannelsDialog({ sourceId, open, onOpenChange }: HiddenChannelsDialogProps): JSX.Element {
  if (!open) return <></>;
  return (
    <Suspense fallback={null}>
      <HiddenChannelsPanel key={sourceId} sourceId={sourceId} onClose={() => onOpenChange(false)} />
    </Suspense>
  );
}
