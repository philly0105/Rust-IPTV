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

import { cn } from './cn';
import { focusableIn } from './focus';

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
}

const sizes: Record<DialogSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  full: 'max-w-[min(1200px,calc(100vw-48px))] h-[calc(100vh-96px)]',
};

let openCount = 0;

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
 * Modal dialog: portal to body, focus trap, Escape and backdrop close,
 * focus restore, scroll lock, aria-modal with labelled title.
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
}: DialogProps) {
  const drawer = placement === 'end';
  const { t } = useTranslation('common');
  const toastReserve = useToastReserve((s) => s.px);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Set while the dialog closes or unmounts, so the focusin trap below does not pull
  // the restored focus back into a panel that is about to disappear.
  const closingRef = useRef(false);

  // Focus management + scroll lock.
  useLayoutEffect(() => {
    if (!open) return;
    closingRef.current = false;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const target =
        initialFocus?.current ??
        panel.querySelector<HTMLElement>('[data-autofocus]') ??
        focusableIn(panel).find((el) => el.dataset['dialogClose'] === undefined) ??
        panel;
      target.focus({ preventScroll: true });
    }
    openCount += 1;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      closingRef.current = true;
      openCount -= 1;
      if (openCount === 0) html.style.overflow = prevOverflow;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
      const landed = document.activeElement;
      if (previous && previous !== document.body && openCount === 0 && (!landed || landed === document.body)) {
        // The opener is gone (a menu item, a row that re-rendered) or can no longer take focus (it became
        // disabled): land on the main region instead of <body>, so the next Tab starts somewhere sensible.
        document.getElementById('main')?.focus({ preventScroll: true });
      }
    };
    // initialFocus is a ref; it is read once on open.
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

  if (!open) return null;

  const hasBody = children !== undefined && children !== null && children !== false && children !== '';

  const onKeyDown = (e: KeyboardEvent) => {
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

  return createPortal(
    <div
      data-dialog-layer=""
      className={cn(
        'fixed inset-0 z-50 flex',
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
        className="fixed inset-0 bg-scrim motion-safe:animate-fade-in"
        onMouseDown={() => dismissible && onCloseRef.current()}
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
          'relative flex flex-col border-border bg-surface text-fg shadow-2 focus-visible:shadow-2 focus-visible:outline-none',
          drawer
            ? 'h-full w-[min(var(--panel-width),90vw)] border-s motion-safe:animate-fade-in'
            : 'w-full max-h-[calc(100vh-12vh-24px)] max-sm:max-h-[calc(100vh-max(8vh,var(--toast-reserve,0px))-4vh-24px)] rounded-lg border motion-safe:animate-pop-in',
          !drawer && sizes[size],
          className,
        )}
      >
        <div
          className={cn(
            'flex gap-4',
            drawer
              ? 'h-(--header-height) shrink-0 items-center border-b border-divider ps-5 pe-3'
              : cn('items-start px-6 pt-5', hideTitle ? 'pb-0' : 'pb-4'),
          )}
        >
          <div className={cn('min-w-0 flex-1', hideTitle && 'sr-only')}>
            <h2 id={titleId} className="text-lg">
              {title}
            </h2>
            {description && (
              <p id={descId} className="mt-1 text-sm text-fg-muted">
                {description}
              </p>
            )}
          </div>
          {!hideClose && (
            <button
              type="button"
              data-dialog-close=""
              aria-label={t('close')}
              onClick={() => onCloseRef.current()}
              className={cn(
                drawer ? 'ms-auto' : '-me-2',
                'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg active:bg-surface-3 motion-safe:transition-colors',
              )}
            >
              <X aria-hidden size={18} />
            </button>
          )}
        </div>
        {/* No body, no empty band: a confirm with only a description sits straight on its footer. */}
        {hasBody && <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-6', bodyClassName)}>{children}</div>}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-divider px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
