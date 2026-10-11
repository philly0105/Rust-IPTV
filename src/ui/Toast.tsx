import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';

import { cn } from './cn';
import { ProgressBar } from './Misc';

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
      return { toasts: [...s.toasts, t].slice(-MAX_VISIBLE) };
    }),
  // No-op (same state, no re-render) when the id is not showing.
  dismiss: (id) => set((s) => (s.toasts.some((t) => t.id === id) ? { toasts: s.toasts.filter((t) => t.id !== id) } : s)),
  clear: () => set({ toasts: [] }),
}));

let seq = 0;

const VIEWPORT_SELECTOR = '[data-toast-viewport]';
const TOAST_SELECTOR = '[data-toast-id]';
/** Where focus was before the user jumped into the toast stack (F8). */
let returnFocus: HTMLElement | null = null;

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

/** Puts focus back where it was before entering the stack, or on main content. */
function leaveToasts(): void {
  const back = returnFocus && returnFocus.isConnected ? returnFocus : document.getElementById('main');
  returnFocus = null;
  back?.focus({ preventScroll: true });
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

function ToastItem({ t }: { t: ToastRecord }) {
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
    if (duration > 0) timer.current = setTimeout(close, duration);
  };

  useEffect(() => {
    arm();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // Re-arm whenever the toast content is updated in place.
  }, [t, duration]);

  const Icon = t.variant === 'success' ? CircleCheck : t.variant === 'error' ? CircleAlert : Info;
  return (
    <li
      ref={liRef}
      data-toast-id={t.id}
      onKeyDown={onKeyDown}
      role={t.variant === 'error' ? 'alert' : 'status'}
      aria-live={t.variant === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={() => timer.current && clearTimeout(timer.current)}
      onMouseLeave={(e) => {
        if (!e.currentTarget.contains(document.activeElement)) arm();
      }}
      onFocus={() => timer.current && clearTimeout(timer.current)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) arm();
      }}
      className={cn(
        'pointer-events-auto relative flex w-full gap-3 overflow-hidden rounded-md border border-border bg-surface-2 py-3 pe-2 ps-4 shadow-2',
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
        {t.description && <p className="text-[13px] break-words text-fg-muted">{t.description}</p>}
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
            className="mt-1 self-start rounded-sm text-sm font-semibold text-accent hover:underline"
          >
            {t.action.label}
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label={tr('dismiss')}
        onClick={close}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-fg-subtle hover:bg-surface-3 hover:text-fg"
      >
        <X aria-hidden size={14} />
      </button>
    </li>
  );
}

/** Renders the toast stack (bottom-right). Mount once; the shell does. */
export function ToastViewport() {
  const { t } = useTranslation('common');
  const toasts = useToastStore((s) => s.toasts);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <section
      aria-label={t('notifications')}
      aria-keyshortcuts="F8"
      data-toast-viewport=""
      className="pointer-events-none fixed end-4 bottom-4 z-[80] w-[min(380px,calc(100vw-32px))]">
      <ol className="flex flex-col gap-2">
        {toasts.map((x) => (
          <ToastItem key={x.id} t={x} />
        ))}
      </ol>
    </section>,
    document.body,
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
