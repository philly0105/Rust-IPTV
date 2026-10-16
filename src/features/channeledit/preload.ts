import { preloadRenameDialog } from './DialogHost';
import { preloadHiddenChannelsDialog } from './HiddenChannelsDialog';

/**
 * Downloads the rename and hidden-channels dialogs' code. The first F2 or
 * "Hidden channels" otherwise waited 330-360 ms on the chunk with nothing on
 * screen (L3-live-6). Safe to call often: each chunk is fetched once.
 */
export function preloadChannelEditDialogs(): Promise<void> {
  return Promise.all([preloadRenameDialog(), preloadHiddenChannelsDialog()]).then(() => undefined);
}
