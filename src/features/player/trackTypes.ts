/**
 * The track lists an engine reports, apart from the engines: the media store holds them from the
 * start, and importing them from `./engines` put all the engine code in the store's chunk.
 */

export interface TrackOption {
  id: string;
  label: string;
  selected: boolean;
}

export interface EngineTracks {
  /** Video renditions; only reported when there is more than one. `auto` is implied. */
  qualities: TrackOption[];
  qualityAuto: boolean;
  audio: TrackOption[];
  text: TrackOption[];
}

export const EMPTY_TRACKS: EngineTracks = { qualities: [], qualityAuto: true, audio: [], text: [] };
