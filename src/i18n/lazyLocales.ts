/**
 * Lazy loaders for every non-English `./<folder>/<ns>.json`, one chunk each.
 *
 * This map has one entry per (language, namespace) pair, about 270 of them,
 * and Vite turns each into an import wrapper, so it weighs about 20 kB. It
 * lives in its own module, which `index.ts` imports dynamically on the first
 * non-English load, so the entry chunk (check 14's budget) does not carry it
 * and an English session never fetches it.
 */
export const lazyModules = import.meta.glob(['./*/*.json', '!./en/*.json']) as Record<
  string,
  () => Promise<unknown>
>;
