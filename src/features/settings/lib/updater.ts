/**
 * Thin seam over `@tauri-apps/plugin-updater` so the About section can be
 * tested without Tauri. Only call these on a desktop build whose `app.info`
 * reports `updaterAvailable` (the plugin is behind the `updater` cargo feature).
 */

import type { AppInfo } from '@/api/types';

export type UpdateDownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' };

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  downloadAndInstall(onEvent?: (e: UpdateDownloadEvent) => void): Promise<void>;
}

/** `app.info` plus the updater flag B9-fix1 adds (typed here until it lands in `AppInfo`). */
export type AppInfoWithUpdater = AppInfo & { updaterAvailable?: boolean };

export function updaterAvailable(info: AppInfo | undefined): boolean {
  return (info as AppInfoWithUpdater | undefined)?.updaterAvailable === true;
}

/** Null when the running version is the newest one. */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  const { check } = await import('@tauri-apps/plugin-updater');
  return check({ timeout: 30_000 });
}
