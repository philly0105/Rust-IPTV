/**
 * Transient media details the unified controls render: tracks, buffered ranges,
 * rate, PiP, embedded-mpv state, up-next countdown, failover undo, OSD.
 * Kept out of the C8 store so its shape stays exactly as contracted.
 */

import { create } from 'zustand';

import type { MpvState, PlayerExternalEvent, PlayerSource } from '@/api/types';

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
  upNext?: { source: PlayerSource; deadline: number };
  osd?: { primary: string; secondary?: string; key: number };
  channelPanelOpen: boolean;
  externalRuns: ExternalRun[];
  commands: MediaCommands | null;
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
  });
}

let osdKey = 0;
export function showOsd(primary: string, secondary?: string): void {
  useMediaStore.setState({ osd: secondary ? { primary, secondary, key: ++osdKey } : { primary, key: ++osdKey } });
}

export const UP_NEXT_SECONDS = 10;
