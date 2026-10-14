/**
 * Series recording rules (Run 2 C5): matching a guide programme to the rule
 * that records it, the same way the core does.
 */

import { itemKey, type ItemRef, type Recording, type RecordingRule } from '@/api/types';

const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/**
 * The core's `recording::scheduler::title_key`: letters and digits only,
 * lowercased, so "News at 10!" and "NEWS AT 10" are one series.
 */
export function titleKey(title: string): string {
  let out = '';
  for (const ch of title) if (ALNUM.test(ch)) out += ch.toLowerCase();
  return out;
}

export type RuleKey = `${string}#${string}`;

export function ruleKey(ref: ItemRef, title: string): RuleKey {
  return `${itemKey(ref)}#${titleKey(title)}`;
}

/** Rules by channel and series title. Titles with no letters or digits never match a rule. */
export function buildRuleIndex(rules: readonly RecordingRule[] = []): ReadonlyMap<RuleKey, RecordingRule> {
  const out = new Map<RuleKey, RecordingRule>();
  for (const r of rules) if (titleKey(r.title)) out.set(ruleKey(r.ref, r.title), r);
  return out;
}

export function ruleFor(index: ReadonlyMap<RuleKey, RecordingRule>, ref: ItemRef | undefined, title: string): RecordingRule | undefined {
  if (!ref || !titleKey(title)) return undefined;
  return index.get(ruleKey(ref, title));
}

/** A series rule can be added for live and radio channels only (the core refuses VOD refs). */
export function canHaveRule(ref: ItemRef, title: string): boolean {
  return (ref.contentType === 'live' || ref.contentType === 'radio') && titleKey(title).length > 0;
}

/** Scheduled recordings a rule made: what "also cancel scheduled recordings" would cancel. */
export function scheduledByRule(recordings: readonly Recording[] = [], ruleId: string): number {
  let n = 0;
  for (const r of recordings) if (r.ruleId === ruleId && r.status === 'scheduled') n++;
  return n;
}

/** Rules for the Scheduled page: enabled first, then by next airing, then by title. */
export function sortRules(rules: readonly RecordingRule[] = []): RecordingRule[] {
  const next = (r: RecordingRule) => (r.nextStart ? Date.parse(r.nextStart) || Infinity : Infinity);
  return [...rules].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || next(a) - next(b) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
  );
}
