/**
 * The first-run tour (contract C7): three steps, each a card beside a
 * spotlight on its `[data-tour]` anchor, or a centred card when the anchor
 * is missing or off screen.
 *
 * It is modal: a full-window layer catches pointer input, focus stays in the
 * card (Tab wraps, a click on the card's text focuses the card, a focus that
 * escapes is pulled back) and returns to where it was when the tour closes.
 * The tour owns the keyboard while it is open, wherever focus is, and no key
 * reaches the app's shortcuts. Next / Back / Skip, Escape skips, and the
 * arrow keys step forward and back (mirrored in right-to-left layouts). Under
 * reduced motion nothing moves: the spotlight and card jump between anchors.
 */

import { Check } from 'lucide-react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button, cn, focusableIn, Kbd } from '@/ui';

import { useOnboardingStrings } from '../strings';
import { centred, placeCard, spotlightBox, type Box } from './placement';
import { findAnchor, TOUR_STEPS, type TourAnchor } from './steps';

export type TourResult = 'finished' | 'skipped';

export interface TourProps {
  onClose: (result: TourResult) => void;
}

/** Until the card is measured: about its real size, so the first frame lands close. */
const CARD_ESTIMATE = { width: 352, height: 232 };
/** How often a missing or moving anchor is looked up again (rail sources load late, layouts shift). */
export const ANCHOR_POLL_MS = 300;

/** True for a node inside a modal layer other than the tour's own (a Dialog opened above it). The caller rules out the tour's layer first. */
const inOtherModal = (node: Node) =>
  node instanceof Element && node.closest('[aria-modal="true"], [data-dialog-layer]') !== null;

/** Position as a transform: the compositor moves it, and it never counts as a layout shift. */
export const translateTo = (x: number, y: number) => `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

function useViewport() {
  const [vp, setVp] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setVp({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return vp;
}

/** The anchor's box, kept current through resizes, scrolling and late mounts; null when there is none. */
function useAnchorBox(anchor: TourAnchor): Box | null {
  const [box, setBox] = useState<Box | null>(null);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      const el = findAnchor(anchor);
      const r = el?.getBoundingClientRect();
      const next = r ? { top: r.top, left: r.left, width: r.width, height: r.height } : null;
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    // A rail scrolled past the anchor: bring it in once per step (instantly; no smooth scroll to honour).
    findAnchor(anchor)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    const timer = window.setInterval(measure, ANCHOR_POLL_MS);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      window.clearInterval(timer);
    };
  }, [anchor]);
  return box;
}

/** Three rising bars, filled up to the current step: the tuner's signal meter. Decorative; the text says the step. */
function SignalMeter({ step, total }: { step: number; total: number }) {
  return (
    <span aria-hidden className="flex h-4 items-end gap-[3px]" data-testid="tour-meter">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={cn(
            'w-1 rounded-[1px] motion-safe:transition-colors motion-safe:duration-200',
            i <= step ? 'bg-accent' : 'bg-surface-3',
          )}
          style={{ height: `${6 + (i * 10) / Math.max(1, total - 1)}px` }}
        />
      ))}
    </span>
  );
}

export function Tour({ onClose }: TourProps) {
  const { t, ready } = useOnboardingStrings();
  const [step, setStep] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const total = TOUR_STEPS.length;
  const current = TOUR_STEPS[step]!;
  const last = step === total - 1;
  const box = useAnchorBox(current.anchor);
  const vp = useViewport();
  const layerRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const [cardSize, setCardSize] = useState(CARD_ESTIMATE);
  const titleId = useId();
  const textId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closingRef = useRef(false);

  const close = useCallback((result: TourResult) => {
    if (closingRef.current) return;
    closingRef.current = true;
    onCloseRef.current(result);
  }, []);

  const go = useCallback(
    (delta: 1 | -1) => {
      if (delta === 1 && step === total - 1) return close('finished');
      const next = Math.min(Math.max(step + delta, 0), total - 1);
      if (next === step) return;
      setStep(next);
      const s = TOUR_STEPS[next]!;
      setAnnouncement(`${t('tourStep', { current: next + 1, total })}. ${t(s.titleKey)}`);
    },
    [step, total, close, t],
  );

  // Focus: into the card on open, back where it was on close (or the main region when that is gone).
  useLayoutEffect(() => {
    if (!ready) return;
    const previous = document.activeElement as HTMLElement | null;
    primaryRef.current?.focus({ preventScroll: true });
    return () => {
      closingRef.current = true;
      if (previous && previous !== document.body && document.contains(previous)) previous.focus({ preventScroll: true });
      else document.getElementById('main')?.focus({ preventScroll: true });
    };
  }, [ready]);

  // After a step change keep focus on the button that still exists (Back stays on Back), else Next.
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && cardRef.current?.contains(active)) return;
    primaryRef.current?.focus({ preventScroll: true });
  }, [step]);

  // Focus that leaves the tour (a click on the page behind, a script) comes back to the card.
  // Focus inside another modal layer stays there, like the shared Dialog allows stacked modals:
  // pulling it back would fight that layer's own focus trap.
  useEffect(() => {
    if (!ready) return;
    const onFocusIn = (e: FocusEvent) => {
      if (closingRef.current || !(e.target instanceof Node)) return;
      if (layerRef.current?.contains(e.target)) return;
      if (inOtherModal(e.target)) return;
      primaryRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [ready]);

  // The card's real size, for placement.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCardSize((s) => (s.width === r.width && s.height === r.height ? s : { width: r.width, height: r.height }));
      }
    };
    update();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [ready]);

  // Keys. The tour owns the keyboard while it is open, so the handler sits on window in the
  // capture phase: it sees every key first, wherever focus is (on the card after a click on its
  // text, on <body> after a script blurred the focused button), instead of only keys typed on the
  // layer. It stops every key, so the app's shortcut registry (window, bubble phase) and the page
  // behind see none. Stopping propagation leaves default actions alone: Enter and Space still
  // press the focused button.
  const onKeyRef = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKeyRef.current = (e) => {
    // A modal that opened above the tour (it should not happen, but a PIN prompt could) keeps its keys.
    if (e.target instanceof Node && !layerRef.current?.contains(e.target) && inOtherModal(e.target)) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      close('skipped');
      return;
    }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      const rtl = document.documentElement.dir === 'rtl';
      go((e.key === 'ArrowRight') !== rtl ? 1 : -1);
      return;
    }
    if (e.key !== 'Tab') return;
    const card = cardRef.current;
    const items = card ? focusableIn(card) : [];
    if (items.length === 0) return;
    // Tab and Shift+Tab cycle through the card's buttons; from anywhere else (the card itself,
    // <body>) Tab starts at the first and Shift+Tab at the last.
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = at === -1 ? (e.shiftKey ? items.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + items.length) % items.length;
    items[next]!.focus();
  };
  useEffect(() => {
    if (!ready) return;
    const onKey = (e: KeyboardEvent) => onKeyRef.current(e);
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [ready]);

  if (!ready) return null;

  const rtl = document.documentElement.dir === 'rtl';
  const spot = box ? spotlightBox(box, vp.width, vp.height) : null;
  const place = spot ? placeCard(spot, cardSize, vp.width, vp.height, rtl) : centred(cardSize, vp.width, vp.height);
  const Icon = current.icon;

  return createPortal(
    <div ref={layerRef} className="fixed inset-0 z-50" data-testid="tour" data-tour-step={current.anchor}>
      {spot ? (
        // The scrim is the spotlight's own enormous shadow, so the anchor shows through a ring-edged hole.
        // It sits at 0,0 and moves by transform, which the compositor animates and which is no layout
        // shift. dir="ltr" keeps its starting corner at the top left in right-to-left layouts too, so a
        // change of size does not count as one either.
        <div
          aria-hidden
          dir="ltr"
          data-testid="tour-spotlight"
          className={cn(
            'pointer-events-none fixed top-0 left-0 rounded-md will-change-transform',
            'shadow-[0_0_0_2px_var(--color-accent),0_0_0_7px_var(--color-glow),0_0_0_200vmax_var(--color-scrim)]',
            'motion-safe:transition-[transform,width,height] motion-safe:duration-200 motion-safe:ease-out',
          )}
          style={{ width: spot.width, height: spot.height, transform: translateTo(spot.left, spot.top) }}
        />
      ) : (
        <div aria-hidden data-scrim="" data-testid="tour-scrim" className="pointer-events-none fixed inset-0 bg-scrim" />
      )}
      {/* Catches clicks on the page behind; they do nothing while the tour is open. */}
      <div aria-hidden className="fixed inset-0" onMouseDown={(e) => e.preventDefault()} />
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        // Focusable but not a Tab stop: a click on the card's text focuses the card instead of
        // dropping focus to <body>, outside the dialog (the shared Dialog panel does the same).
        tabIndex={-1}
        data-testid="tour-card"
        data-side={place.side}
        className={cn(
          'fixed top-0 left-0 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col rounded-lg border border-edge bg-surface text-fg shadow-2 focus-visible:outline-none',
          'motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out',
        )}
        style={{ transform: translateTo(place.left, place.top) }}
      >
        <div className="flex items-center gap-3 px-5 pt-5">
          <span aria-hidden className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-surface-2 text-fg-muted">
            <Icon size={20} />
          </span>
          <p className="min-w-0 flex-1 text-xs text-fg-muted" data-testid="tour-progress">
            {t('tourStep', { current: step + 1, total })}
          </p>
          <SignalMeter step={step} total={total} />
        </div>
        <div key={step} className="px-5 pt-3 motion-safe:animate-fade-in" data-testid="tour-body">
          <h2 id={titleId} className="font-display text-lg leading-snug">
            {t(current.titleKey)}
          </h2>
          <p id={textId} className="mt-1.5 text-sm text-fg-muted">
            {t(current.textKey)}
          </p>
          {current.anchor === 'search' && (
            // Keyboard hints mean nothing on a phone or tablet: hidden when the main pointer is a
            // finger (the same coarse-pointer rule as the hover prefetch).
            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-fg-muted pointer-coarse:hidden" data-testid="tour-hints">
              <li className="flex items-center gap-1.5">
                <Kbd combo="mod+f" />
                {t('tourHintSearch')}
              </li>
              <li className="flex items-center gap-1.5">
                <Kbd combo="mod+k" />
                {t('tourHintPalette')}
              </li>
              <li className="flex items-center gap-1.5">
                <Kbd combo="?" />
                {t('tourHintShortcuts')}
              </li>
            </ul>
          )}
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-divider px-5 py-3">
          {!last && (
            <Button variant="ghost" size="sm" onClick={() => close('skipped')} className="-ms-2">
              {t('tourSkip')}
            </Button>
          )}
          <span className="flex-1" />
          {step > 0 && (
            <Button variant="secondary" size="sm" onClick={() => go(-1)}>
              {t('tourBack')}
            </Button>
          )}
          <Button
            ref={primaryRef}
            variant="primary"
            size="sm"
            onClick={() => go(1)}
            icon={last ? <Check aria-hidden size={16} /> : undefined}
            data-testid="tour-next"
          >
            {last ? t('tourDone') : t('tourNext')}
          </Button>
        </div>
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      </div>
    </div>,
    document.body,
  );
}
