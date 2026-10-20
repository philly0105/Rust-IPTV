/**
 * Server mode reached over plain HTTP from another device (http://<lan-ip>:7180) is not a secure
 * context, and the browser quietly switches off what the app relies on there: installing it as
 * an app (the service worker), copying to the clipboard, notifications and ClearKey channels
 * (EME). Those features then failed with no reason given (SR-4). This says so once, with a link
 * to the HTTPS setup. localhost is a secure context, so a local install never sees it.
 */

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { isDesktop } from '@/api/transport';
import { toast } from '@/ui';

const SHOWN_KEY = 'tsrust.insecureNoticeShown';
/** The HTTPS and secure-context section of the server docs. */
export const SECURE_CONTEXT_DOCS = 'https://github.com/philly0105/Rust-IPTV/blob/master/docs/architecture/server.md#https-and-secure-context';
/** Lets the first screen settle before the notice slides in. */
export const SECURE_NOTICE_DELAY_MS = 1500;

function shownBefore(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) === '1';
  } catch {
    // Storage blocked: showing it on every visit would nag; once per page load is the floor.
    return false;
  }
}

/** Shows the notice once per browser. Mount once (the shell does). Renders nothing. */
export function SecureContextNotice() {
  const { t } = useTranslation('shell');
  useEffect(() => {
    if (isDesktop || typeof window === 'undefined' || window.isSecureContext !== false || shownBefore()) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SHOWN_KEY, '1');
      } catch {
        // see shownBefore
      }
      toast({
        id: 'insecure-context',
        variant: 'info',
        title: t('insecureTitle'),
        description: t('insecureBody'),
        duration: 0,
        action: { label: t('insecureLink'), onClick: () => void window.open(SECURE_CONTEXT_DOCS, '_blank', 'noopener,noreferrer') },
      });
    }, SECURE_NOTICE_DELAY_MS);
    return () => clearTimeout(timer);
    // Once per mount; the strings are read when it fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}
