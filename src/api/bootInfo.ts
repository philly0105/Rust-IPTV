/**
 * Desktop: the one `app.info` request of a launch, sent as soon as the first
 * module loads. The image cache base (images.ts), the loopback proxy base
 * (transport.ts) and the query cache (query.ts seeds `['app.info', null]`, so
 * the onboarding host, What's new and About read it without asking again) all
 * share it. Null on the web and when the call fails.
 *
 * Like images.ts, this does not import `./transport`: tests mock that module
 * with partial factories.
 */

import { invoke } from '@tauri-apps/api/core';

import type { AppInfo } from './types';

const isDesktopWindow: boolean = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const desktopAppInfo: Promise<AppInfo | null> = isDesktopWindow
  ? invoke('rpc', { cmd: 'app.info', args: null }).then(
      (info) => (typeof info === 'object' && info !== null ? (info as AppInfo) : null),
      () => null,
    )
  : Promise.resolve(null);
