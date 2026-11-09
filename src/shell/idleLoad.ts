/**
 * When the shell loads code the first screen does not need: the player module, and the chunks of
 * overlays and menus that show only on demand (the command palette, the shortcut overlay, Home's
 * card menus). They wait until the first route has had the browser to itself for a while and the
 * page is not scrolling, or load at once on the first pointer or key press, the start of any
 * intent to use them.
 */

/** Maximum idle-callback wait between checks for a quiet scroll period. */
export const PLAYER_IDLE_TIMEOUT_MS = 2000;
/**
 * How long the shell leaves the first route to itself before it starts the idle wait for the
 * player (about 200 KB of chunks to fetch, parse and compile): they arrived at about 414 ms on a
 * cold load, among the route's own chunks and in its long tasks (L3-perf-ui-6). A press still
 * loads the player at once.
 */
export const PLAYER_PREFETCH_DELAY_MS = 2500;
/** Background player setup must not interrupt wheel/trackpad scrolling. */
export const PLAYER_SCROLL_QUIET_MS = 250;

/**
 * Calls `load` once: at once when `now`, else on the first idle moment (at most
 * PLAYER_IDLE_TIMEOUT_MS; a macrotask where requestIdleCallback is missing) once `delayMs` has
 * passed and scrolling is quiet, or on the first pointer or non-modifier key press. Presses
 * count from the start. Returns the cancel function.
 */
export function schedulePlayerLoad(load: () => void, now: boolean, win: Window = window, delayMs = 0): () => void {
  const intents = ['pointerdown', 'keydown'] as const;
  const movement = ['wheel', 'scroll', 'touchmove'] as const;
  let idle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelled = false;
  let lastMovement = Number.NEGATIVE_INFINITY;
  const noteMovement = () => { lastMovement = Date.now(); };
  const cancel = () => {
    cancelled = true;
    for (const type of intents) win.removeEventListener(type, onIntent, true);
    for (const type of movement) win.removeEventListener(type, noteMovement, true);
    if (idle !== undefined) win.cancelIdleCallback?.(idle);
    if (timer !== undefined) clearTimeout(timer);
    idle = timer = undefined;
  };
  function fire() {
    if (cancelled) return;
    cancel();
    load();
  }
  function onIntent(event: Event) {
    // Shift is commonly the start of horizontal scrolling, not an intent to play anything.
    if (event.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta', 'AltGraph'].includes((event as KeyboardEvent).key)) return;
    fire();
  }
  if (now) {
    load();
    return () => undefined;
  }
  for (const type of intents) win.addEventListener(type, onIntent, { capture: true, passive: true });
  for (const type of movement) win.addEventListener(type, noteMovement, { capture: true, passive: true });
  const whenQuiet = () => {
    idle = undefined;
    if (cancelled) return;
    const wait = PLAYER_SCROLL_QUIET_MS - (Date.now() - lastMovement);
    if (wait > 0) timer = setTimeout(waitForIdle, wait);
    else fire();
  };
  const waitForIdle = () => {
    timer = undefined;
    if (cancelled) return;
    if (typeof win.requestIdleCallback === 'function') idle = win.requestIdleCallback(whenQuiet, { timeout: PLAYER_IDLE_TIMEOUT_MS });
    else timer = setTimeout(whenQuiet, 0);
  };
  if (delayMs > 0) timer = setTimeout(waitForIdle, delayMs);
  else waitForIdle();
  return cancel;
}

/**
 * `schedulePlayerLoad` for a chunk the first screen does not need: on the first idle, quiet moment
 * once PLAYER_PREFETCH_DELAY_MS has passed, or on the first press. Returns the cancel function.
 */
export function scheduleIdleLoad(load: () => void, win: Window = window): () => void {
  return schedulePlayerLoad(load, false, win, PLAYER_PREFETCH_DELAY_MS);
}
