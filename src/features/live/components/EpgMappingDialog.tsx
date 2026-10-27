import { Check } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, useRpcQuery } from '@/api/query';
import { rpc } from '@/api/transport';
import type { Channel } from '@/api/types';
import { parseGuideShift } from '@/lib/guideShift';

import { Button, Dialog, ErrorState, SearchInput, Skeleton, cn, fieldClass, useToast, errorDescription } from '@/ui';
import { joinList } from '@/shell/dashboard/cards';
import { useDebounced } from '../hooks/useDebounced';
import { useDisplayPrefs } from '../hooks/useDisplayPrefs';
import { displayChannelName } from '../lib/channelName';
import { ChannelLogo } from './ChannelLogo';

/** Strips quality and country decorations so the first search is useful. */
export function mappingQuery(name: string): string {
  return name
    .replace(/^[A-Z]{2,3}\s*[:|-]\s*/, '')
    .replace(/\b(FHD|UHD|HD|SD|4K|HEVC|H265)\b/gi, '')
    .replace(/[[(].*?[\])]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function EpgMappingDialog({ channel, onClose }: { channel: Channel | null; onClose(): void }) {
  const { t, i18n } = useTranslation('live');
  const { toast } = useToast();
  const prefs = useDisplayPrefs();
  const open = !!channel;
  const [query, setQuery] = useState('');
  const debounced = useDebounced(query.trim(), 250);
  const [busy, setBusy] = useState(false);
  /** The channel's own guide shift as typed; blank = the playlist's tvg-shift. */
  const [shiftText, setShiftText] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // The channel's cleaned-up name is the first search. Set while rendering, so the field holds it
  // when the Dialog focuses the field, then selected (this layout effect runs after the Dialog's),
  // so the first keystroke replaces the suggestion instead of adding to it, as Rename does.
  const [queryFor, setQueryFor] = useState<Channel | null>(null);
  if (channel !== queryFor) {
    setQueryFor(channel);
    if (channel) setQuery(mappingQuery(channel.name));
  }
  useLayoutEffect(() => {
    if (channel) searchRef.current?.select();
  }, [channel]);

  const resolution = useRpcQuery('epg.resolve', { ref: channel?.ref ?? { sourceId: '', contentType: 'live', itemId: '' } }, { enabled: open });
  const savedShift = resolution.data?.shiftMinutes;
  useEffect(() => {
    setShiftText(savedShift !== undefined ? String(savedShift) : '');
  }, [savedShift, channel]);
  const shiftMinutes = parseGuideShift(shiftText);
  // Blank clears the channel's own shift (back to tvg-shift); a number, 0 included, overrides it.
  const nextShift = shiftText.trim() === '' ? null : shiftMinutes;
  const shiftChanged = shiftMinutes !== null && nextShift !== (savedShift ?? null);
  const results = useRpcQuery('epg.channelsSearch', { query: debounced, limit: 50 }, { enabled: open && debounced.length > 0 });

  const apply = async (fn: () => Promise<unknown>, title: string) => {
    setBusy(true);
    try {
      await fn();
      await invalidate('epg.');
      toast({ title, variant: 'success' });
      onClose();
    } catch (err) {
      toast({ title: t('mappingFailed'), description: errorDescription(err), variant: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const current = resolution.data;
  // What the two fixed choices stand for: the automatic match (from the playlist or by name, found
  // or not) and the guide turned off by hand. A channel matched by hand checks its result row.
  const automatic = current !== undefined && current.via !== 'manual';
  const noGuide = current?.via === 'manual' && !current.epgChannelId;
  const viaLabel = current
    ? {
        manual: t('mappingViaManual'),
        item: t('mappingViaItem'),
        name: t('mappingViaName'),
        none: t('mappingViaNone'),
      }[current.via]
    : '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('epgMappingTitle', { name: displayChannelName(channel?.name, prefs.stripCountryPrefix) })}
      size="md"
      // What the channel's guide comes from now, under the title. Every choice below applies at
      // once, so there is no footer: the close button, Escape and the scrim leave without a change.
      description={current ? (current.epgChannelId ? t('mappingCurrent', { id: current.epgChannelId, via: viaLabel }) : viaLabel) : ' '}
    >
      {/* The task first: finding the guide channel. Typing goes straight into the search. */}
      <SearchInput ref={searchRef} data-autofocus="" className="mb-2" value={query} onChange={setQuery} placeholder={t('mappingSearch')} label={t('mappingSearch')} />
      <ul className="flex flex-col">
        <li>
          <ChoiceRow
            label={t('mappingAutomatic')}
            selected={automatic}
            selectedLabel={t('mappingSelected')}
            disabled={busy || !channel}
            onClick={() => channel && void apply(() => rpc('epg.clearMapping', { ref: channel.ref }), t('mappingReset'))}
          />
        </li>
        <li>
          <ChoiceRow
            label={t('mappingNone')}
            selected={noGuide}
            selectedLabel={t('mappingSelected')}
            disabled={busy || !channel}
            onClick={() => channel && void apply(() => rpc('epg.setMapping', { ref: channel.ref, epgChannelId: null }), t('mappingCleared'))}
          />
        </li>
      </ul>
      <div role="separator" className="my-1 h-px bg-divider" />
      {/* One height whatever the search finds: a sheet on a phone grows from its top edge, so a
          box that shrank with the results would move the search field while typing. */}
      <div className="h-[min(320px,45vh)] overflow-y-auto overscroll-contain" data-testid="epg-mapping-results">
        {results.error ? (
          <ErrorState error={results.error} onRetry={() => void results.refetch()} />
        ) : debounced && results.isLoading ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : results.data && results.data.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">{t('mappingNoResults', { query: debounced })}</p>
        ) : (
          <ul className="flex flex-col" aria-label={t('mappingResults')}>
            {(results.data ?? []).map((m) => {
              // Only a match made by hand checks its row: an automatic one is checked on Match
              // automatically, and one choice carries the check.
              const selected = current?.via === 'manual' && current.epgChannelId === m.channelId;
              return (
                <li key={`${m.epgUrl}|${m.channelId}`}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      channel &&
                      void apply(() => rpc('epg.setMapping', { ref: channel.ref, epgChannelId: m.channelId }), t('mappingSaved', { name: m.displayName }))
                    }
                    className={RESULT_ROW}
                  >
                    <ChannelLogo src={m.icon} name={m.displayName} size={28} sourceId={channel?.ref.sourceId} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm text-fg">{m.displayName}</span>
                      <span className="truncate text-xs text-fg-subtle">{joinList([m.channelId, hostOf(m.epgUrl)], i18n.language)}</span>
                    </span>
                    {selected ? <Check className="size-4 text-accent" aria-label={t('mappingSelected')} /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {/* The time shift corrects a guide that runs early or late: after the choice, ruled off. */}
      <form
        className="mt-4 flex flex-col gap-1.5 border-t border-divider pt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (channel && shiftChanged) void apply(() => rpc('epg.setChannelShift', { ref: channel.ref, minutes: nextShift }), t('mappingShiftSaved'));
        }}
      >
        <label htmlFor="epg-mapping-shift" className="text-sm font-medium text-fg">
          {t('mappingShift')}
        </label>
        <div className="flex items-center gap-2">
          <input
            id="epg-mapping-shift"
            type="text"
            // Not "numeric": phone keypads for it have no minus sign, and the shift can be negative.
            inputMode="text"
            autoComplete="off"
            value={shiftText}
            onChange={(e) => setShiftText(e.target.value)}
            placeholder="0"
            aria-invalid={shiftMinutes === null || undefined}
            aria-describedby="epg-mapping-shift-hint"
            data-testid="epg-mapping-shift"
            className={fieldClass('sm', 'w-24 text-end tabular-nums')}
          />
          <span className="text-sm text-fg-muted">{t('mappingShiftUnit')}</span>
          <Button type="submit" size="sm" variant="secondary" disabled={busy || !channel || !shiftChanged}>
            {t('mappingShiftSave')}
          </Button>
        </div>
        <p id="epg-mapping-shift-hint" className={shiftMinutes === null ? 'text-sm text-danger' : 'text-xs text-fg-muted'} role={shiftMinutes === null ? 'alert' : undefined}>
          {shiftMinutes === null ? t('mappingShiftError') : t('mappingShiftHint')}
        </p>
      </form>
    </Dialog>
  );
}

const RESULT_ROW =
  'flex w-full items-center gap-3 rounded-md px-2 py-2 text-start hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40';

/** Match automatically and No guide: rows like the guide channels under them, where one tap applies. */
function ChoiceRow({
  label,
  selected,
  selectedLabel,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  selectedLabel: string;
  disabled: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={cn(RESULT_ROW, 'min-h-11')}>
      {/* As wide as a guide channel's logo, so the labels line up with the channel names. */}
      <span aria-hidden className="w-7 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm text-fg">{label}</span>
      {selected ? <Check className="size-4 text-accent" aria-label={selectedLabel} /> : null}
    </button>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
