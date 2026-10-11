/**
 * Test doubles for the live feature's imports from @/ui, @/shell, @/features/player and @/features/player/remote.
 * Signatures follow C8, C11 and C16; `playItem` and `playSource` are spies-friendly no-ops.
 */
import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';

import { rpc } from '@/api/transport';
import type { ItemRef, PlayerSource, SourceKind } from '@/api/types';

// ---------------------------------------------------------------------------
// @/ui
// ---------------------------------------------------------------------------

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
};

const VARIANT: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
  secondary: 'bg-surface-2 text-fg border border-border hover:bg-surface-3',
  ghost: 'text-fg hover:bg-surface-2',
  danger: 'bg-danger text-white',
};

export function Button({ variant = 'secondary', size = 'md', icon, loading, className, children, disabled, ...rest }: ButtonProps) {
  const pad = size === 'sm' ? 'h-8 px-3 text-sm' : size === 'lg' ? 'h-11 px-5' : 'h-9 px-4 text-sm';
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center gap-2 rounded-md font-medium focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50 ${pad} ${VARIANT[variant]} ${className ?? ''}`}
    >
      {icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  className,
  size: _size,
  pressed,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: ReactNode; size?: 'sm' | 'md' | 'lg'; pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      {...rest}
      className={`inline-flex size-8 items-center justify-center rounded-md text-fg-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-accent ${className ?? ''}`}
    >
      {icon}
    </button>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className="flex max-h-[85vh] w-full max-w-lg flex-col rounded-lg border border-border bg-surface text-fg shadow-2"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="px-5 pt-4 pb-2 text-lg font-semibold">{title}</h2>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-4">{children}</div>
        {footer ? <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={`rounded bg-surface-3 motion-safe:animate-pulse ${className ?? ''}`} />;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 p-8 text-center">
      {icon ? <div className="text-fg-subtle">{icon}</div> : null}
      <p className="font-medium text-fg">{title}</p>
      {description ? <p className="max-w-sm text-sm text-fg-muted">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="flex flex-col items-center gap-2 p-8 text-center">
      <p className="font-medium text-danger">{message}</p>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-border bg-surface-2 px-1.5 font-mono text-xs">{children}</kbd>;
}

export function useToast(): {
  toast(opts: {
    title: string;
    description?: string;
    variant?: 'info' | 'success' | 'error';
    action?: { label: string; onClick: () => void };
  }): void;
} {
  return {
    toast: (opts) => {
      console.info('[toast]', opts.title, opts.description ?? '');
    },
  };
}

// ---------------------------------------------------------------------------
// @/shell
// ---------------------------------------------------------------------------

export interface ShellHeader {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  search?: { value: string; onChange: (v: string) => void; placeholder?: string };
}

const headers: ShellHeader[] = [];
/** Last non-empty header a page set (pages clear it with `{ title: '' }` on unmount). */
export function lastHeader(): ShellHeader | undefined {
  return [...headers].reverse().find((h) => h.title);
}
const recordHeader = (h: ShellHeader) => void headers.push(h);

export function useShell(): { setHeader(h: ShellHeader): void; setContextPanel(node: ReactNode | null): void } {
  return { setHeader: recordHeader, setContextPanel: () => undefined };
}

export interface Command {
  id: string;
  title: string;
  group: string;
  shortcut?: string;
  keywords?: string[];
  run(): void;
}

export function registerCommands(_cmds: Command[]): () => void {
  return () => undefined;
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

function matchesCombo(combo: string, e: KeyboardEvent): boolean {
  const parts = combo.toLowerCase().split('+');
  const key = parts.pop() ?? '';
  const mod = parts.includes('mod');
  if (mod !== (e.ctrlKey || e.metaKey)) return false;
  if (parts.includes('shift') !== e.shiftKey && key !== '?') return false;
  if (parts.includes('alt') !== e.altKey) return false;
  if (key === 'digit') return /^[0-9]$/.test(e.key);
  if (key === 'space') return e.key === ' ';
  return e.key.toLowerCase() === key;
}

export function useShortcut(
  combo: string,
  handler: (e: KeyboardEvent) => void,
  opts: { description: string; area: string; enabled?: boolean; allowInInput?: boolean },
): void {
  const ref = useRef(handler);
  ref.current = handler;
  const enabled = opts.enabled ?? true;
  const allowInInput = opts.allowInInput ?? false;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!allowInInput && isTypingTarget(e.target)) return;
      if (matchesCombo(combo, e)) ref.current(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [combo, enabled, allowInInput]);
}

// ---------------------------------------------------------------------------
// @/features/player
// ---------------------------------------------------------------------------

export type PlayerMode = 'inline' | 'embedded-mpv' | 'external' | 'radio';
export interface PlayerState {
  source?: PlayerSource;
  mode: PlayerMode;
  status: 'idle' | 'loading' | 'playing' | 'paused' | 'error';
  error?: string;
  isFullscreen: boolean;
  dock: 'stage' | 'mini' | 'hidden';
  volume: number;
  muted: boolean;
  positionSeconds: number;
  durationSeconds?: number;
  queue: PlayerSource[];
  zapContext?: { sourceId: string; categoryId?: string };
}

export const usePlayerStore = create<PlayerState>(() => ({
  mode: 'inline',
  status: 'idle',
  isFullscreen: false,
  dock: 'hidden',
  volume: 1,
  muted: false,
  positionSeconds: 0,
  queue: [],
}));

/** Recorded calls, for assertions. */
export const recorded = { playItem: [] as PlayItemArgs[], playSource: [] as PlayerSource[] };

export async function playSource(source: PlayerSource): Promise<void> {
  recorded.playSource.push(source);
  usePlayerStore.setState({ source, status: 'loading' });
}

type PlayItemArgs = {
  ref: ItemRef;
  episodeId?: string;
  title: string;
  subtitle?: string;
  posterUrl?: string;
  isLive: boolean;
  isRadio?: boolean;
  sourceKind: SourceKind;
};

export async function playItem(args: PlayItemArgs): Promise<void> {
  recorded.playItem.push(args);
  usePlayerStore.setState({
    source: {
    url: '',
    kind: 'hls',
    title: args.title,
    subtitle: args.subtitle,
    posterUrl: args.posterUrl,
    ref: args.ref,
    isLive: args.isLive,
    isRadio: args.isRadio ?? false,
    },
  });
}

export function useChannelZap(): { up(): void; down(): void; selectNumber(n: number): void } {
  return {
    up: () => undefined,
    down: () => undefined,
    selectNumber: (n) => {
      const ctx = usePlayerStore.getState().zapContext;
      if (ctx) void rpc('catalog.channelByNumber', { sourceId: ctx.sourceId, number: n });
    },
  };
}

export const remoteClaims = { count: 0 };
export function claimRemoteChannelCommands(): () => void {
  remoteClaims.count++;
  return () => {
    remoteClaims.count--;
  };
}

export function PlayerStage({ className, children }: { className?: string; children?: ReactNode }) {
  const source = usePlayerStore((s) => s.source);
  return (
    <div data-testid="player-stage" className={`bg-black ${className ?? ''}`}>
      {source ? null : children}
    </div>
  );
}

export function RadioPlayer({ className }: { className?: string; variant?: 'stage' | 'compact' }) {
  return <div data-testid="radio-player" className={className} />;
}
