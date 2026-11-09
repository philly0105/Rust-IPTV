import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';

export interface UrlSearchDraftOptions {
  /** Pause after the last keystroke before the text goes into the URL. */
  delayMs: number;
  /** The search param that holds the text. Default `q`. */
  param?: string;
  /** The URL value for a draft; an empty result removes the param. Default: the trimmed draft. */
  toParam?: (draft: string) => string;
}

const trimmed = (draft: string) => draft.trim();

/**
 * A search box whose text debounces into a URL search param (L3-vod-1). The box holds its own
 * draft, so typing never waits on the router, and the URL stays the source of truth for the
 * query: when the param moves to a value this hook did not write (Back or Forward, a link, a
 * chip), the draft follows it.
 *
 * A value the hook wrote itself is never copied back into the draft. The router commits a write
 * a render or more after it is made; by then the user may have typed more, and copying the
 * committed value back dropped those letters ('northbound' became 'notbond'), or the space typed
 * just before a pause. On a slow machine the router can commit a write after the hook has made the
 * next one (its navigation renders as a transition, which keys keep interrupting), so every write
 * still on its way counts as the hook's own, not only the last: following the older one dropped the
 * letter typed in between ('dark river' became 'dark rver' at 8 keys a second under a 4x CPU
 * slowdown). Returns the draft and its setter (for the input, Clear and Enter).
 */
export function useUrlSearchDraft({ delayMs, param = 'q', toParam = trimmed }: UrlSearchDraftOptions): [string, (draft: string) => void] {
  const [params, setParams] = useSearchParams();
  const urlValue = params.get(param) ?? '';
  const [draft, setDraft] = useState(urlValue);
  /** The last value this hook wrote, or the URL value it last followed. */
  const written = useRef(urlValue);
  /** Values this hook wrote that the URL has not shown yet, oldest first. */
  const inFlight = useRef<string[]>([]);
  const toParamRef = useRef(toParam);
  toParamRef.current = toParam;

  // Follow the URL only when something else moved it.
  useEffect(() => {
    const own = inFlight.current.indexOf(urlValue);
    if (own >= 0) {
      // One of this hook's writes arrived (perhaps after a newer one was made): it and the older ones are done.
      inFlight.current.splice(0, own + 1);
      return;
    }
    if (urlValue === written.current) return;
    written.current = urlValue;
    inFlight.current = [];
    setDraft(urlValue);
  }, [urlValue]);

  useEffect(() => {
    const next = toParamRef.current(draft);
    // Already in the URL, or written and on its way there.
    if (next === urlValue || next === written.current) return;
    const h = setTimeout(() => {
      written.current = next;
      inFlight.current.push(next);
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next) out.set(param, next);
          else out.delete(param);
          return out;
        },
        { replace: true },
      );
    }, delayMs);
    return () => clearTimeout(h);
  }, [draft, urlValue, param, delayMs, setParams]);

  return [draft, setDraft];
}
