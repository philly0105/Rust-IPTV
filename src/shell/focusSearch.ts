/** The search fields Ctrl+F and the header's "Search everything" button land in. */
export const SEARCH_FIELD = '[data-page-search], [data-shell-search]';

/**
 * Focuses the search field once it exists. The search page loads lazily, so on a first visit its
 * field (in the header) mounts only after the chunk arrives, which can take well over a frame:
 * poll briefly instead of guessing one delay. `skip` is a field of the page being left (My List's
 * own filter, say): it is still mounted for a moment after navigate(), and focusing it would drop
 * focus on <body> when that page unmounts.
 */
export function focusSearchWhenReady(opts: { skip?: Element | null; deadline?: number } = {}): void {
  const deadline = opts.deadline ?? Date.now() + 3000;
  const field = [...document.querySelectorAll<HTMLInputElement>(SEARCH_FIELD)].find((f) => f !== opts.skip);
  if (field) field.focus();
  else if (Date.now() < deadline) setTimeout(() => focusSearchWhenReady({ skip: opts.skip, deadline }), 50);
}

/** Opens the search page with the cursor in its field, as Ctrl+F does. */
export function openSearch(navigate: (to: string) => void | Promise<void>): void {
  const leaving = document.querySelector(SEARCH_FIELD);
  void navigate('/search');
  focusSearchWhenReady({ skip: leaving });
}
