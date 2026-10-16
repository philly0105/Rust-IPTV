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
 * just before a pause. Returns the draft and its setter (for the input, Clear and Enter).
 */
export function useUrlSearchDraft({ delayMs, param = 'q', toParam = trimmed }: UrlSearchDraftOptions): [string, (draft: string) => void] {
  const [params, setParams] = useSearchParams();
  const urlValue = params.get(param) ?? '';
  const [draft, setDraft] = useState(urlValue);
  /** The last value this hook wrote, or the URL value it last followed. */
  const written = useRef(urlValue);
  const toParamRef = useRef(toParam);
  toParamRef.current = toParam;

  // Follow the URL only when something else moved it.
  useEffect(() => {
    if (urlValue === written.current) return;
    written.current = urlValue;
    setDraft(urlValue);
  }, [urlValue]);

  useEffect(() => {
    const next = toParamRef.current(draft);
    // Already in the URL, or written and on its way there.
    if (next === urlValue || next === written.current) return;
    const h = setTimeout(() => {
      written.current = next;
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
