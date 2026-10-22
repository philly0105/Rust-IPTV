/**
 * The Live TV quality filter (`liveMinQuality`, `liveHideUntagged`). Both are settings the core
 * applies wherever live channels are listed (lists, counts, the guide, search, zapping, favorites,
 * recently watched, custom lists); quality is read from the provider's channel name. Radio has no
 * picture and is never filtered, so the page leaves the button out there.
 *
 * QualityFilterButton is a square button at the end of the list toolbar, inverted while a minimum
 * is set, as the guide's genre picker is while a genre is chosen. It opens a small panel with the
 * lowest quality to list and a switch for channels whose name carries no quality tag. The panel is
 * not modal: it opens under the button (above it when there is more room there), kept on screen,
 * with the chosen quality focused. Escape closes it and gives focus back to the button, and so
 * does Tab past either end (the panel is portaled, so the browser's own Tab would leave the page);
 * a press outside it closes it too.
 *
 * No player imports here: the guide's route chunk reads QualityEmptyState from this file.
 */

import { Hd, SlidersHorizontal } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import type { ChannelQuality, Settings } from '@/api/types';
import { useUpdateSettings } from '@/features/settings/lib/useUpdateSettings';
import { useSettingsValue } from '@/shell/useSettings';
import { Button, cn, EmptyState, fieldClass, focusableIn, RadioGroup, TOUCH_TARGET, Toggle, Tooltip, usePresence, useScaledPx } from '@/ui';
import { portalContainer } from '@/ui/portal';

/** What the filter writes: `liveMinQuality: null` turns it off. */
export type QualityPatch = Partial<Pick<Settings, 'liveMinQuality' | 'liveHideUntagged'>>;

type Choice = 'any' | ChannelQuality;

/** The panel's choices and their live.json labels. 'sd' would hide nothing tagged, so it is not offered. */
const CHOICES: readonly { value: Choice; key: string }[] = [
  { value: 'any', key: 'qualityAny' },
  { value: 'hd', key: 'qualityHd' },
  { value: 'fhd', key: 'qualityFhd' },
  { value: 'uhd', key: 'qualityUhd' },
];

const selectMin = (s: Settings) => s.liveMinQuality ?? null;
const selectHideUntagged = (s: Settings) => s.liveHideUntagged === true;

/** The filter as set (`min` null = off) and the optimistic settings write that changes it. */
export function useLiveQuality(): { min: ChannelQuality | null; hideUntagged: boolean; update: (patch: QualityPatch) => void } {
  const min = useSettingsValue(selectMin).data ?? null;
  const hideUntagged = useSettingsValue(selectHideUntagged).data ?? false;
  const updateSettings = useUpdateSettings();
  const update = useCallback((patch: QualityPatch) => void updateSettings(patch), [updateSettings]);
  return { min, hideUntagged, update };
}

const GAP = 4;
const MARGIN = 8;
/** The panel's width at 100 % UI scale. */
const PANEL_WIDTH = 288;

export interface QualityFilterButtonProps {
  min: ChannelQuality | null;
  hideUntagged: boolean;
  onChange(patch: QualityPatch): void;
}

export function QualityFilterButton({ min, hideUntagged, onChange }: QualityFilterButtonProps) {
  const { t } = useTranslation('live');
  const [open, setOpen] = useState(false);
  const [place, setPlace] = useState<{ top?: number; bottom?: number; left: number; width: number; maxHeight: number; above: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const { present, closing } = usePresence(open, popRef);
  const panelWidth = useScaledPx(PANEL_WIDTH);

  const current = CHOICES.find((c) => c.value === (min ?? 'any'));
  const currentLabel = current ? t(current.key) : '';
  const name = t('qualityFilter');

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const width = Math.min(panelWidth, window.innerWidth - 2 * MARGIN);
    const rtl = getComputedStyle(el).direction === 'rtl';
    // Its inline-end edge under the button's: the button ends the toolbar row.
    const left = Math.max(MARGIN, Math.min(rtl ? r.left : r.right - width, window.innerWidth - width - MARGIN));
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const up = below < 300 && above > below;
    const maxHeight = Math.max(160, up ? above : below);
    setPlace(up ? { bottom: window.innerHeight - r.top + GAP, left, width, maxHeight, above: true } : { top: r.bottom + GAP, left, width, maxHeight, above: false });
  };

  const show = () => {
    measure();
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  // Straight to the chosen quality, as a menu goes to its first item.
  useLayoutEffect(() => {
    if (!open) return;
    const radios = popRef.current?.querySelectorAll<HTMLInputElement>('[role="radiogroup"] input');
    const checked = radios ? Array.from(radios).find((r) => r.checked) : undefined;
    (checked ?? radios?.[0])?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onMove = (e: Event) => {
      if (e.target instanceof Node && popRef.current?.contains(e.target)) return;
      measure();
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const onPanelKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      // Ours alone: the page's shortcuts and any dialog behind do not see it.
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    if (e.key !== 'Tab' || !popRef.current) return;
    // The stops Tab makes: a radio group is one stop, its checked radio.
    const stops = focusableIn(popRef.current).filter((el) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked));
    const edge = e.shiftKey ? stops[0] : stops.at(-1);
    if (edge && document.activeElement !== edge) return;
    e.preventDefault();
    close(true);
  };

  // Focus that moves elsewhere by other means (a shortcut, a click on the page) closes it.
  const onPanelBlur = (e: FocusEvent<HTMLDivElement>) => {
    const next = e.relatedTarget;
    if (open && next instanceof Node && !popRef.current?.contains(next) && !triggerRef.current?.contains(next)) setOpen(false);
  };

  const options = CHOICES.map((c) => ({ value: c.value, label: t(c.key), testId: `live-quality-${c.value}` }));
  const tip = (
    <span className="flex flex-col">
      <span>{name}</span>
      {currentLabel ? <span className="opacity-80">{currentLabel}</span> : null}
    </span>
  );

  return (
    <>
      <Tooltip content={open ? null : tip} describe={false}>
        <button
          ref={triggerRef}
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          data-testid="live-quality-filter"
          onClick={() => (open ? close(true) : show())}
          className={fieldClass(
            'sm',
            cn(
              'inline-flex size-8 shrink-0 items-center justify-center px-0',
              TOUCH_TARGET,
              'pointer-coarse:min-w-[calc(44rem/15)]',
              min ? 'border-fg bg-fg text-bg hover:bg-fg/90' : 'text-fg-muted hover:text-fg',
            ),
          )}
        >
          <Hd aria-hidden className="size-4" />
          <span className="sr-only">{currentLabel ? `${name}, ${currentLabel}` : name}</span>
        </button>
      </Tooltip>
      {present && place
        ? createPortal(
            <div
              ref={popRef}
              id={panelId}
              role="dialog"
              aria-label={name}
              data-dialog-layer=""
              data-testid="live-quality-panel"
              inert={closing || undefined}
              onKeyDown={onPanelKey}
              onBlur={onPanelBlur}
              style={
                {
                  top: place.top,
                  bottom: place.bottom,
                  left: place.left,
                  width: place.width,
                  maxHeight: place.maxHeight,
                  '--pop-from': place.above ? '-6px' : '6px',
                } as CSSProperties
              }
              className={cn(
                'fixed z-[60] flex flex-col gap-1 overflow-y-auto rounded-lg border border-edge bg-surface p-1 shadow-2',
                closing ? 'pointer-events-none motion-safe:animate-pop-out' : 'motion-safe:animate-pop-in',
              )}
            >
              <RadioGroup<Choice>
                label={name}
                value={min ?? 'any'}
                options={options}
                onValueChange={(v) => onChange({ liveMinQuality: v === 'any' ? null : v })}
              />
              <div className="border-t border-divider px-3 pt-3 pb-2">
                <Toggle
                  label={t('qualityHideUntagged')}
                  checked={hideUntagged}
                  disabled={min === null}
                  onChange={(on) => onChange({ liveHideUntagged: on })}
                />
              </div>
              <p className="px-3 pb-2 text-caption text-fg-muted">{t('qualityFilterHint')}</p>
            </div>,
            portalContainer(),
          )
        : null}
    </>
  );
}

/**
 * The empty state of a live list the quality filter left empty (a group, All channels, a pinned
 * view, the guide): it says so and offers to show every quality, or the untagged channels again.
 */
export function QualityEmptyState({ hideUntagged, onChange }: { hideUntagged: boolean; onChange(patch: QualityPatch): void }) {
  const { t } = useTranslation('live');
  return (
    <EmptyState
      icon={<SlidersHorizontal className="size-6" />}
      title={t('qualityEmpty')}
      description={t(hideUntagged ? 'qualityEmptyHintUntagged' : 'qualityEmptyHint')}
      action={
        <>
          <Button size="sm" onClick={() => onChange({ liveMinQuality: null })} data-testid="live-quality-show-all">
            {t('qualityShowAll')}
          </Button>
          {hideUntagged ? (
            <Button size="sm" onClick={() => onChange({ liveHideUntagged: false })} data-testid="live-quality-show-untagged">
              {t('qualityShowUntagged')}
            </Button>
          ) : null}
        </>
      }
    />
  );
}
