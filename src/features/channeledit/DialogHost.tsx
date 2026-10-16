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

/** A {@link lazyDialog}: render it inside Suspense, or `preload()` its chunk ahead of the first open. */
export type LazyDialog<P> = ((props: P) => JSX.Element) & { preload(): Promise<void> };

/**
 * A lazily loaded dialog. The shell mounts the hosts in its entry chunk, so
 * the dialogs themselves download on first use; a failed download says so in
 * a toast instead of breaking the page.
 *
 * `preload()` (the Live page calls it at idle) fetches the chunk early: once
 * it has landed the dialog renders in the same commit that asks for it, with
 * no suspended frame. A failed preload is forgotten, so the open tries again.
 */
export function lazyDialog<P extends { onClose: () => void }>(load: () => Promise<ComponentType<P>>): LazyDialog<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const get = (): Promise<ComponentType<P>> =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (err: unknown) => {
        pending = undefined;
        throw err;
      },
    ));
  const Lazy = lazy(async () => {
    try {
      return { default: await get() };
    } catch (err) {
      console.error('[channeledit] could not load a dialog', err);
      return { default: LoadFailed as unknown as ComponentType<P> };
    }
  });
  const Dialog = (props: P): JSX.Element => {
    const Loaded = loaded;
    return Loaded ? <Loaded {...props} /> : <Lazy {...props} />;
  };
  Dialog.preload = () => get().then(
    () => undefined,
    () => undefined,
  );
  return Dialog;
}

const RenameDialog = lazyDialog<RenameDialogProps>(async () => (await import('./RenameDialog')).RenameDialog);

/** Fetches the rename dialog's code ahead of the first F2 or menu Rename. */
export function preloadRenameDialog(): Promise<void> {
  return RenameDialog.preload();
}

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
