/**
 * One loader per non-English language. Each `./<folder>/index.ts` holds all of that language's
 * namespaces, and vite.config.ts puts it in the language's chunk (`locale-de`) with its JSON
 * files, so a language loads in one request.
 *
 * The map has one small import wrapper per language, 18 in all, and `index.ts` imports it
 * statically, so it is in the entry chunk. It replaced a map of every (language, namespace) pair,
 * about 270 wrappers and 23.5 kB, which lived in its own lazy chunk: a non-English cold start
 * fetched that chunk first and only then the language's, two requests in a row before the first
 * paint (performance audit SH-8).
 */
export const languageLoaders = import.meta.glob<{ modules: Record<string, unknown> }>('./*/index.ts');
