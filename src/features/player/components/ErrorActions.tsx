/**
 * What the error screen offers (PL-ERROR-DEAD-ENDS): each class of failure gets the step its copy
 * names as a button, the most useful one first and solid, Retry after it whenever something better
 * leads. The inline overlay and embedded mpv's error strip both render these.
 */

import { Copy, ExternalLink, Layers, Lock, Pencil, Play, RefreshCw, RotateCcw, Settings2, SkipForward } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { useInRouterContext, useNavigate } from 'react-router';

import { queryClient, rpcKey } from '@/api/query';
import { rpc } from '@/api/transport';
import type { PlayerSource, Settings, Source } from '@/api/types';
import { toast } from '@/ui/Toast';
import { errorDescription } from '@/ui/States';

import { hintWithoutOthers, isParentalRefusal, type ExternalRoute, type StreamErrorClass } from '../errors';
import { useMediaStore } from '../media';
import { exitPip, usePipStore } from '../pip';
import { canZap, knownSourceKind, recoveryPoint, replayFromRef, setSettingsCache, usePlayerStore, zap } from '../store';
import type { StreamErrorView } from '../useStreamError';
import { usePlayerSettings } from '../useSettings';
import { glassButton, type GlassButtonSize } from './glassButton';

export type ErrorActionId =
  | 'retry'
  | 'refreshSource'
  | 'editSource'
  | 'otherSources'
  | 'nextChannel'
  | 'playAsHls'
  | 'playbackSettings'
  | 'parental'
  | 'openMpv'
  | 'openVlc'
  | 'copyLink';

export interface ErrorActionContext {
  cls: StreamErrorClass;
  /** The player's error message (a parental refusal reads as `notFound`). */
  message?: string | undefined;
  live: boolean;
  /** A stream URL exists (the failure was not the lookup itself). */
  hasMedia: boolean;
  external: ExternalRoute;
  /** The live channel has copies on other sources (the options menu lists them). */
  alternates: boolean;
  /**
   * The options menu can open here, to list those copies: not over the compact bar (the mini
   * player, embedded mpv's picture-in-picture window), which has no Playback options.
   */
  menu: boolean;
  /** Next channel can step from here. */
  zappable: boolean;
  /** The item's source can be imported again (it has a ref; a pasted playlist has nothing to fetch). */
  refreshable: boolean;
  /** The item has a source to open in Sources. */
  hasSource: boolean;
  /** Raw MPEG-TS in a browser without Media Source Extensions: the element cannot play it at all. */
  rawTs: boolean;
  /** ...and the source is Xtream on the TS stream format, so HLS is one setting away. */
  rawTsXtream: boolean;
  /** Settings and Sources are reachable (the player sits in the app's router). */
  routed: boolean;
}

/**
 * The actions for a failure, in order: the first is the primary. Every list holds Retry, except
 * where it cannot help and something else is offered (a raw TS stream the browser cannot play).
 * An external player trails most lists: providers often refuse a browser's request (its user
 * agent, its headers) that VLC or MPV gets through. Not for a full account (it would take one more
 * connection), offline, or parental controls.
 */
export function errorActionIds(c: ErrorActionContext): ErrorActionId[] {
  const out: ErrorActionId[] = [];
  const add = (...ids: (ErrorActionId | false)[]): void => {
    for (const id of ids) if (id && !out.includes(id)) out.push(id);
  };
  const external: ErrorActionId[] = !c.hasMedia ? [] : c.external === 'app' ? ['openMpv', 'openVlc'] : c.external === 'link' ? ['copyLink'] : [];
  const others = c.live && c.alternates && c.menu && 'otherSources';

  if (c.rawTs) {
    if (c.rawTsXtream) add('playAsHls', c.routed && 'playbackSettings');
    else add(...external, others, 'retry');
    return out;
  }
  switch (c.cls) {
    case 'offline':
      add('retry');
      break;
    case 'auth':
      add(c.hasSource && c.routed && 'editSource', 'retry', others, ...external);
      break;
    case 'connectionLimit':
      // Waiting for another device to stop is the way out; the account's counts are one press away.
      add('retry', c.hasSource && c.routed && 'editSource', others);
      break;
    case 'notFound':
      if (isParentalRefusal(c.message)) add(c.routed && 'parental', 'retry');
      else if (c.live) add(others, c.zappable && 'nextChannel', 'retry', ...external);
      else add(c.refreshable && 'refreshSource', 'retry', ...external);
      break;
    case 'unsupported':
      // A format this player cannot decode will not decode on a retry either: another copy or
      // another player first.
      add(others, ...external, 'retry');
      break;
    default:
      add('retry', others, ...external);
  }
  return out;
}

/**
 * A live channel or radio station of an Xtream source on the TS stream format: its stream comes as
 * HLS once the setting says so. Movies, episodes and catch-up keep their own container whatever
 * the setting, so they get the external player or the link instead.
 */
function xtreamOnTs(source: PlayerSource | undefined, settings: Settings | null): boolean {
  const ref = source?.ref;
  if (!source || !ref || !source.isLive || (ref.contentType !== 'live' && ref.contentType !== 'radio')) return false;
  return knownSourceKind(ref.sourceId) === 'xtream' && settings?.streamFormat === 'ts';
}

/**
 * The hint for raw MPEG-TS a browser without Media Source Extensions cannot play, naming only
 * what the screen offers: Play as HLS on an Xtream source, the link for VLC or MPV, else the
 * desktop app, and another source while `others` are offered. The desktop always has MSE; its
 * words stay for completeness.
 */
export function rawTsHintKey(source: PlayerSource | undefined, settings: Settings | null, external: ExternalRoute, others: boolean): string {
  if (xtreamOnTs(source, settings)) return 'errorTsXtream';
  return external === 'none' ? hintWithoutOthers('errorTsBrowser', others) : external === 'link' ? 'errorTsLink' : 'errorTsLive';
}

/** The context for the current failure, read from the stores. */
function useActionContext(view: StreamErrorView, source: PlayerSource | undefined, rawTs: boolean, menu: boolean): ErrorActionContext {
  const message = usePlayerStore((s) => s.error);
  const zappable = usePlayerStore((s) => canZap(s));
  const settings = usePlayerSettings();
  const routed = useInRouterContext();
  const sourceId = source?.ref?.sourceId;
  // A pasted playlist has nothing to fetch again (when the lookup cached the source to tell).
  const pasted = sourceId ? queryClient.getQueryData<Source>(rpcKey('sources.get', { id: sourceId }))?.m3u?.origin === 'text' : false;
  return {
    cls: view.cls,
    message,
    live: !!source?.isLive,
    hasMedia: !!source?.url,
    external: view.external,
    alternates: view.others,
    menu,
    zappable,
    refreshable: !!sourceId && !pasted,
    hasSource: !!sourceId,
    rawTs,
    rawTsXtream: rawTs && xtreamOnTs(source, settings),
    routed,
  };
}

/** Out of fullscreen and the PiP window before a page opens: the page is what the action is for. */
function leavePlayerView(): void {
  const s = usePlayerStore.getState();
  if (s.isFullscreen) s.toggleFullscreen();
  if (s.isWindowFilled) s.toggleWindowFill();
  if (usePipStore.getState().active) void exitPip();
}

/**
 * The Xtream stream format to HLS, then the channel again: its stream URL follows the setting.
 * The channel is the one on screen at the press; a Stop or another play while the setting is
 * saved keeps what the user chose (replayFromRef).
 */
async function playAsHls(failedTitle: string): Promise<void> {
  const from = recoveryPoint();
  try {
    const next = await rpc('settings.update', { patch: { streamFormat: 'm3u8' } });
    setSettingsCache(next);
  } catch (err) {
    toast({ title: failedTitle, description: errorDescription(err), variant: 'error' });
    return;
  }
  await replayFromRef(from);
}

/**
 * Imports the item's source again, then looks the item up anew (a moved stream gets its new URL).
 * An import takes a while: the item is the one on screen at the press, and a Stop or another play
 * meanwhile cancels the replay.
 */
async function refreshSource(sourceId: string, failedTitle: string): Promise<void> {
  const from = recoveryPoint();
  try {
    await rpc('sources.refresh', { id: sourceId });
  } catch (err) {
    toast({ title: failedTitle, description: errorDescription(err), variant: 'error' });
    return;
  }
  await replayFromRef(from);
}

/** The first `max` actions; with `keepRetry` and room for two, Retry takes the last place if it was cut. */
export function firstActions(ids: ErrorActionId[], max: number, keepRetry: boolean): ErrorActionId[] {
  const head = ids.slice(0, max);
  if (!keepRetry || max < 2 || head.includes('retry') || !ids.includes('retry')) return head;
  return [...head.slice(0, max - 1), 'retry'];
}

export interface ErrorActionsProps {
  view: StreamErrorView;
  source: PlayerSource | undefined;
  onRetry(): void;
  /** Desktop: MPV or VLC takes the stream (InlinePlayer owns the launch and its toasts). */
  onOpenExternal?(player: 'mpv' | 'vlc'): void;
  /** Browser: the stream's link, for VLC or MPV elsewhere. */
  onCopyLink?(): void;
  size: GlassButtonSize;
  /** At most this many buttons (a short player, the mpv strip); the primary always stays. */
  max?: number;
  /**
   * Retry stays among the `max` buttons, in the last place when better steps lead: this panel is
   * the only place it is offered (the overlay's bar leaves it to the panel).
   */
  keepRetry?: boolean;
  /** Raw MPEG-TS the browser cannot play (no MSE). */
  rawTs?: boolean;
  /** The bar under this has Playback options (default): Other sources opens it. */
  menu?: boolean;
  /** The primary button, which takes focus when the player has it. */
  primaryRef?: Ref<HTMLButtonElement>;
  /** Extra buttons after these (the mpv strip's "Use the built-in player"). */
  children?: ReactNode;
  className?: string;
}

export function ErrorActions({
  view,
  source,
  onRetry,
  onOpenExternal,
  onCopyLink,
  size,
  max,
  keepRetry = false,
  rawTs = false,
  menu = true,
  primaryRef,
  children,
  className,
}: ErrorActionsProps) {
  const ctx = useActionContext(view, source, rawTs, menu);
  let ids = errorActionIds({
    ...ctx,
    // A launcher the caller does not wire up is not offered.
    external: (ctx.external === 'app' && !onOpenExternal) || (ctx.external === 'link' && !onCopyLink) ? 'none' : ctx.external,
  });
  const shown = max === undefined ? ids : firstActions(ids, max, keepRetry);
  return (
    <div data-testid="error-actions" className={className}>
      {shown.map((id, i) =>
        ctx.routed && (id === 'editSource' || id === 'playbackSettings' || id === 'parental') ? (
          <RouteAction key={id} id={id} source={source} size={size} primary={i === 0} buttonRef={i === 0 ? primaryRef : undefined} />
        ) : (
          <Action
            key={id}
            id={id}
            source={source}
            size={size}
            primary={i === 0}
            buttonRef={i === 0 ? primaryRef : undefined}
            onRetry={onRetry}
            onOpenExternal={onOpenExternal}
            onCopyLink={onCopyLink}
          />
        ),
      )}
      {children}
    </div>
  );
}

interface ActionProps {
  id: ErrorActionId;
  source: PlayerSource | undefined;
  size: GlassButtonSize;
  primary: boolean;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}

/** An action that stays in the player. */
function Action({
  id,
  source,
  size,
  primary,
  buttonRef,
  onRetry,
  onOpenExternal,
  onCopyLink,
}: ActionProps & Pick<ErrorActionsProps, 'onRetry' | 'onOpenExternal' | 'onCopyLink'>) {
  const { t } = useTranslation('player');
  const [busy, setBusy] = useState(false);
  const run = (work: () => Promise<void>): void => {
    if (busy) return;
    setBusy(true);
    void work().finally(() => setBusy(false));
  };
  let icon: ReactNode;
  let label: string;
  let onClick: () => void;
  switch (id) {
    case 'refreshSource':
      icon = <RefreshCw aria-hidden className={busy ? 'motion-safe:animate-spin' : undefined} />;
      label = t('errorActionRefreshSource');
      onClick = () => {
        const sourceId = source?.ref?.sourceId;
        if (sourceId) run(() => refreshSource(sourceId, t('errorRefreshFailed')));
      };
      break;
    case 'playAsHls':
      icon = <Play aria-hidden className="fill-current" />;
      label = t('errorActionPlayAsHls');
      onClick = () => run(() => playAsHls(t('errorStreamFormatFailed')));
      break;
    case 'otherSources':
      icon = <Layers aria-hidden />;
      label = t('errorActionOtherSources');
      // The options menu's list of the channel's other copies: the user picks one.
      onClick = () => useMediaStore.setState({ sourcesMenuAt: Date.now() });
      break;
    case 'nextChannel':
      icon = <SkipForward aria-hidden className="fill-current" />;
      label = t('nextChannel');
      onClick = () => void zap('down').catch(() => undefined);
      break;
    case 'openMpv':
    case 'openVlc':
      icon = <ExternalLink aria-hidden />;
      label = id === 'openMpv' ? t('openInMpv') : t('openInVlc');
      onClick = () => onOpenExternal?.(id === 'openMpv' ? 'mpv' : 'vlc');
      break;
    case 'copyLink':
      icon = <Copy aria-hidden />;
      label = t('copyStreamLink');
      onClick = () => onCopyLink?.();
      break;
    default:
      icon = <RotateCcw aria-hidden />;
      label = t('retry');
      onClick = onRetry;
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      data-action={id}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      onClick={onClick}
      className={glassButton(primary ? 'primary' : 'secondary', size)}
    >
      {icon}
      {label}
    </button>
  );
}

/** An action that opens a page of the app: out of fullscreen first. */
function RouteAction({ id, source, size, primary, buttonRef }: ActionProps) {
  const { t } = useTranslation('player');
  const navigate = useNavigate();
  const sourceId = source?.ref?.sourceId ?? '';
  const [to, label, icon] =
    id === 'editSource'
      ? // `?account=` opens the source's subscription details (its login and connections), or its settings.
        [`/sources?account=${encodeURIComponent(sourceId)}`, t('errorActionEditSource'), <Pencil key="i" aria-hidden />]
      : id === 'parental'
        ? ['/settings/parental', t('errorActionParental'), <Lock key="i" aria-hidden />]
        : ['/settings/playback', t('errorActionPlaybackSettings'), <Settings2 key="i" aria-hidden />];
  return (
    <button
      ref={buttonRef}
      type="button"
      data-action={id}
      onClick={() => {
        leavePlayerView();
        navigate(to);
      }}
      className={glassButton(primary ? 'primary' : 'secondary', size)}
    >
      {icon}
      {label}
    </button>
  );
}
