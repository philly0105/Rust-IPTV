/**
 * Transient media details the unified controls render: tracks, buffered ranges,
 * rate, PiP, embedded-mpv state, up-next countdown, failover undo, OSD.
 * Kept out of the C8 store so its shape stays exactly as contracted.
 */

import { create } from 'zustand';

import type { MpvState, PlayerExternalEvent, PlayerSource, RpcErrorCode } from '@/api/types';

import { EMPTY_TRACKS, type EngineTracks } from './engines';

export interface TimeRange {
  start: number;
  end: number;
}

export interface MediaCommands {
  setQuality(id: string | 'auto'): void;
  setAudio(id: string): void;
  setText(id: string | null): void;
  setRate(rate: number): void;
  togglePip(): void;
  retry(): void;
}

export interface ExternalRun {
  player: PlayerExternalEvent['player'];
  title: string;
  pid?: number;
  startedAt: number;
}

export interface MediaState {
  tracks: EngineTracks;
  buffered: TimeRange[];
  /** Live window; `end` is the live edge. */
  seekable?: TimeRange;
  rate: number;
  captionsOn: boolean;
  canPip: boolean;
  inPip: boolean;
  waiting: boolean;
  mpv?: MpvState;
  /** Embedded mpv: when the current `mpv.record` began (ms epoch), for the REC timer. */
  recordStartedAt?: number;
  upNext?: { source: PlayerSource; deadline: number };
  /**
   * `at`: when it was raised (ms epoch), so chrome that mounts a moment later still shows it.
   * `locked`: a zap passing a locked channel (parental Ask mode); drawn with a lock glyph.
   */
  osd?: { primary: string; secondary?: string; key: number; at?: number; locked?: boolean };
  channelPanelOpen: boolean;
  externalRuns: ExternalRun[];
  commands: MediaCommands | null;
  /** Shift+C asked the control bar to open its Subtitles submenu (ms epoch); the bar clears it. */
  subtitleMenuAt?: number;
  /** The error screen's "Other sources" asked the bar for its Alternate sources view (ms epoch); the bar clears it. */
  sourcesMenuAt?: number;
  /**
   * The RPC error code behind the current `status: 'error'`, when the failure came from the
   * core (resolving a stream URL, `mpv.load`). Classifies the error copy before message matching.
   */
  errorCode?: RpcErrorCode;
  /**
   * The browser refused to start with sound (no gesture yet: a reload restoring playback), so the
   * player started muted (PL-MUTED-AUTOPLAY). The surface offers "Tap to unmute" until sound is
   * back. Not reset with the media: the mute it forced lasts across zaps until then.
   */
  autoMuted?: boolean;
}

export const useMediaStore = create<MediaState>()(() => ({
  tracks: EMPTY_TRACKS,
  buffered: [],
  rate: 1,
  captionsOn: false,
  canPip: false,
  inPip: false,
  waiting: false,
  channelPanelOpen: false,
  externalRuns: [],
  commands: null,
}));

export function setMediaCommands(c: MediaCommands | null): () => void {
  useMediaStore.setState({ commands: c });
  return () => {
    if (useMediaStore.getState().commands === c) useMediaStore.setState({ commands: null });
  };
}

export function resetMedia(): void {
  useMediaStore.setState({
    tracks: EMPTY_TRACKS,
    buffered: [],
    seekable: undefined,
    rate: 1,
    inPip: false,
    waiting: false,
    upNext: undefined,
    errorCode: undefined,
  });
}

let osdKey = 0;
export function showOsd(primary: string, secondary?: string, opts?: { locked?: boolean }): void {
  const at = Date.now();
  const osd: NonNullable<MediaState['osd']> = secondary ? { primary, secondary, key: ++osdKey, at } : { primary, key: ++osdKey, at };
  if (opts?.locked) osd.locked = true;
  useMediaStore.setState({ osd });
}

export const UP_NEXT_SECONDS = 10;
