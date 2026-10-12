import { useCallback, useEffect, useState } from 'react';

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
  | { status: 'error'; error: RpcError; retry(): void };

/** Debounced `m3u.parsePreview` of `text`. Stale responses are dropped; a failed parse can be retried. */
export function usePlaylistPreview(text: string, delayMs = 350): PreviewState {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  // Bumping `attempt` re-runs the same parse when the user presses Try again.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
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
          if (!cancelled) setState({ status: 'error', error: RpcError.from(err), retry });
        });
    }, delayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, delayMs, attempt, retry]);
  return state;
}
