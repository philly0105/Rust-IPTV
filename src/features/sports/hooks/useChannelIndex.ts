/**
 * The channels the Sports page matches games against, built from RPCs the app already has (no core
 * changes). Per visible source: the live groups whose names look like sports, paged whole. Across every
 * source: one `catalog.search` per network alias, kept when the name really is a known network. Both read
 * through the catalog readers, so the Live TV quality filter, parental hiding, English-only and hidden
 * channels apply as on the Live page, and the 'catalog.' keys refetch after an import, a channel edit or a
 * filter change.
 */

import { useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { categoriesArgs } from '@/api/bootPrefetch';
import type { CatalogSearchResult } from '@/api/rpc';
import { rpcKey } from '@/api/query';
import { itemKey, type Category, type Channel, type ChannelQuality, type ItemKey, type Page, type Source, type SourceKind } from '@/api/types';
import { channelQuality } from '@/lib/channelQuality';
import { useVisibleSources } from '@/shell/useVisibleSources';

import {
  NETWORKS,
  affiliateMarket,
  foreignFeed,
  hasMatchup,
  isBackupFeed,
  isSportsGroup,
  isStationSpinOff,
  nameTokens,
  namesNews,
  networkIdForChannel,
  teamChannelName,
  textTokens,
} from '../lib/names';
import { sportsRead } from './sportsRead';

export interface IndexedChannel {
  channel: Channel;
  sourceId: string;
  sourceKind: SourceKind;
  sourceName: string;
  /** `nameTokens(channel.name)` */
  tokens: string[];
  /** `networkIdForChannel`, or null for an event or unknown channel and for a feed from abroad. */
  network: string | null;
  /** Read from a sports group (otherwise found by a network search). */
  fromSportsGroup: boolean;
  /** `foreignFeed`: a feed from outside North America ("BR: ESPN"), listed after the others. */
  foreign: boolean;
  /** `teamChannelName(tokens)`: the team a team channel's name leaves ("boston celtics"), or null. */
  teamName: string | null;
  /** `isBackupFeed`: a backup feed or SD copy ("ESPN (Backup)"), listed after the main feeds. */
  backup: boolean;
  /**
   * `affiliateMarket`: for a broadcast network's channel, the words that place it in a local market (empty
   * for the network's own feed); null for any other channel. Rows built without it count as null.
   */
  affiliate?: string[] | null;
  /**
   * A station's news stream or free streaming copy (`isStationSpinOff`), or another news channel (`namesNews`):
   * it shows no game, so it matches by no network, call sign or guide (`network` is null).
   */
  spinOff: boolean;
  /** `channelQuality`: the picture quality the name gives, which orders the matches; null when it names none. */
  quality: ChannelQuality | null;
}

/** Rows per `catalog.channels` page: the core's cap. */
export const INDEX_PAGE_LIMIT = 1000;
/**
 * Sports groups of a source read at once. A big provider has dozens of them, mostly one page each, so one
 * after another they took longer than the network searches that run beside them.
 */
const GROUP_CONCURRENCY = 4;
/** Hits asked of each network search. */
export const NETWORK_SEARCH_LIMIT = 200;
/** Network searches in flight at once, so the group pages keep part of the page's read limit (sportsRead.ts). */
const NETWORK_CONCURRENCY = 3;
/** Event channels are renamed on a provider refresh, which invalidates 'catalog.' keys anyway. */
const INDEX_STALE_MS = 10 * 60_000;

/** One source's sports groups, paged whole. Under 'catalog.' so catalog events refresh it. */
export const sportsGroupsKey = (sourceId: string) => ['catalog.sportsGroups', sourceId] as const;
/** The network search hits of every source. */
export const sportsNetworksKey = ['catalog.sportsNetworks'] as const;

interface Described {
  tokens: string[];
  network: string | null;
  foreign: boolean;
  teamName: string | null;
  backup: boolean;
  affiliate: string[] | null;
  spinOff: boolean;
  quality: ChannelQuality | null;
}

const described = new WeakMap<Channel, Described>();

/** Tokens, network, origin, team and quality of a channel row, kept per row: a refetch with unchanged rows keeps the objects. */
function describe(channel: Channel): Described {
  let d = described.get(channel);
  if (!d) {
    const tokens = nameTokens(channel.name);
    const foreign = foreignFeed(channel.name, channel.categoryName);
    // A feed from abroad is not the US network of its name ("BR: ESPN", "AU| FOX FOOTY").
    let network: string | null = null;
    let affiliate: string[] | null = null;
    let spinOff = false;
    if (!foreign) {
      network = networkIdForChannel(tokens);
      let read: readonly string[] = tokens;
      // The cut tag may be a service's ("ESPN+ | Texas vs Georgia") or a slot's league word ("NFL | 02 - ESPN").
      if (network === null) {
        const all = textTokens(channel.name);
        if (all.length !== tokens.length) {
          network = networkIdForChannel(all);
          read = all;
        }
      }
      // A station's news stream or free streaming copy shows no game ("PRIME: FOX 5 NEW YORK"), and neither
      // does a news channel no network took, whatever call sign it names ("US: CBS NEWS PHOENIX (KPHO)").
      spinOff = network !== null ? isStationSpinOff(network, channel.name, channel.categoryName) : namesNews(tokens);
      if (spinOff) network = null;
      if (network !== null) affiliate = affiliateMarket(read);
    }
    d = {
      tokens,
      network,
      foreign,
      teamName: teamChannelName(tokens),
      backup: isBackupFeed(channel.name),
      affiliate,
      spinOff,
      quality: channelQuality(channel.name),
    };
    described.set(channel, d);
  }
  return d;
}

/**
 * A provider's heading row between groups of channels ("##### FOX ᴴᴰ/ᴿᴬᵂ #####", "===== NFL ====="): a
 * playlist entry with a name, but no channel, which would otherwise read as the network it names.
 */
export function isSeparatorName(name: string): boolean {
  return /^\s*[#=*~_]{3,}|[#=*~_]{3,}\s*$/.test(name);
}

/** One index row. */
export function toIndexed(channel: Channel, source: Pick<Source, 'id' | 'kind' | 'name'>, fromSportsGroup: boolean): IndexedChannel {
  const { tokens, network, foreign, teamName, backup, affiliate, spinOff, quality } = describe(channel);
  return {
    channel,
    sourceId: source.id,
    sourceKind: source.kind,
    sourceName: source.name,
    tokens,
    network,
    fromSportsGroup,
    foreign,
    teamName,
    backup,
    affiliate,
    spinOff,
    quality,
  };
}

/**
 * The channels of a source's sports groups. The groups come from the Live page's own `catalog.categories`
 * query (shown and hidden in one answer), and hidden ones are skipped here: `catalog.channels` with a
 * `categoryId` would list a hidden group's channels. Up to {@link GROUP_CONCURRENCY} groups are read at once,
 * each group's pages in order, and the rows come back in the groups' order, so the index is the same as read
 * one group after another.
 */
async function loadSportsGroups(client: QueryClient, sourceId: string, signal: AbortSignal): Promise<Channel[]> {
  const args = categoriesArgs(sourceId, 'live');
  const categories = await client.fetchQuery({
    queryKey: rpcKey('catalog.categories', args),
    queryFn: async ({ signal: s }) => (await sportsRead('catalog.categories', args, s)) as Category[],
  });
  const groups = categories.filter((g) => !g.hidden && g.itemCount !== 0 && isSportsGroup(g.name));
  const lists: Channel[][] = [];
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < groups.length && !failed) {
      const i = next++;
      const rows: Channel[] = [];
      for (let offset = 0; ; ) {
        const query = { offset, limit: INDEX_PAGE_LIMIT };
        const page = (await sportsRead('catalog.channels', { sourceId, categoryId: groups[i]!.id, query }, signal)) as Page<Channel>;
        if (failed) return;
        rows.push(...page.items);
        offset += page.items.length;
        if (page.items.length === 0 || offset >= page.total) break;
      }
      lists[i] = rows;
    }
  };
  // One failed page fails the source; the other workers stop instead of reading on for nothing.
  await Promise.all(
    Array.from({ length: Math.min(GROUP_CONCURRENCY, groups.length) }, () =>
      worker().catch((e: unknown) => {
        failed = true;
        throw e;
      }),
    ),
  );
  return lists.flat();
}

/**
 * Network channels from every source: each distinct alias search once, a few at a time. A hit stays when its
 * name is a known network ("ESPN" also finds ESPN2 and ESPNews, kept under their own ids) or a matchup ("ESPN |
 * Knicks @ Celtics", an event channel); the rest is dropped. One failed search leaves the others; only when all
 * fail does the load fail.
 */
async function loadNetworkChannels(signal: AbortSignal): Promise<Channel[]> {
  const queries = [...new Set(NETWORKS.map((n) => n.search))];
  const answers: Channel[][] = [];
  let failure: unknown = null;
  let next = 0;
  const worker = async () => {
    while (next < queries.length) {
      const i = next++;
      const args = { query: queries[i]!, contentTypes: ['live'], limit: NETWORK_SEARCH_LIMIT };
      try {
        const res = (await sportsRead('catalog.search', args, signal)) as CatalogSearchResult;
        answers[i] = res.live.filter((ch) => {
          const d = describe(ch);
          return !ch.isRadio && (d.network !== null || hasMatchup(d.tokens));
        });
      } catch (e) {
        if (signal.aborted) throw e;
        failure ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: NETWORK_CONCURRENCY }, worker));
  if (failure !== null && answers.every((a) => a === undefined)) throw failure;
  return answers.flat();
}

interface GroupAnswers {
  lists: (Channel[] | undefined)[];
  pending: boolean;
  error: unknown;
}

// Module-level, so useQueries re-runs it only when an answer changes.
function combineGroups(results: UseQueryResult<Channel[]>[]): GroupAnswers {
  return {
    lists: results.map((r) => r.data),
    pending: results.some((r) => r.isPending),
    error: results.find((r) => r.error)?.error ?? null,
  };
}

/** Sports-group rows then network rows, source by source in the sources' order; the first row of a channel wins. */
function buildIndex(
  sources: readonly Source[],
  lists: readonly (Channel[] | undefined)[],
  networks: readonly Channel[] | undefined,
): IndexedChannel[] {
  const bySource = new Map<string, Channel[]>();
  for (const ch of networks ?? []) {
    const list = bySource.get(ch.ref.sourceId) ?? [];
    list.push(ch);
    bySource.set(ch.ref.sourceId, list);
  }
  const out: IndexedChannel[] = [];
  const seen = new Set<ItemKey>();
  const add = (ch: Channel, source: Source, fromSportsGroup: boolean) => {
    const key = itemKey(ch.ref);
    if (seen.has(key) || isSeparatorName(ch.name)) return;
    seen.add(key);
    out.push(toIndexed(ch, source, fromSportsGroup));
  };
  sources.forEach((source, i) => {
    for (const ch of lists[i] ?? []) add(ch, source, true);
    for (const ch of bySource.get(source.id) ?? []) add(ch, source, false);
  });
  return out;
}

const NO_SOURCES: Source[] = [];

/**
 * The sports channel index of every visible source. `loading` until each part has answered once (rows
 * appear as parts arrive); `error` is the first failure, with the other parts' rows still listed.
 */
export function useChannelIndex(enabled = true): { channels: IndexedChannel[]; loading: boolean; error: unknown } {
  const client = useQueryClient();
  const sources = useVisibleSources();
  const list = sources.data ?? NO_SOURCES;
  const groups = useQueries({
    queries: list.map((s) => ({
      queryKey: sportsGroupsKey(s.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => loadSportsGroups(client, s.id, signal),
      staleTime: INDEX_STALE_MS,
      enabled,
    })),
    combine: combineGroups,
  });
  const networks = useQuery({
    queryKey: sportsNetworksKey,
    queryFn: ({ signal }) => loadNetworkChannels(signal),
    staleTime: INDEX_STALE_MS,
    enabled: enabled && list.length > 0,
  });
  const channels = useMemo(() => buildIndex(list, groups.lists, networks.data), [list, groups.lists, networks.data]);
  const loading = enabled && (sources.isPending || groups.pending || (list.length > 0 && networks.isPending));
  return { channels, loading, error: sources.error ?? groups.error ?? networks.error ?? null };
}
