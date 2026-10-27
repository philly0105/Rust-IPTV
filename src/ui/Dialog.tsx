import { X } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { IconButton } from './Button';
import { cn } from './cn';
import { announceFocusAfterCommit, focusableIn } from './focus';
import { portalContainer } from './portal';
import { usePresence } from './presence';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';
/** `center`: floating card. `end`: full-height drawer on the inline-end edge (right in LTR, left in RTL). */
export type DialogPlacement = 'center' | 'end';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** Short description under the title (aria-describedby). */
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /** Hide the visual title (it stays the accessible name). */
  hideTitle?: boolean;
  /** Skip the close (X) button in the header. */
  hideClose?: boolean;
  /** Close when clicking the backdrop. Default true. */
  dismissible?: boolean;
  className?: string;
  /** Classes for the body wrapper. */
  bodyClassName?: string;
  /** Element to focus on open; defaults to the first `[data-autofocus]`, then the first tabbable. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Extra attributes for e2e. */
  testId?: string;
  /** Where the panel sits. Default `center`. `end` ignores `size`; set the width through `className`. */
  placement?: DialogPlacement;
  /**
   * Below sm, a centred dialog becomes a bottom sheet: full width from the bottom edge, top
   * corners rounded, clear of the home indicator, rising in, with a 1rem gutter instead of
   * 1.5rem. From sm up it is the usual card. On by default for `sm`, `md` and `lg` dialogs that
   * draw a header row; `xl`, `full` and a dialog with neither title nor close button (the command
   * palette) stay floating cards. `sheet={false}` keeps the card.
   */
  sheet?: boolean;
}

/**
 * The sheet's panel below sm. Its height cap can be overridden through `className` (`max-sm:max-h-…`).
 * The cap leaves room above it for the toast stack, which moves to the top edge while a dialog
 * is open on a phone (see Toast.tsx), so a toast never covers the sheet's title.
 */
const SHEET =
  'max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-w-none max-sm:max-h-[calc(100dvh-max(1.5rem,var(--toast-reserve,0px)))] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:pb-[env(safe-area-inset-bottom,0px)] max-sm:[--dialog-gutter:1rem]';

/** Whether a dialog is a sheet below sm when its caller does not say (see `DialogProps.sheet`). */
function sheetByDefault(size: DialogSize, headerless: boolean): boolean {
  return (size === 'sm' || size === 'md' || size === 'lg') && !headerless;
}

const sizes: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[min(1200px,calc(100vw-48px))] h-[calc(100vh-96px)]',
};

interface OpenDialog {
  /** The `data-dialog-layer` element (scrim and panel). */
  layer: HTMLElement | null;
  panel: HTMLElement | null;
  /** What had focus before the dialog opened. */
  previous: HTMLElement | null;
}

/** Open dialogs, oldest first. */
const openDialogs: OpenDialog[] = [];
/** Dialogs closed in the current commit (a prompt and the dialog it guards); cleared on the next microtask. */
let closedNow: OpenDialog[] = [];
/** The page's own `overflow` before the first dialog locked scrolling. */
let pageOverflow = '';

/** Attached, outside every dialog closing in this commit, and inside an open dialog while one stays open. */
function canHoldFocus(el: HTMLElement): boolean {
  if (el === document.body || !el.isConnected) return false;
  if (closedNow.some((d) => d.layer?.contains(el))) return false;
  return openDialogs.length === 0 || openDialogs.some((d) => d.layer?.contains(el));
}

/**
 * Puts focus back after `self` closed. Dialogs closing together run their cleanups in either
 * order, and a closing dialog's DOM can still be attached while its cleanup runs, so each
 * target is checked with canHoldFocus. In order: the element focused before `self` opened,
 * the nearest dialog still open, the openers of dialogs closed in the same commit, then #main
 * (skipped when the dialog opened from <body>, e.g. at startup).
 */
function restoreFocus(self: OpenDialog): void {
  const active = document.activeElement;
  // A dialog that stays open (stacked over this one) holds focus: leave it there.
  if (active && openDialogs.some((d) => d.layer?.contains(active))) return;
  const candidates = [self.previous, openDialogs.at(-1)?.panel, ...closedNow.map((d) => d.previous).reverse()];
  if (self.previous && self.previous !== document.body) candidates.push(document.getElementById('main'));
  for (const el of candidates) {
    if (!el || !canHoldFocus(el)) continue;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) {
      // This runs in a layout cleanup, inside React's commit, where React drops the focus event.
      announceFocusAfterCommit(el);
      return;
    }
  }
}

/**
 * How many centred (floating card) dialogs are open. The toast viewport reads
 * it: on a phone-width window a centred dialog spans the width, so a toast in
 * its bottom corner would sit on the dialog's footer buttons. Drawers are not
 * counted; they leave no free edge to move to.
 */
const useCenteredDialogs = create<{ count: number }>(() => ({ count: 0 }));

/** True while at least one centred dialog is open. */
export function useCenteredDialogOpen(): boolean {
  return useCenteredDialogs((s) => s.count > 0);
}

/**
 * Below sm the toast viewport moves to the top edge while a centred dialog is open (see
 * Toast.tsx), and a toast is taller than the dialog layer's 8vh top gap (about 67 px on an
 * 844 px phone). The viewport reports where its stack ends; the layer then starts the dialog
 * below it, so a toast never covers the dialog's title or close button.
 */
const useToastReserve = create<{ px: number }>(() => ({ px: 0 }));

/** Space between the bottom of the toast stack and a dialog moved below it. */
export const TOAST_DIALOG_GAP = 8;

/**
 * The placement rule: the least top offset of a centred dialog, below sm, for a toast stack
 * whose bottom edge is at `stackBottom` px from the top of the window (0: no toasts). The layer
 * pads by the larger of this and its usual 8vh.
 */
export function toastReserveFor(stackBottom: number): number {
  return stackBottom > 0 ? Math.ceil(stackBottom) + TOAST_DIALOG_GAP : 0;
}

/** The toast viewport reports its stack's bottom edge (0 when no toast shows over a dialog). */
export function reportToastStackBottom(stackBottom: number): void {
  const px = toastReserveFor(stackBottom);
  if (useToastReserve.getState().px !== px) useToastReserve.setState({ px });
}

/**
 * Modal dialog: portal to body (or the fullscreen element, see portalContainer), focus trap,
 * Escape and backdrop close, focus restore, scroll lock, aria-modal with labelled title.
 * Closing plays the exit (the card pops out, the drawer slides back, the scrim fades) while the
 * dialog is already closed for everything else: focus is back, scrolling unlocked, and the
 * leaving layer is inert (usePresence).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  hideTitle,
  hideClose,
  dismissible = true,
  className,
  bodyClassName,
  initialFocus,
  testId,
  placement = 'center',
  sheet,
}: DialogProps) {
  const drawer = placement === 'end';
  // On a phone a floating card leaves 24 px of page on each side and ends its footer mid-screen;
  // a sheet spans the width and puts the actions at the thumb.
  const asSheet = !drawer && (sheet ?? sheetByDefault(size, !!(hideTitle && hideClose)));
  const { t } = useTranslation('common');
  const toastReserve = useToastReserve((s) => s.px);
  const panelRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const { present, closing } = usePresence(open, layerRef);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Set while the dialog closes or unmounts, so the focusin trap below does not pull
  // the restored focus back into a panel that is about to disappear.
  const closingRef = useRef(false);
  // `open` as last rendered, read by the focus cleanup to tell a close (the dialog stays mounted
  // for its exit) from an unmount.
  const openRef = useRef(open);
  openRef.current = open;
  // A dialog that closed in this commit and still has its focus to give back (see below).
  const pendingRestore = useRef<OpenDialog | null>(null);

  // Focus management + scroll lock.
  useLayoutEffect(() => {
    if (!open) return;
    closingRef.current = false;
    const panel = panelRef.current;
    const self: OpenDialog = { layer: panel?.parentElement ?? null, panel, previous: document.activeElement as HTMLElement | null };
    if (panel) {
      const target =
        initialFocus?.current ??
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableIn(panel).find((el) => el.dataset['dialogClose'] === undefined) ??
        panel;
      target.focus({ preventScroll: true });
    }
    const html = document.documentElement;
    if (openDialogs.length === 0) {
      pageOverflow = html.style.overflow;
      html.style.overflow = 'hidden';
    }
    openDialogs.push(self);
    return () => {
      closingRef.current = true;
      const i = openDialogs.indexOf(self);
      if (i >= 0) openDialogs.splice(i, 1);
      if (openDialogs.length === 0) html.style.overflow = pageOverflow;
      if (closedNow.length === 0) {
        queueMicrotask(() => {
          closedNow = [];
        });
      }
      closedNow.push(self);
      // The opener may be gone (a menu item, a row that re-rendered), disabled, or inside a dialog
      // closing with this one: restoreFocus falls back so focus never drops to <body>.
      // Unmounting, the panel leaves the document in this commit: focus moves now. Closing, the
      // panel stays mounted for its exit, and once this commit's DOM changes are in React puts
      // focus back on the element inside it that had it; so the move waits for the layout
      // effect below, which runs after that.
      if (openRef.current) restoreFocus(self);
      else pendingRestore.current = self;
    };
    // initialFocus is a ref; it is read once on open.
  }, [open]);

  useLayoutEffect(() => {
    const self = pendingRestore.current;
    if (!self) return;
    pendingRestore.current = null;
    restoreFocus(self);
  }, [open]);

  // Counted for the toast viewport (useCenteredDialogOpen).
  useEffect(() => {
    if (!open || drawer) return;
    useCenteredDialogs.setState((s) => ({ count: s.count + 1 }));
    return () => useCenteredDialogs.setState((s) => ({ count: Math.max(0, s.count - 1) }));
  }, [open, drawer]);

  // Keep focus inside when something outside steals it (e.g. click on body).
  useEffect(() => {
    if (!open) return;
    const onFocusIn = (e: FocusEvent) => {
      const panel = panelRef.current;
      if (closingRef.current || !panel || !(e.target instanceof Node)) return;
      if (panel.contains(e.target)) return;
      // Allow nested portals that are themselves modal (stacked dialogs, menus).
      if (e.target instanceof Element && e.target.closest('[data-dialog-layer]')) return;
      panel.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [open]);

  if (!present) return null;

  const hasBody = children !== undefined && children !== null && children !== false && children !== '';

  const onKeyDown = (e: KeyboardEvent) => {
    if (closing) return;
    if (e.key === 'Escape') {
      // Escape that ends an IME composition (Japanese, Chinese, Korean input) cancels the candidate, not the dialog.
      if (e.nativeEvent.isComposing) return;
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      onCloseRef.current();
      return;
    }
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = focusableIn(panel);
    if (items.length === 0) {
      e.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const closeButton = (
    <IconButton
      data-dialog-close=""
      label={t('close')}
      shortcut="escape"
      icon={<X aria-hidden size={18} />}
      onClick={() => onCloseRef.current()}
      className={drawer ? 'ms-auto' : '-me-2'}
    />
  );

  return createPortal(
    <div
      ref={layerRef}
      data-dialog-layer=""
      data-state={closing ? 'closed' : 'open'}
      inert={closing || undefined}
      className={cn(
        'fixed inset-0 z-50 flex',
        closing && 'pointer-events-none',
        drawer
          ? 'items-stretch justify-end'
          : // Below sm, start under the toast stack when it is taller than the 8vh gap (toastReserveFor).
            'items-start justify-center overflow-y-auto p-6 pt-[8vh] max-sm:pt-[max(8vh,var(--toast-reserve,0px))] motion-safe:transition-[padding-top] motion-safe:duration-150',
      )}
      style={drawer ? undefined : ({ '--toast-reserve': `${toastReserve}px` } as CSSProperties)}
      onKeyDown={onKeyDown}
    >
      <div
        aria-hidden
        // Marks the dimming layer by role, not by class names, for code that has to find it
        // (mpvBounds dims the native video to match).
        data-scrim=""
        className={cn('fixed inset-0 bg-scrim', closing ? 'motion-safe:animate-fade-out' : 'motion-safe:animate-fade-in')}
        onMouseDown={(e) => {
          // The press's default would move focus to <body> after the close put it back on the
          // opener (or, when not dismissible, out of the dialog).
          e.preventDefault();
          if (dismissible && !closing) onCloseRef.current();
        }}
      />
      {/* Plain divs for the title row and footer: a portaled <header>/<footer> would map to a second banner/contentinfo landmark. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        data-testid={testId}
        className={cn(
          // The panel itself only takes focus when it holds nothing focusable; a ring around the whole dialog would read as a stray highlight.
          'relative flex flex-col border-edge bg-surface text-fg shadow-3 [--dialog-gutter:1.5rem] focus-visible:shadow-3 focus-visible:outline-none',
          drawer
            ? cn('h-full w-[min(var(--panel-width),90vw)] border-s', closing ? 'motion-safe:animate-drawer-out' : 'motion-safe:animate-drawer-in')
            : cn(
                'w-full max-h-[calc(100vh-12vh-24px)] max-sm:max-h-[calc(100vh-max(8vh,var(--toast-reserve,0px))-4vh-24px)] rounded-xl border',
                // A sheet pops like a card from sm up and rises from the bottom edge below it.
                asSheet
                  ? closing
                    ? 'motion-safe:sm:animate-pop-out max-sm:motion-safe:animate-sheet-out'
                    : 'motion-safe:sm:animate-pop-in max-sm:motion-safe:animate-sheet-in'
                  : closing
                    ? 'motion-safe:animate-pop-out'
                    : 'motion-safe:animate-pop-in',
              ),
          !drawer && sizes[size],
          asSheet && SHEET,
          className,
        )}
      >
        {/* Neither a visible title nor a close button: the title is only the accessible name, and no padded row is left above the body. */}
        {hideTitle && hideClose && !drawer ? (
          <div className="sr-only">
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descId}>{description}</p>}
          </div>
        ) : (
          <div
            className={cn(
              'flex gap-4',
              drawer
                ? 'h-(--header-height) shrink-0 items-center border-b border-divider ps-5 pe-3'
                : cn('items-start px-(--dialog-gutter) pt-5', hideTitle ? 'pb-0' : 'pb-4'),
            )}
          >
            <div className={cn('min-w-0 flex-1', hideTitle && 'sr-only')}>
              <h2 id={titleId} className="text-title-sm">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-sm text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            {!hideClose &&
              (drawer || hideTitle ? (
                closeButton
              ) : (
                // A box one title line tall (text-title-sm, 24/15 rem): the 40 px button centres on
                // the title's first line and overhangs the box, so it no longer sets the row's height.
                <div className="flex h-[calc(24rem/15)] shrink-0 items-center" data-dialog-close-box="">
                  {closeButton}
                </div>
              ))}
          </div>
        )}
        {/* No body, no empty band: a confirm with only a description sits straight on its footer. */}
        {/*
          -mt-1 pt-1: a field at the top of a scrolling body keeps its focus glow, which the
          scroll clip would otherwise cut along the top edge; the box itself does not move.
        */}
        {hasBody && <div className={cn('-mt-1 min-h-0 flex-1 overflow-y-auto px-(--dialog-gutter) pt-1 pb-6', bodyClassName)}>{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-divider px-(--dialog-gutter) py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    portalContainer(),
  );
}
