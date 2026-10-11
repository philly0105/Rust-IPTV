/**
 * Where the e2e servers live. playwright.config.ts starts both:
 * iptv-mock on E2E_MOCK_PORT (7290) and iptv-server on E2E_PORT (7180).
 */
export const SERVER_PORT = Number(process.env['E2E_PORT'] ?? 7180);
export const MOCK_PORT = Number(process.env['E2E_MOCK_PORT'] ?? 7290);
export const SERVER = `http://127.0.0.1:${SERVER_PORT}`;
export const MOCK = `http://127.0.0.1:${MOCK_PORT}`;

/** Mock portal coordinates (SPEC C13; crates/iptv-mock/src/lib.rs). */
export const XTREAM = {
  serverUrl: `${MOCK}/xtream`,
  username: 'demo',
  password: 'secret',
} as const;

/** The only MAC the mock Stalker portal accepts (iptv-fixtures backup manifest, iptv-mock docs). */
export const STALKER_MAC = '00:1A:79:00:00:01';
export const STALKER = {
  portalUrl: `${MOCK}/stalker/c/`,
  macAddress: STALKER_MAC,
} as const;

export const M3U_URL = `${MOCK}/m3u/sample.m3u`;

/** Catalog facts the specs rely on (crates/iptv-mock/src/catalog.rs). */
export const MOCK_FACTS = {
  /** sample.m3u: 25 entries, one of them radio. `channelCount` is live only; radio is `radioCount`. */
  m3uChannels: 24,
  m3uRadio: 1,
  m3uGroups: ['News', 'Sports', 'Entertainment', 'Music'],
  /** Xtream live streams: 40, one of them radio (Classic FM). */
  xtreamLive: 39,
  xtreamRadio: 1,
  xtreamMovies: 30,
  xtreamSeries: 10,
  /** First Xtream movie: id 201, 60 s sample.mp4. */
  firstMovie: { id: '201', title: 'Black Harbor' },
  firstSeries: { id: '301', title: 'Harbor Lights' },
  /** sample.mp4 duration in seconds. */
  sampleMp4Seconds: 60,
} as const;
