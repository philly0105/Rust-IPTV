/**
 * Series recording rules on the Scheduled page (Run 2 C5): every rule with
 * its channel, the next airing it scheduled, a pause switch and Remove (which
 * asks whether to cancel the recordings the rule already scheduled).
 */

import { CalendarRange, Repeat, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import type { RecordingRule } from '@/api/types';
import { buttonClass, cn, EmptyState, ErrorState, IconButton, SkeletonList, Toggle } from '@/ui';

import { useRecordingRules, useRuleActions } from '../hooks';
import { sortRules } from '../lib/rules';
import { airingLabel } from '../lib/schedule';
import { RemoveRuleDialog } from './SeriesDialogs';

export function RecordingRulesPanel() {
  const { t } = useTranslation('guide');
  const rules = useRecordingRules();
  const [removing, setRemoving] = useState<RecordingRule | null>(null);
  const list = useMemo(() => sortRules(rules.data), [rules.data]);
  const headingId = useId();

  let body;
  if (rules.isLoading) {
    body = <SkeletonList rows={2} className="p-2" />;
  } else if (rules.error) {
    body = <ErrorState size="inline" error={rules.error} retrying={rules.isFetching} onRetry={() => void rules.refetch()} />;
  } else if (list.length === 0) {
    body = (
      <EmptyState
        size="inline"
        icon={<Repeat size={20} aria-hidden />}
        title={t('rulesEmpty')}
        description={t('rulesEmptyHint')}
        action={
          <Link to="/epg" className={buttonClass('secondary', 'sm')}>
            <CalendarRange size={16} aria-hidden />
            {t('openGuide')}
          </Link>
        }
      />
    );
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-divider" aria-labelledby={headingId}>
        {list.map((r) => (
          <RuleRow key={r.id} rule={r} onRemove={() => setRemoving(r)} />
        ))}
      </ul>
    );
  }

  return (
    <section aria-labelledby={headingId} data-testid="recording-rules" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-3">
        <h2 id={headingId} className="text-title-sm text-fg">
          {t('rulesTitle')}
        </h2>
        {rules.data ? <span className="text-body-sm tabular-nums text-fg-subtle">{list.length}</span> : null}
      </div>
      <div className="overflow-hidden rounded-lg border border-edge bg-surface">{body}</div>
      <RemoveRuleDialog rule={removing} onClose={() => setRemoving(null)} />
    </section>
  );
}

function RuleRow({ rule, onRemove }: { rule: RecordingRule; onRemove: () => void }) {
  const { t, i18n } = useTranslation('guide');
  const { setRuleEnabled } = useRuleActions();
  // Shown at once; the list refetch confirms it, a failure puts it back.
  const [pending, setPending] = useState<boolean | null>(null);
  const enabled = pending ?? rule.enabled;
  const next = rule.nextStart ? Date.parse(rule.nextStart) : NaN;
  // Worded like the Upcoming list below it ("today 02:45 AM"), so the same airing reads the same.
  const when = Number.isFinite(next) ? airingLabel(next, Date.now(), i18n.language) : undefined;

  const toggle = async (on: boolean) => {
    setPending(on);
    await setRuleEnabled(rule, on);
    setPending(null);
  };

  return (
    <li className="flex items-center gap-3 px-4 py-3 sm:gap-4" data-testid="rule-row" data-rule-id={rule.id} data-enabled={enabled ? '' : undefined}>
      {/* A neutral glyph: red read as an error, and the switch already says whether the rule is on. */}
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        <Repeat size={16} className={enabled ? 'text-fg-muted' : 'text-fg-subtle'} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span dir="auto" className={cn('truncate text-body-sm font-medium', enabled ? 'text-fg' : 'text-fg-muted')}>
          {rule.title}
        </span>
        <span className="flex min-w-0 flex-wrap gap-x-3 text-caption text-fg-muted">
          <span dir="auto" className="max-w-full truncate">
            {rule.channelName}
          </span>
          {!enabled ? (
            <span className="shrink-0 text-warning">{t('rulePaused')}</span>
          ) : when ? (
            <span className="shrink-0 tabular-nums">{t('ruleNext', { when })}</span>
          ) : (
            <span className="shrink-0">{t('ruleNoneScheduled')}</span>
          )}
          {rule.upcoming > 0 ? <span className="shrink-0 tabular-nums text-fg-subtle">{t('ruleUpcoming', { n: rule.upcoming })}</span> : null}
        </span>
      </div>
      <Toggle checked={enabled} onChange={(on) => void toggle(on)} disabled={pending !== null} hideLabel label={t('ruleToggle', { title: rule.title })} />
      <IconButton label={t('removeRuleFor', { title: rule.title })} icon={<Trash2 size={16} aria-hidden />} onClick={onRemove} data-testid="rule-remove" />
    </li>
  );
}
