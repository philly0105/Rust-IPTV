import {
  Clapperboard,
  Film,
  FolderLock,
  KeyRound,
  ListChecks,
  Lock,
  LockOpen,
  Radio,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  Tv,
  X,
} from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { rpc, RpcError } from '@/api/transport';
import type { ContentType, ParentalLock, ParentalLockTarget, ParentalMode, ParentalStatus, Source } from '@/api/types';
import { SectionError, SectionSkeleton, Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '@/features/settings/components';
import type { SectionProps } from '@/features/settings/sections/types';
import { Badge, Button, EmptyState, ErrorState, IconButton, ProgressBar, Select, Skeleton, cn, toast } from '@/ui';

import { LockGroupsDialog, contentCounts } from './LockGroupsDialog';
import { PinDialog } from './PinDialog';
import { SetPinDialog } from './SetPinDialog';
import { UNLOCK_CHOICES, useDurationText, useLockKindText } from './labels';
import { formatCountdown } from './pin';
import { afterLockChange, applyStatus, lockNow, unlockRemainingMs, useParentalStatus } from './status';
import { formatDay, formatUntil, useNow } from './time';

type ConfigurePatch = { mode?: ParentalMode; autoAdult?: boolean; unlockMinutes?: number };

/** Lock rows shown per source before "Show all". */
const ROWS_COLLAPSED = 50;

const lockKey = (l: ParentalLock): string => `${l.sourceId}|${l.contentType}|${l.kind}|${l.targetId}|${l.createdAt}`;
const toTarget = ({ sourceId, contentType, kind, targetId, name }: ParentalLock): ParentalLockTarget => ({
  sourceId,
  contentType,
  kind,
  targetId,
  name,
});

/**
 * Settings section `parental` (C2): the PIN, Hide or Ask mode, automatic
 * adult-group locks, how long an unlock lasts, Lock now, and every lock
 * grouped by source. Settings changes and lock removals need the PIN unless
 * the session is unlocked; adding locks never does.
 */
export function ParentalSection(_props: SectionProps): JSX.Element {
  const { t } = useTranslation('parental');
  const status = useParentalStatus();

  if (status.isPending) return <SectionSkeleton />;
  if (status.error) {
    if (status.error.code === 'unsupported') {
      return (
        <SettingsSection title={t('title')} description={t('intro')} testId="settings-parental">
          <EmptyState icon={<ShieldOff aria-hidden size={28} />} title={t('unavailableTitle')} description={t('unavailableText')} />
        </SettingsSection>
      );
    }
    return <SectionError error={status.error} onRetry={() => void status.refetch()} />;
  }
  return <ParentalSettings status={status.data} />;
}

type Dialog =
  | { kind: 'setPin'; mode: 'first' | 'change' }
  | { kind: 'unlock' }
  | { kind: 'disable' }
  | { kind: 'configure'; patch: ConfigurePatch }
  | { kind: 'remove'; lock: ParentalLock; onDone: () => void }
  | { kind: 'groups'; source: Source };

function ParentalSettings({ status }: { status: ParentalStatus }) {
  const { t } = useTranslation('parental');
  const durationText = useDurationText();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [busy, setBusy] = useState<'lock' | 'config' | null>(null);
  /** Locks removed here, hidden until the list refetches. */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const close = () => setDialog(null);

  const fail = (err: unknown) => toast({ variant: 'error', title: t('saveFailed'), description: RpcError.from(err).message });

  const configure = async (patch: ConfigurePatch) => {
    if (busy === 'config') return;
    if (!status.unlocked) {
      setDialog({ kind: 'configure', patch });
      return;
    }
    setBusy('config');
    try {
      applyStatus(await rpc('parental.configure', patch));
    } catch (err) {
      // The unlock ran out in the meantime.
      if (RpcError.from(err).code === 'auth') setDialog({ kind: 'configure', patch });
      else fail(err);
    } finally {
      setBusy(null);
    }
  };

  const lockNowClick = async () => {
    setBusy('lock');
    try {
      await lockNow();
      toast({ variant: 'success', title: t('lockedNowToast') });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(null);
    }
  };

  const removeLock = async (lock: ParentalLock, onDone: () => void) => {
    if (status.enabled && !status.unlocked) {
      setDialog({ kind: 'remove', lock, onDone });
      return;
    }
    try {
      await rpc('parental.setLocked', { target: toTarget(lock), locked: false });
      lockRemoved(lock);
      onDone();
    } catch (err) {
      if (RpcError.from(err).code === 'auth' && status.enabled) setDialog({ kind: 'remove', lock, onDone });
      else fail(err);
    }
  };

  const lockRemoved = (lock: ParentalLock) => {
    setRemoved((prev) => new Set(prev).add(lockKey(lock)));
    afterLockChange();
    toast({ variant: 'success', title: t('lockRemovedToast', { name: lock.name }) });
  };

  const unlockOptions = useMemo(() => {
    const values: number[] = [...UNLOCK_CHOICES];
    if (!values.includes(status.unlockMinutes)) values.push(status.unlockMinutes);
    return values.sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b)).map((m) => ({ value: String(m), label: durationText(m) }));
  }, [status.unlockMinutes, durationText]);

  return (
    <SettingsSection title={t('title')} description={t('intro')} testId="settings-parental">
      <StatusPanel
        status={status}
        locking={busy === 'lock'}
        onSetPin={() => setDialog({ kind: 'setPin', mode: 'first' })}
        onUnlock={() => setDialog({ kind: 'unlock' })}
        onLockNow={() => void lockNowClick()}
      />

      {status.enabled ? (
        <SettingsGroup title={t('behaviourTitle')} description={status.unlocked ? undefined : t('behaviourPinNote')}>
          <SettingsRow label={t('modeLabel')} description={status.mode === 'hide' ? t('modeHideText') : t('modeAskText')}>
            {({ id }) => (
              <Segmented<ParentalMode>
                id={id}
                label={t('modeLabel')}
                value={status.mode}
                options={[
                  { value: 'hide', label: t('modeHide') },
                  { value: 'ask', label: t('modeAsk') },
                ]}
                onChange={(mode) => void configure({ mode })}
              />
            )}
          </SettingsRow>
          <SwitchRow
            label={t('autoAdult')}
            description={t('autoAdultText')}
            checked={status.autoAdult}
            disabled={busy === 'config'}
            onChange={(autoAdult) => void configure({ autoAdult })}
            testId="parental-auto-adult"
          />
          <SettingsRow label={t('unlockLength')} description={t('unlockLengthText')}>
            {({ id, describedBy }) => (
              <Select
                id={id}
                aria-describedby={describedBy}
                value={String(status.unlockMinutes)}
                options={unlockOptions}
                disabled={busy === 'config'}
                onValueChange={(v) => void configure({ unlockMinutes: Number(v) })}
                data-testid="parental-unlock-minutes"
              />
            )}
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      <LocksGroup status={status} removed={removed} onRemove={removeLock} onChooseGroups={(source) => setDialog({ kind: 'groups', source })} />

      {status.enabled ? (
        <SettingsGroup title={t('pinTitle')}>
          <SettingsRow label={t('changePin')} description={t('changePinText')}>
            {() => (
              <Button variant="secondary" icon={<KeyRound aria-hidden size={16} />} onClick={() => setDialog({ kind: 'setPin', mode: 'change' })} data-testid="parental-change-pin">
                {t('changePin')}
              </Button>
            )}
          </SettingsRow>
          <SettingsRow label={t('turnOff')} description={t('turnOffText')}>
            {() => (
              <Button variant="danger" icon={<ShieldOff aria-hidden size={16} />} onClick={() => setDialog({ kind: 'disable' })} data-testid="parental-turn-off">
                {t('turnOffButton')}
              </Button>
            )}
          </SettingsRow>
        </SettingsGroup>
      ) : null}

      {dialog?.kind === 'setPin' ? (
        <SetPinDialog
          open
          mode={dialog.mode}
          onCancel={close}
          onDone={() => {
            close();
            toast(
              dialog.mode === 'first'
                ? { variant: 'success', title: t('pinSetToast'), description: t('pinSetToastText') }
                : { variant: 'success', title: t('pinChangedToast') },
            );
          }}
        />
      ) : null}

      {dialog?.kind === 'unlock' ? (
        <PinDialog
          open
          title={t('unlockTitle')}
          description={t('unlockSettingsText')}
          footnote={status.unlockMinutes === 0 ? t('unlockUntilRestart') : t('unlockFor', { duration: durationText(status.unlockMinutes) })}
          confirmLabel={t('unlock')}
          onSubmit={async (pin) => {
            applyStatus(await rpc('parental.unlock', { pin }));
            close();
          }}
          onCancel={close}
          testId="parental-unlock"
        />
      ) : null}

      {dialog?.kind === 'disable' ? (
        <PinDialog
          open
          danger
          title={t('turnOffTitle')}
          description={t('turnOffConfirmText')}
          confirmLabel={t('turnOffButton')}
          onSubmit={async (pin) => {
            applyStatus(await rpc('parental.disable', { pin }));
            close();
            toast({ variant: 'success', title: t('turnedOffToast'), description: t('turnedOffToastText') });
          }}
          onCancel={close}
          testId="parental-disable"
        />
      ) : null}

      {dialog?.kind === 'configure' ? (
        <PinDialog
          open
          title={t('confirmChangeTitle')}
          description={t('confirmChangeText')}
          confirmLabel={t('saveChange')}
          onSubmit={async (pin) => {
            applyStatus(await rpc('parental.configure', { ...dialog.patch, pin }));
            close();
          }}
          onCancel={close}
          testId="parental-configure"
        />
      ) : null}

      {dialog?.kind === 'remove' ? (
        <PinDialog
          open
          title={t('removeLockTitle')}
          description={t('removeLockText', { name: dialog.lock.name })}
          confirmLabel={t('removeLock')}
          onSubmit={async (pin) => {
            await rpc('parental.setLocked', { target: toTarget(dialog.lock), locked: false, pin });
            lockRemoved(dialog.lock);
            dialog.onDone();
            close();
          }}
          onCancel={close}
          testId="parental-remove"
        />
      ) : null}

      {dialog?.kind === 'groups' ? <GroupsDialogLoader source={dialog.source} status={status} onClose={close} /> : null}
    </SettingsSection>
  );
}

/** The state at a glance (off, locked, unlocked with time left) and its one action. */
function StatusPanel({
  status,
  locking,
  onSetPin,
  onUnlock,
  onLockNow,
}: {
  status: ParentalStatus;
  locking: boolean;
  onSetPin: () => void;
  onUnlock: () => void;
  onLockNow: () => void;
}) {
  const { t, i18n } = useTranslation('parental');
  // When the core reported the lockout, so its countdown runs from there.
  const { dataUpdatedAt } = useParentalStatus();
  const timed = status.enabled && status.unlocked && !!status.unlockedUntil;
  const lockout = status.enabled && !status.unlocked && !!status.retryAfterSeconds;
  const now = useNow(timed || lockout ? 1000 : null);
  const left = unlockRemainingMs(status, now);

  let state: 'off' | 'locked' | 'unlocked';
  if (!status.enabled) state = 'off';
  else if (status.unlocked) state = 'unlocked';
  else state = 'locked';

  const Icon = { off: ShieldOff, locked: ShieldCheck, unlocked: LockOpen }[state];

  let title: string;
  let text: ReactNode;
  let action: ReactNode;
  if (state === 'off') {
    title = t('statusOff');
    text = t('statusOffText');
    action = (
      <Button icon={<KeyRound aria-hidden size={16} />} onClick={onSetPin} data-testid="parental-set-pin">
        {t('setPin')}
      </Button>
    );
  } else if (state === 'locked') {
    title = t('statusLocked');
    text = status.mode === 'hide' ? t('statusLockedHide') : t('statusLockedAsk');
    action = (
      <Button variant="secondary" icon={<LockOpen aria-hidden size={16} />} onClick={onUnlock} data-testid="parental-unlock-button">
        {t('unlock')}
      </Button>
    );
  } else {
    title = t('statusUnlocked');
    text = status.unlockedUntil ? t('unlockedUntil', { time: formatUntil(status.unlockedUntil, i18n.language, now) }) : t('unlockedUntilRestart');
    action = (
      <Button icon={<Lock aria-hidden size={16} />} onClick={onLockNow} loading={locking} data-testid="parental-lock-now">
        {t('lockNow')}
      </Button>
    );
  }

  const total = status.unlockMinutes * 60_000;
  const lockoutLeft = lockout ? Math.max(0, (status.retryAfterSeconds ?? 0) * 1000 - (Math.max(now, Date.now()) - dataUpdatedAt)) : 0;

  return (
    <div
      className={cn(
        'flex flex-col gap-4 rounded-lg border bg-surface p-5 @2xl:flex-row @2xl:items-center',
        state === 'unlocked' ? 'border-warning/50' : state === 'locked' ? 'border-accent/40' : 'border-border',
      )}
      data-testid="parental-status"
      data-state={state}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-12 shrink-0 items-center justify-center rounded-full',
          state === 'locked' && 'bg-accent/15 text-accent shadow-[0_0_24px_var(--color-glow)]',
          state === 'unlocked' && 'bg-warning/15 text-warning',
          state === 'off' && 'bg-surface-3 text-fg-muted',
        )}
      >
        <Icon size={24} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="font-display text-lg font-semibold text-fg" role="status">
          {title}
        </p>
        <p className="text-sm text-fg-muted">{text}</p>
        {state === 'unlocked' && left !== null && total > 0 ? (
          <div className="mt-1 flex max-w-sm items-center gap-3">
            <ProgressBar value={left} max={Math.max(total, left)} size="xs" label={t('unlockTimeLeft')} className="flex-1" />
            <span className="text-xs text-fg-subtle tabular" data-testid="parental-unlock-left">
              {formatCountdown(left / 1000)}
            </span>
          </div>
        ) : null}
        {lockout && lockoutLeft > 0 ? (
          <p className="text-sm font-medium text-danger" data-testid="parental-status-lockout">
            {t('lockoutActive', { time: formatCountdown(lockoutLeft / 1000) })}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">{action}</div>
    </div>
  );
}

/** Every lock, grouped by source, with "Choose groups" per source. */
function LocksGroup({
  status,
  removed,
  onRemove,
  onChooseGroups,
}: {
  status: ParentalStatus;
  removed: ReadonlySet<string>;
  onRemove: (lock: ParentalLock, onDone: () => void) => Promise<void>;
  onChooseGroups: (source: Source) => void;
}) {
  const { t } = useTranslation('parental');
  const sources = useRpcQuery('sources.list', undefined);
  const locks = useRpcQuery('parental.locks', {});

  const bySource = useMemo(() => {
    const map = new Map<string, ParentalLock[]>();
    for (const l of locks.data ?? []) {
      if (removed.has(lockKey(l))) continue;
      const list = map.get(l.sourceId) ?? [];
      list.push(l);
      map.set(l.sourceId, list);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'category' ? -1 : 1));
    return map;
  }, [locks.data, removed]);

  const known = new Set((sources.data ?? []).map((s) => s.id));
  const orphans = [...bySource.entries()].filter(([id]) => !known.has(id)).flatMap(([, list]) => list);
  const total = [...bySource.values()].reduce((n, l) => n + l.length, 0);

  let body: ReactNode;
  if (sources.error || locks.error) {
    const err = sources.error ?? locks.error;
    body = (
      <div className="p-4">
        <ErrorState
          size="inline"
          error={err}
          onRetry={() => {
            void sources.refetch();
            void locks.refetch();
          }}
        />
      </div>
    );
  } else if (!sources.data || !locks.data) {
    body = (
      <div className="flex flex-col gap-3 p-4" aria-busy="true" aria-label={t('loadingLocks')}>
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-10" />
        ))}
      </div>
    );
  } else if (sources.data.length === 0 && total === 0) {
    body = (
      <div className="p-4">
        <EmptyState size="inline" icon={<FolderLock aria-hidden size={24} />} title={t('noSourcesTitle')} description={t('noSourcesText')} />
      </div>
    );
  } else {
    body = (
      <>
        {sources.data.map((s) => (
          <SourceLocks
            key={s.id}
            name={s.name}
            source={s}
            locks={bySource.get(s.id) ?? []}
            status={status}
            onRemove={onRemove}
            onChooseGroups={() => onChooseGroups(s)}
          />
        ))}
        {orphans.length > 0 ? <SourceLocks name={t('removedSource')} locks={orphans} status={status} onRemove={onRemove} /> : null}
      </>
    );
  }

  // With controls off and nothing locked, the panel's "Set a PIN" is the only next step.
  // Kept locks show once loaded; no skeleton meanwhile, so the page does not jump when there are none.
  if (!status.enabled && total === 0 && !sources.error && !locks.error) return null;

  return (
    <SettingsGroup
      title={t('lockedContentTitle')}
      description={status.enabled ? t('lockedContentText') : total > 0 ? t('locksKeptText') : t('lockedContentText')}
    >
      {body}
    </SettingsGroup>
  );
}

const TYPE_ICON: Record<ContentType, typeof Tv> = { live: Tv, radio: Radio, movie: Film, series: Clapperboard };
const CONTENT_TYPES = Object.keys(TYPE_ICON) as ContentType[];

function SourceLocks({
  name,
  source,
  locks,
  status,
  onRemove,
  onChooseGroups,
}: {
  name: string;
  /** The source, when it still exists (not for locks of removed sources). */
  source?: Source;
  locks: readonly ParentalLock[];
  status: ParentalStatus;
  onRemove: (lock: ParentalLock, onDone: () => void) => Promise<void>;
  onChooseGroups?: () => void;
}) {
  const { t, i18n } = useTranslation('parental');
  const kindText = useLockKindText();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const focusIndex = useRef<number | null>(null);
  const sourceId = source?.id ?? locks[0]?.sourceId ?? '';

  // Adult groups, per content type: for the badges on group locks, and for the count of
  // groups the automatic rule locks on top of the list (only while it applies).
  const autoApplies = status.enabled && status.autoAdult && !!source;
  const counts = source ? contentCounts(source) : null;
  const wantAdult = (ct: ContentType) =>
    locks.some((l) => l.kind === 'category' && l.contentType === ct) || (autoApplies && (counts?.[ct] ?? 0) > 0);
  const adultLive = useRpcQuery('parental.adultCategories', { sourceId, contentType: 'live' }, { enabled: wantAdult('live') });
  const adultRadio = useRpcQuery('parental.adultCategories', { sourceId, contentType: 'radio' }, { enabled: wantAdult('radio') });
  const adultMovie = useRpcQuery('parental.adultCategories', { sourceId, contentType: 'movie' }, { enabled: wantAdult('movie') });
  const adultSeries = useRpcQuery('parental.adultCategories', { sourceId, contentType: 'series' }, { enabled: wantAdult('series') });
  const adult: Record<ContentType, readonly string[] | undefined> = {
    live: adultLive.data,
    radio: adultRadio.data,
    movie: adultMovie.data,
    series: adultSeries.data,
  };

  // Adult groups locked by the rule alone: not also in the list as a group lock.
  let autoCount = 0;
  if (autoApplies) {
    for (const ct of CONTENT_TYPES) {
      const explicit = new Set(locks.filter((l) => l.kind === 'category' && l.contentType === ct).map((l) => l.targetId));
      autoCount += (adult[ct] ?? []).filter((id) => !explicit.has(id)).length;
    }
  }

  const shown = expanded ? locks : locks.slice(0, ROWS_COLLAPSED);

  // After a removal, focus moves to the row that took its place (or the one before, or "Choose groups").
  useLayoutEffect(() => {
    const i = focusIndex.current;
    if (i === null) return;
    focusIndex.current = null;
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-remove-lock]');
    const next = buttons?.[Math.min(i, buttons.length - 1)];
    (next ?? chooseRef.current)?.focus();
  }, [locks]);

  return (
    <div className="flex flex-col gap-2 px-4 py-4" data-testid="parental-source-locks">
      {/* The name wraps rather than truncates (a phone leaves it little room beside the button); the count sits under it. */}
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h4 className="font-medium text-fg [overflow-wrap:anywhere]" dir="auto">
            <span className="text-match-parent">{name}</span>
          </h4>
          {locks.length > 0 ? <span className="text-sm text-fg-subtle tabular">{t('lockCount', { count: locks.length })}</span> : null}
        </div>
        {onChooseGroups ? (
          <Button ref={chooseRef} size="sm" variant="secondary" icon={<ListChecks aria-hidden size={16} />} onClick={onChooseGroups} data-testid="parental-choose-groups">
            {t('chooseGroups')}
          </Button>
        ) : null}
      </div>
      {autoCount > 0 ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted" data-testid="parental-auto-adult-count">
          <ShieldAlert aria-hidden size={16} className="shrink-0 text-danger" />
          {t('autoAdultCount', { count: autoCount })}
        </p>
      ) : null}
      {locks.length === 0 ? (
        autoCount > 0 ? null : <p className="text-sm text-fg-subtle">{t('sourceNoLocks')}</p>
      ) : (
        <ul ref={listRef} className="flex flex-col" aria-label={t('locksIn', { source: name })}>
          {shown.map((l, i) => {
            const TypeIcon = l.kind === 'category' ? FolderLock : TYPE_ICON[l.contentType];
            const isAdult = l.kind === 'category' && !!adult[l.contentType]?.includes(l.targetId);
            return (
              <li key={lockKey(l)} className="flex min-h-12 items-center gap-3 border-t border-divider py-1.5 first:border-t-0" data-testid="parental-lock-row">
                <TypeIcon aria-hidden size={18} className="shrink-0 text-fg-subtle" />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm text-fg text-match-parent" dir="auto">
                    {l.name}
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                    <span>{kindText(l.kind, l.contentType)}</span>
                    {formatDay(l.createdAt, i18n.language) ? <span>{t('lockedOn', { date: formatDay(l.createdAt, i18n.language) })}</span> : null}
                  </span>
                </div>
                {isAdult ? (
                  <Badge variant={status.autoAdult ? 'danger' : 'outline'} title={status.autoAdult ? t('adultAutoHint') : t('adultOffHint')}>
                    <ShieldAlert aria-hidden size={12} />
                    {t('adultBadge')}
                  </Badge>
                ) : null}
                <IconButton
                  label={t('removeLockNamed', { name: l.name })}
                  icon={<X aria-hidden size={16} />}
                  size="sm"
                  data-remove-lock=""
                  data-testid="parental-remove-lock"
                  onClick={() => void onRemove(l, () => (focusIndex.current = i))}
                />
              </li>
            );
          })}
        </ul>
      )}
      {locks.length > ROWS_COLLAPSED ? (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? t('showFewer') : t('showAllLocks', { count: locks.length })}
        </Button>
      ) : null}
    </div>
  );
}

/** Loads this source's locks for the groups dialog, so it opens with them ticked. */
function GroupsDialogLoader({ source, status, onClose }: { source: Source; status: ParentalStatus; onClose: () => void }) {
  const locks = useRpcQuery('parental.locks', {});
  const mine = useMemo(() => (locks.data ?? []).filter((l) => l.sourceId === source.id), [locks.data, source.id]);
  if (!locks.data) return null;
  return <LockGroupsDialog source={source} status={status} locks={mine} onClose={onClose} />;
}
