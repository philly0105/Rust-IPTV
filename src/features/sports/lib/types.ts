/**
 * Games on the Sports page, normalized from ESPN's scoreboard (lib/espn.ts). One `Game` per event; times are
 * UTC milliseconds, and `etDate` is the US Eastern day ESPN files the game under.
 */

export type League = 'nfl' | 'cfb' | 'nba' | 'mlb';

export const LEAGUES: readonly League[] = ['nfl', 'cfb', 'nba', 'mlb'];

export type GamePhase = 'scheduled' | 'live' | 'final' | 'postponed' | 'canceled' | 'suspended';

export interface GameTeam {
  id: string;
  abbreviation: string;
  displayName: string;
  shortDisplayName: string;
  /** Nickname ("Celtics"); for college teams the mascot ("Crimson Tide"). */
  name: string;
  /** City or school ("Boston", "Alabama"). */
  location: string;
  logo: string | null;
  /** Hex without '#'. */
  color: string | null;
  /** Null before the start and for postponed or canceled games. */
  score: number | null;
  winner: boolean | null;
  /** Overall record ("4-2"). */
  record: string | null;
  /** College poll rank 1-25. */
  rank: number | null;
}

export interface GameBroadcast {
  name: string;
  market: 'national' | 'home' | 'away';
  kind: 'tv' | 'streaming' | 'unknown';
}

export interface Game {
  /** `${league}:${id}` */
  key: string;
  id: string;
  league: League;
  /** 'YYYY-MM-DD', the US Eastern day ESPN lists the game under. */
  etDate: string;
  startMs: number;
  /** False when the start time is still TBD (ESPN then dates it at midnight Eastern). */
  timeValid: boolean;
  /** A kickoff window note such as "FLEX: 3:30 - 4:30pm OR 6 - 8pm ET start". */
  timeNote: string | null;
  state: 'pre' | 'in' | 'post';
  phase: GamePhase;
  detail: string;
  shortDetail: string;
  period: number;
  displayClock: string;
  /** 1 preseason, 2 regular season, 3 postseason, 5 play-in. */
  seasonType: number;
  week: number | null;
  home: GameTeam;
  away: GameTeam;
  neutralSite: boolean;
  venue: string | null;
  note: string | null;
  /** MLB/NBA playoff series line ("CLE leads series 2-1"). */
  seriesSummary: string | null;
  broadcasts: GameBroadcast[];
  gamecastUrl: string | null;
  /** While a football game is on: ESPN's down and distance ("2nd & 7 at NO 35"). Absent otherwise. */
  situation?: string;
}
