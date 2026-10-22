/** All, NFL, College Football, NBA, MLB: pill tabs that pick the leagues every section shows. */

import { useTranslation } from 'react-i18next';

import { Tabs } from '../deps';
import { LEAGUES, type League } from '../lib/types';

export const LEAGUE_KEYS: Record<League, string> = { nfl: 'leagueNfl', cfb: 'leagueCfb', nba: 'leagueNba', mlb: 'leagueMlb' };

const ALL = 'all';

export function LeagueFilter({ value, onChange }: { value: League | null; onChange(next: League | null): void }) {
  const { t } = useTranslation('sports');
  return (
    <div data-testid="sports-leagues" className="max-w-full self-start">
      {/* Five pills are wider than a phone in most languages, and pill tabs scroll with no fade or
          scrollbar, so the row wraps instead of hiding its last leagues. */}
      <Tabs
        variant="pill"
        className="flex-wrap"
        label={t('leagues')}
        value={value ?? ALL}
        onChange={(id) => onChange(LEAGUES.find((l) => l === id) ?? null)}
        items={[{ id: ALL, label: t('leagueAll') }, ...LEAGUES.map((l) => ({ id: l, label: t(LEAGUE_KEYS[l]) }))]}
      />
    </div>
  );
}
