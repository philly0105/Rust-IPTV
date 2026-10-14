import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';

/**
 * Player parts that only show on demand (popovers, sub-menus, the stream info panel, the
 * fullscreen channel panel), split out of the main chunk. The first player part that
 * mounts schedules an idle-time preload of all of them, so by the time the user opens one it
 * renders synchronously: no empty frame, no layout shift, and a shortcut works on first press.
 */

type Part<P> = ((props: P) => ReactNode) & { preload(): Promise<unknown> };

const parts: Part<never>[] = [];
let scheduled = false;

function schedulePreload(): void {
  if (scheduled) return;
  scheduled = true;
  const run = () => {
    for (const p of parts) void p.preload().catch(() => undefined);
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 200);
}

/**
 * A lazily loaded component. Each mounted instance keeps the component it started with, so a
 * load finishing mid-life never remounts it. `fallback` renders while the chunk is still loading.
 */
export function lazyPart<P extends object>(load: () => Promise<ComponentType<P>>, fallback?: (props: P) => ReactNode): Part<P> {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = (): Promise<ComponentType<P>> =>
    (pending ??= load().then(
      (c) => (loaded = c),
      (e: unknown) => {
        pending = undefined;
        throw e;
      },
    ));
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));

  function LazyPart(props: P): ReactNode {
    const [Loaded] = useState(() => loaded);
    useEffect(schedulePreload, []);
    if (Loaded) return <Loaded {...props} />;
    return (
      <Suspense fallback={fallback ? fallback(props) : null}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  const part = Object.assign(LazyPart, { preload });
  parts.push(part as Part<never>);
  return part;
}

export const ChannelHistory = lazyPart(() => import('./ChannelHistory').then((m) => m.ChannelHistory));
export const AlternatesRow = lazyPart(() => import('./AlternateSources').then((m) => m.AlternatesRow));
export const AlternatesMenu = lazyPart(() => import('./AlternateSources').then((m) => m.AlternatesMenu));
export const StreamInfoPanel = lazyPart(() => import('./StreamInfoPanel').then((m) => m.StreamInfoPanel));
export const VideoContextMenu = lazyPart(() => import('./VideoContextMenu').then((m) => m.VideoContextMenu));
/** Fullscreen-only; its guide lines pull in the live feature's EPG helpers. */
export const FullscreenChannelPanel = lazyPart(() => import('./FullscreenChannelPanel').then((m) => m.FullscreenChannelPanel));
/** The tuner's info banner (C5); mounted with every surface, so it loads right after the player. */
export const ZapBanner = lazyPart(() => import('./ZapBanner').then((m) => m.ZapBanner));
/** The sleep timer's chip, menu, warning toast and in-player prompt (C5). */
export const SleepChip = lazyPart(() => import('./SleepTimer').then((m) => m.SleepChip));
export const SleepMenu = lazyPart(() => import('./SleepTimer').then((m) => m.SleepMenu));
export const SleepRowValue = lazyPart(() => import('./SleepTimer').then((m) => m.SleepRowValue));
export const SleepTimerHost = lazyPart(() => import('./SleepTimer').then((m) => m.SleepTimerHost));
export const SleepPrompt = lazyPart(() => import('./SleepTimer').then((m) => m.SleepPrompt));
/** The Subtitles submenu and its compact style view (C6). */
export const SubtitleTrackMenu = lazyPart(() => import('./SubtitleMenu').then((m) => m.SubtitleTrackMenu));
export const SubtitleStyleMenu = lazyPart(() => import('./SubtitleMenu').then((m) => m.SubtitleStyleMenu));
