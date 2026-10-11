import { useEffect, useState } from 'react';

import { RpcError, rpc } from '@/api/transport';

export interface PlaylistPreview {
  channelCount: number;
  groups: string[];
  epgUrls: string[];
}

/** The core only parses the first 2 MB for a preview; never ship more over IPC. */
export const PREVIEW_LIMIT = 2 * 1024 * 1024;

export type PreviewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; preview: PlaylistPreview; truncated: boolean }
  | { status: 'error'; error: RpcError };

/** Debounced `m3u.parsePreview` of `text`. Stale responses are dropped. */
export function usePlaylistPreview(text: string, delayMs = 350): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  useEffect(() => {
    if (!text.trim()) {
      setState({ status: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    const timer = setTimeout(() => {
      const truncated = text.length > PREVIEW_LIMIT;
      rpc('m3u.parsePreview', { text: truncated ? text.slice(0, PREVIEW_LIMIT) : text })
        .then((preview) => {
          if (!cancelled) setState({ status: 'ready', preview, truncated });
        })
        .catch((err: unknown) => {
          if (!cancelled) setState({ status: 'error', error: RpcError.from(err) });
        });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, delayMs]);
  return state;
}
