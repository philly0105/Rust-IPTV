import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { cn } from './cn';
import { reportToastStackBottom, useCenteredDialogOpen } from './Dialog';
import { ProgressBar } from './Misc';
import { portalContainer } from './portal';

export type ToastVariant = 'info' | 'success' | 'error';

export interface ToastOptions {
  title: ReactNode;
  description?: ReactNode;
  variant?: ToastVariant;
  action?: { label: string; onClick: () => void };
  /** Reuse an id to update a toast in place (progress toasts). */
  id?: string;
  /** Auto-dismiss after ms; `0` keeps it until dismissed. Default 5000 (errors 8000, progress 0). */
  duration?: number;
  /** Determinate progress (`max` defaults to 100) or indeterminate when `value` is undefined. */
  progress?: { value?: number; max?: number };
}

export interface ToastRecord extends ToastOptions {
  id: string;
  variant: ToastVariant;
  createdAt: number;
}

interface ToastStore {
  toasts: ToastRecord[];
  upsert(t: ToastRecord): void;
  dismiss(id: string): void;
  clear(): void;
}

const MAX_VISIBLE = 5;

/**
 * Trims the stack to MAX_VISIBLE. The oldest plain toast that would time out
 * anyway goes first, then the oldest plain persistent one (import progress,
 * `duration: 0`). Toasts with an action (Undo) and the newest toast are never
 * evicted; if only those remain, the stack goes over the cap and the list
 * scrolls. Exported for tests.
 */
export function evictOverflow(list: ToastRecord[]): ToastRecord[] {
  const next = list.slice();
  const evictable = (x: ToastRecord, idx: number) => idx < next.length - 1 && !x.action;
  while (next.length > MAX_VISIBLE) {
    let i = next.findIndex((x, idx) => evictable(x, idx) && defaultDuration(x) > 0);
    if (i < 0) i = next.findIndex(evictable);
    if (i < 0) break;
    next.splice(i, 1);
  }
  return next;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  upsert: (t) =>
    set((s) => {
      const i = s.toasts.findIndex((x) => x.id === t.id);
      if (i >= 0) {
        const next = s.toasts.slice();
        next[i] = { ...t, createdAt: s.toasts[i]!.createdAt };
        return { toasts: next };
      }
      return { toasts: evictOverflow([...s.toasts, t]) };
    }),
  // No-op (same state, no re-render) when the id is not showing.
  dismiss: (id) => set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s)),
  clear: () => set({ toasts: [] }),
}));

let seq = 0;

const VIEWPORT_SELECTOR = '[data-toast-viewport]';
const TOAST_SELECTOR = '[data-toast-id]';
/** Where focus was before it entered the toast stack (F8, a click on Undo, Tab). */
let returnFocus: HTMLElement | null = null;

/**
 * Notes where focus came from as it lands in a toast. Moves between toasts keep the first
 * origin; an entry from <body> or from outside the window (no related target) forgets a stale one.
 */
function noteFocusEntry(from: EventTarget | null): void {
  if (from instanceof Element && from.closest(VIEWPORT_SELECTOR)) return;
  returnFocus = from instanceof HTMLElement && from !== document.body ? from : null;
}

function toastControls(li: Element): HTMLElement[] {
  return Array.from(li.querySelectorAll<HTMLElement>('button:not([disabled])'));
}

/**
 * Moves keyboard focus into the toast stack (the newest toast's first
 * control). Returns false when no toast is showing. The shell binds it to F8.
 */
export function focusToasts(): boolean {
  if (typeof document === 'undefined') return false;
  const items = document.querySelectorAll(`${VIEWPORT_SELECTOR} ${TOAST_SELECTOR}`);
  const newest = items[items.length - 1];
  const target = newest ? toastControls(newest)[0] : undefined;
  if (!target) return false;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && !active.closest(VIEWPORT_SELECTOR)) returnFocus = active;
  target.focus();
  return true;
}

/**
 * Puts focus back where it was before entering the stack, or on main content when that element
 * is gone or can no longer take focus (disabled, hidden), so it never drops to <body>.
 */
function leaveToasts(): void {
  const back = returnFocus;
  returnFocus = null;
  if (back?.isConnected) {
    back.focus({ preventScroll: true });
    if (document.activeElement === back) return;
  }
  document.getElementById('main')?.focus({ preventScroll: true });
}

/**
 * Called as a toast that holds focus is removed: focus moves to the
 * neighbouring toast, or out of the stack when it was the last one.
 */
function handOffFocus(li: HTMLElement): void {
  if (!li.contains(document.activeElement)) return;
  const all = Array.from(li.closest(VIEWPORT_SELECTOR)?.querySelectorAll<HTMLElement>(TOAST_SELECTOR) ?? []);
  const i = all.indexOf(li);
  const next = all[i + 1] ?? all[i - 1];
  const control = next ? toastControls(next)[0] : undefined;
  if (control) control.focus();
  else leaveToasts();
}

/** Shows (or updates, when `id` matches) a toast. Returns its id. Works outside React. */
export function toast(opts: ToastOptions): string {
  const id = opts.id ?? `toast-${++seq}`;
  useToastStore.getState().upsert({ ...opts, id, variant: opts.variant ?? 'info', createdAt: Date.now() });
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.getState().dismiss(id);
}

/** `useToast().toast({...})` per C11; also exposes `dismiss`. */
export function useToast(): { toast: (opts: ToastOptions) => string; dismiss: (id: string) => void } {
  return { toast, dismiss: dismissToast };
}

function defaultDuration(t: ToastRecord): number {
  if (t.duration !== undefined) return t.duration;
  if (t.progress) return 0;
  return t.variant === 'error' ? 8000 : 5000;
}

function ToastItem({ t, paused }: { t: ToastRecord; paused: boolean }) {
  const { t: tr } = useTranslation('common');
  const dismiss = useToastStore((s) => s.dismiss);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liRef = useRef<HTMLLIElement>(null);
  const duration = defaultDuration(t);

  const close = () => dismiss(t.id);

  // However the toast goes (button, Escape, timeout, dismissToast elsewhere),
  // focus inside it moves on instead of falling to <body>. Layout cleanup runs
  // while the node is still attached.
  useLayoutEffect(() => {
    const el = liRef.current;
    return () => {
      if (el) handOffFocus(el);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLLIElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    // Up/Down hop between toasts (newest is last).
    const all = Array.from(liRef.current?.closest(VIEWPORT_SELECTOR)?.querySelectorAll<HTMLElement>(TOAST_SELECTOR) ?? []);
    const i = all.indexOf(liRef.current!);
    const next = all[i + (e.key === 'ArrowUp' ? -1 : 1)];
    if (!next) return;
    e.preventDefault();
    e.stopPropagation();
    toastControls(next)[0]?.focus();
  };

  const arm = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (duration > 0) timer.current = setTimeout(close, duration);
  };
  const pause = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  // Hovering anywhere over the stack pauses every toast; focus inside one keeps it.
  // Re-arms whenever the toast content is updated in place or the pointer leaves.
  useEffect(() => {
    if (paused || liRef.current?.contains(document.activeElement)) pause();
    else arm();
    return pause;
  }, [t, duration, paused]);

  const Icon = t.variant === 'success' ? CircleCheck : t.variant === 'error' ? CircleAlert : Info;
  return (
    <li
      ref={liRef}
      data-toast-id={t.id}
      data-variant={t.variant}
      onKeyDown={onKeyDown}
      data-paused={paused || undefined}
      onFocus={(e) => {
        noteFocusEntry(e.relatedTarget);
        pause();
      }}
      onBlur={(e) => {
        if (!paused && !e.currentTarget.contains(e.relatedTarget as Node | null)) arm();
      }}
      className={cn(
        // shrink-0: in the capped flex column a long stack must scroll, not squash each toast.
        'pointer-events-auto relative flex w-full shrink-0 gap-3 overflow-hidden rounded-md border border-border bg-surface-2 py-3 pe-2 ps-4 shadow-2',
        'motion-safe:animate-toast-in',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute inset-y-0 start-0 w-1',
          t.variant === 'success' ? 'bg-success' : t.variant === 'error' ? 'bg-danger' : 'bg-accent',
        )}
      />
      <Icon
        aria-hidden
        size={18}
        className={cn(
          'mt-0.5 shrink-0',
          t.variant === 'success' ? 'text-success' : t.variant === 'error' ? 'text-danger' : 'text-accent',
        )}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="text-sm font-semibold text-fg">{t.title}</p>
        {t.description && <p className="text-sm break-words text-fg-muted">{t.description}</p>}
        {t.progress && (
          <ProgressBar
            className="mt-1"
            value={t.progress.value ?? 0}
            max={t.progress.max ?? 100}
            indeterminate={t.progress.value === undefined}
            label={typeof t.title === 'string' ? t.title : undefined}
          />
        )}
        {t.action && (
          <button
            type="button"
            onClick={() => {
              t.action?.onClick();
              close();
            }}
            className="-ms-1.5 mt-0.5 inline-flex min-h-8 items-center self-start rounded-sm px-1.5 text-sm font-semibold text-accent hover:underline hover:bg-surface-3 active:bg-pressed motion-safe:transition-colors"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={tr('dismiss')}
        onClick={close}
        data-toast-dismiss=""
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-3 hover:text-fg active:bg-pressed motion-safe:transition-colors"
      >
        <X aria-hidden size={14} />
      </button>
    </li>
  );
}

interface Announcement {
  /** Bumps on every announcement so identical text is read again. */
  seq: number;
  toast: ToastRecord;
}

/**
 * Which toasts to read out after the stack changed: those that are new, and
 * those updated in place with a different title (an import moving from
 * "Importing" to "Imported"). Progress ticks that only change the description
 * or the bar stay quiet. Exported for tests.
 */
export function toastsToAnnounce(prev: ReadonlyMap<string, ReactNode>, next: readonly ToastRecord[]): ToastRecord[] {
  return next.filter((t) => !prev.has(t.id) || prev.get(t.id) !== t.title);
}

/**
 * Renders the toast stack (bottom-right). Mount once; the shell does. In element
 * fullscreen (player, multi-view wall) the stack moves into the fullscreen element
 * (portalContainer), so an Undo offered there can be seen and reached.
 *
 * Screen readers hear toasts through two live regions that exist from the
 * first render (a region inserted together with its text is often skipped):
 * errors through the assertive one, everything else through the polite one.
 * The visible list items carry no live role, so the list stays a plain list.
 */
export function ToastViewport() {
  const { t } = useTranslation('common');
  const toasts = useToastStore((s) => s.toasts);
  const [hovered, setHovered] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [polite, setPolite] = useState<Announcement | null>(null);
  const [assertive, setAssertive] = useState<Announcement | null>(null);
  const seen = useRef(new Map<string, ReactNode>());
  const seq = useRef(0);
  const listRef = useRef<HTMLOListElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const overDialog = useCenteredDialogOpen();
  // Over a centred dialog the stack's bottom edge is reported, so below sm (stack at the top)
  // the dialog layer starts under it instead of being covered (Dialog.tsx, toastReserveFor).
  // Wider windows keep the stack at the bottom and the layer ignores the value.
  const reserving = overDialog && toasts.length > 0;
  useLayoutEffect(() => {
    const el = sectionRef.current;
    if (!reserving || !el) {
      reportToastStackBottom(0);
      return;
    }
    const measure = () => reportToastStackBottom(el.getBoundingClientRect().bottom);
    measure();
    window.addEventListener('resize', measure);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => {
      window.removeEventListener('resize', measure);
      ro?.disconnect();
    };
  }, [reserving, toasts]);
  useEffect(() => () => reportToastStackBottom(0), []);
  // The last toast leaving while hovered never fires mouseleave; reset so the next stack starts unpaused.
  useEffect(() => {
    if (toasts.length === 0) setHovered(false);
  }, [toasts.length]);
  useEffect(() => {
    for (const x of toastsToAnnounce(seen.current, toasts)) {
      const a = { seq: ++seq.current, toast: x };
      if (x.variant === 'error') setAssertive(a);
      else setPolite(a);
    }
    seen.current = new Map(toasts.map((x) => [x.id, x.title]));
    // Once a toast leaves the stack its words leave the live region too, so a
    // screen reader's virtual cursor never finds a stale message.
    const live = new Set(toasts.map((x) => x.id));
    const drop = (a: Announcement | null) => (a && !live.has(a.toast.id) ? null : a);
    setPolite(drop);
    setAssertive(drop);
  }, [toasts]);
  // A new toast scrolls into view when the capped list overflows. Updates to a
  // showing toast (progress ticks) leave the user's scroll position alone.
  const lastId = toasts.at(-1)?.id;
  useEffect(() => {
    const list = listRef.current;
    if (list && lastId) list.scrollTop = list.scrollHeight;
  }, [lastId]);
  if (typeof document === 'undefined') return null;
  const spoken = (a: Announcement | null) =>
    a && (
      <p key={a.seq}>
        {a.toast.title}
        {a.toast.description ? <>. {a.toast.description}</> : null}
      </p>
    );
  return createPortal(
    <section
      ref={sectionRef}
      aria-label={t('notifications')}
      aria-keyshortcuts="F8"
      data-toast-viewport=""
      data-over-dialog={overDialog ? '' : undefined}
      className={cn(
        'pointer-events-none fixed end-4 bottom-4 z-[80] w-[min(380px,calc(100vw-32px))]',
        // Below sm a centred dialog spans the window and its footer (Save, Cancel) sits at
        // the bottom, where the toasts are: while one is open they move to the top edge, and
        // the dialog moves down below them (the reserve above), so neither its actions nor
        // its title and close button are covered.
        'max-sm:data-[over-dialog]:top-4 max-sm:data-[over-dialog]:bottom-auto',
      )}>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-toast-live="polite">
        {spoken(polite)}
      </div>
      <div aria-live="assertive" aria-atomic="true" className="sr-only" data-toast-live="assertive">
        {spoken(assertive)}
      </div>
      {/*
        The viewport and the list never take pointer events, only the toasts do,
        so the gaps around them never block the page underneath. The list is
        capped at half the window: a long stack scrolls inside it (newest kept
        in view) instead of covering the content behind it. The negative margin
        plus padding gives each card's shadow-2 room inside the scroll clip; once
        scrolled, the top edge fades instead of slicing the oldest card flat.
        The fade is static (no transition), so reduced motion needs nothing more.
      */}
      <ol
        ref={listRef}
        data-toast-list=""
        data-scrolled={scrolled ? '' : undefined}
        className="pointer-events-none -mx-6 -mt-6 -mb-4 flex max-h-[50vh] flex-col gap-2 overflow-y-auto overscroll-contain px-6 pt-6 pb-4 data-[scrolled]:[mask-image:linear-gradient(to_bottom,transparent,#000_48px)]"
        onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {toasts.map((x) => (
          <ToastItem key={x.id} t={x} paused={hovered} />
        ))}
      </ol>
    </section>,
    portalContainer(),
  );
}

/** Wraps children and renders the viewport. Optional: `toast()` works without it, but nothing shows. */
export function ToastProvider({ children }: { children?: ReactNode }) {
  return (
    <>
      {children}
      <ToastViewport />
    </>
  );
}
