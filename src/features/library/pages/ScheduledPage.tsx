/**
 * /scheduled: guide reminders and scheduled recordings. Recordings writing now
 * come first (elapsed time, size, stop), then the series recording rules when
 * there are any, then everything upcoming by day, then recently finished
 * recordings with their outcome. With no rules the rules panel (an empty
 * state pointing at the guide) goes last.
 */

import { AlarmClock, Bell, CalendarRange, LoaderCircle, Square, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { invalidate } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Recording, RecordingStatus, Reminder } from '@/api/types';
import { dateTimeFormat, intlLocale } from '@/lib/intl';
import { joinList } from '@/shell/dashboard/cards';
import { buttonClass } from '@/ui/Button';
import { cn } from '@/ui/cn';

import {
  Badge,
  EmptyState,
  ErrorState,
  IconButton,
  Page,
  ProgressBar,
  RecordingRulesPanel,
  SkeletonList,
  StopRecordingDialog,
  clockDuration,
  clockTime,
  dayLabel,
  elapsedSeconds,
  finishedRecordings,
  groupByDay,
  recordingFraction,
  recordingNow,
  recordingStartedAt,
  stoppedEarly,
  upcoming,
  useCancelPending,
  useRecordingCapabilities,
  useRecordingProgress,
  useRecordings,
  useReminders,
  useRecordingRules,
  useScheduleActions,
  useToast,
  type UpcomingEntry,
  errorDescription,
} from '../deps';
import { PageTitle } from '../components/bits';
import { usePageHeader } from '../hooks/usePageHeader';
import { k } from '../lib/keys';
import { formatBytes } from '../lib/format';
import { recordingNote } from '../lib/recordingNote';

const STATUS_VARIANT: Record<RecordingStatus, 'accent' | 'neutral' | 'warning' | 'danger' | 'outline' | 'success' | 'live'> = {
  scheduled: 'neutral',
  recording: 'live',
  completed: 'success',
  failed: 'danger',
  missed: 'warning',
  cancelled: 'outline',
};

function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function timeOf(iso: string, lang: string): string {
  return clockTime(Date.parse(iso), lang);
}

/**
 * Header line: what is recording now and what is coming up, counted apart
 * ("1 recording now, 4 items coming up"); a running recording is not "coming up".
 */
export function scheduledSubtitle({
  now,
  upcoming: next,
  lang,
  t,
}: {
  now: number;
  upcoming: number;
  lang: string;
  t: (key: string, vars?: Record<string, unknown>) => string;
}): string {
  const parts: string[] = [];
  if (now > 0) parts.push(t('scheduledSummaryNow', { count: now }));
  if (next > 0 || now === 0) parts.push(t('scheduledSummary', { count: next }));
  return joinList(parts, lang);
}

export function ScheduledPage() {
  const { t, i18n } = useTranslation('library');
  const lang = i18n.language;
  const reminders = useReminders();
  const recordings = useRecordings();
  const caps = useRecordingCapabilities();
  const rules = useRecordingRules();
  // Only the day headings read the page's clock ("today", "tomorrow"); the rows recording now
  // run their own second clock (VD-7), so the page does not rebuild every row each second.
  const now = useClock(60_000);

  const title = t('scheduledTitle');
  const nowList = useMemo(() => recordingNow(recordings.data), [recordings.data]);
  const next = useMemo(() => upcoming(reminders.data, recordings.data), [reminders.data, recordings.data]);
  const done = useMemo(() => finishedRecordings(recordings.data).slice(0, 50), [recordings.data]);
  const subtitle = reminders.data && recordings.data ? scheduledSubtitle({ now: nowList.length, upcoming: next.length, lang, t }) : undefined;
  usePageHeader(title, subtitle);

  // Rules count toward loading, so the lists appear with the panel already in its place.
  const loading = reminders.isLoading || recordings.isLoading || rules.isLoading;
  const error = reminders.error ?? recordings.error;
  // Run 2 C5: series rules ("Record series" in the guide). Above Upcoming when there are any,
  // since Upcoming and Finished grow with every airing; otherwise last (also while loading, so the
  // panel's query keeps one observer: remounting it after an error would refetch and loop).
  const rulesPanel = <RecordingRulesPanel />;
  let rulesAboveUpcoming = false;
  // An empty page: its own empty state points to the guide (series included), so the rules panel's
  // empty state with a second guide button would only repeat it (L3-visual-11). The page keeps
  // observing the rules, so the panel appears with the first rule.
  let showRules = true;

  let body;
  if (loading) {
    body = <SkeletonList rows={5} className="pt-2" />;
  } else if (error) {
    body = (
      <ErrorState
        error={error}
        retrying={reminders.isFetching || recordings.isFetching}
        onRetry={() => {
          void reminders.refetch();
          void recordings.refetch();
        }}
      />
    );
  } else if (nowList.length === 0 && next.length === 0 && done.length === 0) {
    showRules = !rules.data || rules.data.length > 0;
    body = (
      <EmptyState
        icon={<AlarmClock size={28} aria-hidden />}
        title={t('scheduledEmptyTitle')}
        description={t('scheduledEmptyBody')}
        action={
          <Link to="/epg" className={buttonClass('primary', 'md')}>
            <CalendarRange size={16} aria-hidden />
            {t('scheduledOpenGuide')}
          </Link>
        }
      />
    );
  } else {
    rulesAboveUpcoming = (rules.data?.length ?? 0) > 0;
    body = (
      <div className="flex flex-col gap-8">
        {nowList.length > 0 ? (
          <Section title={t('scheduledNow')} count={nowList.length} testId="scheduled-now">
            {nowList.map((r) => (
              <RecordingNowRow key={r.id} recording={r} />
            ))}
          </Section>
        ) : null}
        {rulesAboveUpcoming ? rulesPanel : null}
        <Section
          title={t('scheduledUpcoming')}
          count={next.length}
          testId="scheduled-upcoming"
          // One grid for every day group (rows are subgrids): the time column takes the
          // widest time in the locale, so times never wrap and stay aligned.
          bodyClassName={next.length > 0 ? UPCOMING_GRID : undefined}
        >
          {next.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-muted">{t('scheduledUpcomingEmpty')}</p>
          ) : (
            groupByDay(next).map((g) => (
              <div key={g.day} role="group" aria-label={dayLabel(g.day, now, lang)} className="col-span-full grid grid-cols-subgrid">
                <p className="col-span-full bg-surface-2/50 px-4 py-1.5 text-xs font-medium text-fg-muted first-letter:uppercase">{dayLabel(g.day, now, lang)}</p>
                {g.entries.map((e) => (
                  <UpcomingRow key={`${e.type}:${e.id}`} entry={e} />
                ))}
              </div>
            ))
          )}
        </Section>
        {done.length > 0 ? (
          <Section title={t('scheduledFinished')} count={done.length} testId="scheduled-finished">
            {done.map((r) => (
              <FinishedRow key={r.id} recording={r} />
            ))}
          </Section>
        ) : null}
      </div>
    );
  }

  return (
    <Page width="default" className="flex min-w-0 flex-col gap-6 pb-8 pt-4">
      <PageTitle>{title}</PageTitle>
      {caps.data && !caps.data.supported ? (
        <p role="note" className="rounded-md border border-edge bg-surface px-4 py-3 text-sm text-fg-muted" data-testid="scheduled-no-recording">
          {t('scheduledServerNoMpv')}
        </p>
      ) : null}
      {body}
      {rulesAboveUpcoming || !showRules ? null : rulesPanel}
    </Page>
  );
}

function Section({
  title,
  count,
  testId,
  bodyClassName,
  children,
}: {
  title: string;
  count: number;
  testId: string;
  bodyClassName?: string;
  children: React.ReactNode;
}) {
  const id = `${testId}-title`;
  return (
    <section aria-labelledby={id} data-testid={testId} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3 px-1">
        <h2 id={id} className="text-title-sm text-fg">
          {title}
        </h2>
        <span className="font-display text-[calc(13rem/15)] tabular-nums text-fg-subtle">{count}</span>
      </div>
      <div className={cn('flex flex-col divide-y divide-divider overflow-hidden rounded-lg border border-edge bg-surface', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Upcoming rows: time, kind mark, title block, kind badge (from sm), cancel. */
const UPCOMING_GRID = 'grid grid-cols-[max-content_auto_minmax(0,1fr)_auto] sm:grid-cols-[max-content_auto_minmax(0,1fr)_auto_auto]';

/** Icon-button content while its action runs: a spinner in place of the icon. */
function Busy() {
  return <LoaderCircle size={16} aria-hidden className="motion-safe:animate-spin" />;
}

function RecordingNowRow({ recording: r }: { recording: Recording }) {
  const { t, i18n } = useTranslation('library');
  const now = useClock(1000);
  const live = useRecordingProgress((s) => s.byId[r.id]);
  const stopping = useCancelPending(r.id);
  const [confirm, setConfirm] = useState(false);
  const name = r.title ?? r.channelName;
  const bytes = live?.bytes ?? r.bytes;
  const elapsed = elapsedSeconds(r, now);
  const reconnecting = r.errorCode === 'reconnecting';
  return (
    <div className="flex items-center gap-4 px-4 py-3" data-testid="recording-now-row" data-recording-id={r.id}>
      <span aria-hidden className="block size-2.5 shrink-0 rounded-full bg-live motion-safe:animate-pulse" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span dir="auto" className="truncate text-sm font-medium text-fg">
            {name}
          </span>
          {r.title ? (
            <span dir="auto" className="hidden truncate text-[calc(13rem/15)] text-fg-muted sm:inline">
              {r.channelName}
            </span>
          ) : null}
        </div>
        {/* Measured from when this recording began writing, in step with the elapsed clock. */}
        <ProgressBar value={recordingFraction(r, now) * 100} tone="accent" label={t('scheduledProgressFor', { title: name })} />
        <div className="flex min-w-0 items-center gap-3 text-xs text-fg-muted">
          <span className="font-numeric tabular-nums text-fg">{clockDuration(elapsed)}</span>
          <span className="font-display tabular-nums">{formatBytes(bytes, i18n.language)}</span>
          <span className="tabular-nums">{t('scheduledUntil', { time: timeOf(new Date(Date.parse(r.end) + r.paddingAfterMinutes * 60_000).toISOString(), i18n.language) })}</span>
          {reconnecting ? <span className="truncate text-warning">{t('scheduledReconnecting')}</span> : null}
        </div>
      </div>
      <IconButton
        label={t('scheduledStop', { title: name })}
        icon={stopping ? <Busy /> : <Square size={16} aria-hidden />}
        disabled={stopping}
        aria-busy={stopping || undefined}
        onClick={() => setConfirm(true)}
        data-testid="recording-stop"
      />
      <StopRecordingDialog recording={confirm ? r : null} onClose={() => setConfirm(false)} />
    </div>
  );
}

function UpcomingRow({ entry }: { entry: UpcomingEntry }) {
  const { t, i18n } = useTranslation('library');
  const { toast } = useToast();
  const actions = useScheduleActions();
  const lang = i18n.language;
  const isReminder = entry.type === 'reminder';
  const item: Reminder | Recording = isReminder ? entry.reminder : entry.recording;
  const name = (isReminder ? entry.reminder.title : entry.recording.title) ?? item.channelName;
  const range = `${timeOf(item.start, lang)}–${timeOf(item.end, lang)}`;
  const cancelling = useCancelPending(isReminder ? undefined : entry.recording.id);
  const [removing, setRemoving] = useState(false);
  const busy = cancelling || removing;

  // VL-cancel-recording: one press cancels, so the toast carries an Undo that puts the recording (or
  // the reminder) back for the same programme. The core applies the padding from Settings again.
  const undoFailed = (e: unknown) => toast({ variant: 'error', title: t('undoFailed'), description: errorDescription(e) });
  const cancel = async () => {
    if (busy) return;
    if (entry.type === 'recording') {
      const r = entry.recording;
      const again = r.kind === 'programme' && r.status === 'scheduled' && r.title;
      await actions.cancelRecording(
        r,
        again
          ? {
              undo: {
                label: t('undo'),
                onClick: () => {
                  void actions
                    .record({ ref: r.ref, channelName: r.channelName, program: { title: r.title ?? name, start: r.start, end: r.end } })
                    .catch(undoFailed);
                },
              },
            }
          : undefined,
      );
      return;
    }
    const reminder = entry.reminder;
    setRemoving(true);
    try {
      await rpc('reminders.remove', { id: reminder.id });
      toast({
        title: t('scheduledReminderRemoved', { title: name }),
        action: {
          label: t('undo'),
          onClick: () => {
            rpc('reminders.add', { ref: reminder.ref, channelName: reminder.channelName, title: reminder.title, start: reminder.start, end: reminder.end })
              .then(() => invalidate('reminders.'))
              .catch(undoFailed);
          },
        },
      });
      // Stays pending until the refreshed list drops the row.
      await invalidate('reminders.');
    } catch (e) {
      toast({ variant: 'error', title: t('scheduledCancelFailed'), description: errorDescription(e) });
      setRemoving(false);
      void invalidate('reminders.');
    }
  };

  return (
    <div className="col-span-full grid grid-cols-subgrid items-center gap-x-4 px-4 py-3" data-testid="upcoming-row" data-kind={entry.type}>
      <span className="whitespace-nowrap font-numeric text-sm tabular-nums text-fg">{timeOf(item.start, lang)}</span>
      <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
        {/* A waiting recording gets a hollow mark; the filled live dot is for recordings writing now. */}
        {isReminder ? (
          <Bell size={16} className="text-accent" />
        ) : (
          <span className="block size-2.5 rounded-full border-2 border-fg-subtle" data-testid="upcoming-record-mark" />
        )}
      </span>
      <div className="flex min-w-0 flex-col">
        <span dir="auto" className="truncate text-sm font-medium text-fg">
          {name}
        </span>
        {/* The channel comes first and keeps its room; on a narrow row the range wraps under it. */}
        <span className="flex min-w-0 flex-wrap gap-x-3 text-xs text-fg-muted">
          <span dir="auto" className="min-w-0 max-w-full truncate">
            {item.channelName}
          </span>
          <span className="shrink-0 tabular-nums">{range}</span>
          {entry.type === 'recording' &&
          entry.recording.kind === 'programme' &&
          (entry.recording.paddingBeforeMinutes > 0 || entry.recording.paddingAfterMinutes > 0) ? (
            <span className="hidden truncate text-fg-subtle md:inline">
              {t('scheduledPadding', { before: entry.recording.paddingBeforeMinutes, after: entry.recording.paddingAfterMinutes })}
            </span>
          ) : null}
        </span>
      </div>
      <Badge variant={isReminder ? 'outline' : 'neutral'} className="hidden shrink-0 sm:inline-flex">
        {isReminder ? t('scheduledKindReminder') : t('scheduledKindWillRecord')}
      </Badge>
      <IconButton
        label={isReminder ? t('scheduledCancelReminder', { title: name }) : t('scheduledCancelRecording', { title: name })}
        icon={busy ? <Busy /> : <X size={16} aria-hidden />}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => void cancel()}
        data-testid="upcoming-cancel"
      />
    </div>
  );
}

function FinishedRow({ recording: r }: { recording: Recording }) {
  const { t, i18n } = useTranslation('library');
  const { toast } = useToast();
  const lang = i18n.language;
  const [removing, setRemoving] = useState(false);
  const name = r.title ?? r.channelName;
  // When the recording itself began: a programme joined part-way starts after the programme does.
  const when = dateTimeFormat(intlLocale(lang), { dateStyle: 'medium', timeStyle: 'short' }).format(recordingStartedAt(r));
  const early = stoppedEarly(r);
  const note = recordingNote(r, t);

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await rpc('recordings.remove', { id: r.id });
      // Stays pending until the refreshed list drops the row.
      await invalidate('recordings.');
    } catch (e) {
      toast({ variant: 'error', title: t('scheduledRemoveFailed'), description: errorDescription(e) });
      setRemoving(false);
      void invalidate('recordings.');
    }
  };

  return (
    <div className="flex items-center gap-4 px-4 py-3" data-testid="finished-row" data-status={r.status}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <span dir="auto" className="truncate text-sm font-medium text-fg">
            {name}
          </span>
          <Badge variant={early ? 'warning' : STATUS_VARIANT[r.status]} className="shrink-0" data-status={early ? 'stoppedEarly' : r.status}>
            {early ? t('recStatusStoppedEarly') : t(k('recStatus', r.status))}
          </Badge>
        </div>
        <span className="flex min-w-0 gap-3 text-xs text-fg-muted">
          {r.title ? (
            <span dir="auto" className="truncate">
              {r.channelName}
            </span>
          ) : null}
          <span className="shrink-0 tabular-nums">{when}</span>
          {r.bytes > 0 ? <span className="shrink-0 font-display tabular-nums">{formatBytes(r.bytes, lang)}</span> : null}
        </span>
        {note ? (
          <span className={cn('truncate text-xs', r.status === 'failed' ? 'text-danger' : 'text-fg-subtle')} title={r.error}>
            {note}
          </span>
        ) : null}
      </div>
      {r.status === 'completed' && r.fileNames.length > 0 ? (
        <Link to="/my-videos?filter=recordings" className={buttonClass('ghost', 'sm')}>
          {t('scheduledShowFiles')}
        </Link>
      ) : null}
      <IconButton
        label={t('scheduledRemove', { title: name })}
        icon={removing ? <Busy /> : <Trash2 size={16} aria-hidden />}
        disabled={removing}
        aria-busy={removing || undefined}
        onClick={() => void remove()}
        data-testid="finished-remove"
      />
    </div>
  );
}

export default ScheduledPage;
