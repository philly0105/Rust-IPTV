import { lazy, Suspense, useEffect, type ComponentType, type JSX } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/ui';

import type { RenameDialogProps } from './RenameDialog';
import { closeRenameDialog, registerRenameHost, useRenameStore } from './store';

/** Stands in for a dialog whose chunk failed to download (offline, or a stale build after an update). */
function LoadFailed({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('channels');
  useEffect(() => {
    toast({ variant: 'error', title: t('loadFailed'), description: t('loadFailedText'), id: 'channeledit-load-failed' });
    onClose();
  }, [t, onClose]);
  return null;
}

/**
 * A lazily loaded dialog. The shell mounts the hosts in its entry chunk, so
 * the dialogs themselves download on first use; a failed download says so in
 * a toast instead of breaking the page.
 */
export function lazyDialog<P extends { onClose: () => void }>(load: () => Promise<ComponentType<P>>) {
  return lazy(async () => {
    try {
      return { default: await load() };
    } catch (err) {
      console.error('[channeledit] could not load a dialog', err);
      return { default: LoadFailed as unknown as ComponentType<P> };
    }
  });
}

const RenameDialog = lazyDialog<RenameDialogProps>(async () => (await import('./RenameDialog')).RenameDialog);

/**
 * Shows the rename dialog that the channel menus and F2 ask for (C2). Mount
 * once, in the shell; without it, Rename does nothing and logs a warning.
 */
export function ChannelEditDialogHost(): JSX.Element {
  const request = useRenameStore((s) => s.request);
  useEffect(() => registerRenameHost(), []);
  if (!request) return <></>;
  return (
    <Suspense fallback={null}>
      <RenameDialog key={request.id} channel={request.channel} onClose={closeRenameDialog} />
    </Suspense>
  );
}
