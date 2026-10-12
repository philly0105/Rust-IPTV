import { CircleAlert, RotateCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { RpcError } from '@/api/transport';
import type { RpcErrorCode } from '@/api/types';

import { Button } from './Button';
import { cn } from './cn';

export interface EmptyStateProps {
  /** Icon element, e.g. `<Tv size={28} />`. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Primary next step, usually a Button or link. */
  action?: ReactNode;
  className?: string;
  /** `page` centers in the available space; `inline` is compact for rails and panels. */
  size?: 'page' | 'inline';
}

export function EmptyState({ icon, title, description, action, className, size = 'page' }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'page' ? 'min-h-[320px] gap-4 px-6 py-16' : 'gap-2 px-4 py-8',
        className,
      )}
    >
      {icon && (
        <div
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full border border-border bg-surface-2 text-fg-muted',
            size === 'page' ? 'h-16 w-16' : 'h-11 w-11',
          )}
        >
          {icon}
        </div>
      )}
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className={cn(size === 'page' ? 'text-xl' : 'text-base')}>{title}</h2>
        {description && <p className="text-sm text-fg-muted">{description}</p>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

/** i18n key (common namespace) of the next-step hint for each error code. */
export const ERROR_HINT_KEYS: Record<RpcErrorCode, string> = {
  network: 'errorHintNetwork',
  timeout: 'errorHintTimeout',
  auth: 'errorHintAuth',
  not_found: 'errorHintNotFound',
  invalid: 'errorHintInvalid',
  unsupported: 'errorHintUnsupported',
  conflict: 'errorHintConflict',
  io: 'errorHintIo',
  db: 'errorHintDb',
  internal: 'errorHintInternal',
};

/** i18n key (common namespace) of the short title for each error code. */
export const ERROR_TITLE_KEYS: Record<RpcErrorCode, string> = {
  network: 'errorTitleNetwork',
  timeout: 'errorTitleTimeout',
  auth: 'errorTitleAuth',
  not_found: 'errorTitleNotFound',
  invalid: 'errorTitleInvalid',
  unsupported: 'errorTitleUnsupported',
  conflict: 'errorTitleConflict',
  io: 'errorTitleIo',
  db: 'errorTitleDb',
  internal: 'errorTitleInternal',
};

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Extra action next to Retry (e.g. a link to source settings). */
  action?: ReactNode;
  className?: string;
  size?: 'page' | 'inline';
  /** Overrides the code-derived title. */
  title?: ReactNode;
  /** A retry is in flight: Retry shows a spinner and ignores presses (focus stays on it). */
  retrying?: boolean;
}

/**
 * True when the transport could not reach the app's own server (web mode `fetch` failed).
 * transport.ts marks these with `details.transport === 'unreachable'`.
 */
export function isServerUnreachable(err: RpcError): boolean {
  const d = err.details;
  return err.code === 'network' && typeof d === 'object' && d !== null && (d as { transport?: unknown }).transport === 'unreachable';
}

/**
 * Renders an RpcError's message plus a next-step hint chosen by its code. When the app's own
 * server is unreachable the body and hint are translated and the raw browser text moves into a
 * details disclosure.
 */
export function ErrorState({ error, onRetry, action, className, size = 'page', title, retrying = false }: ErrorStateProps) {
  const { t } = useTranslation('common');
  const err = RpcError.from(error);
  const unreachable = isServerUnreachable(err);
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center text-center',
        size === 'page' ? 'min-h-[320px] gap-4 px-6 py-16' : 'gap-2 px-4 py-6',
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center rounded-full border border-danger/40 bg-danger/10 text-danger',
          size === 'page' ? 'h-16 w-16' : 'h-10 w-10',
        )}
      >
        <CircleAlert size={size === 'page' ? 28 : 20} />
      </div>
      <div className="flex max-w-lg flex-col gap-1.5">
        <h2 className={cn(size === 'page' ? 'text-xl' : 'text-base')}>{title ?? t(ERROR_TITLE_KEYS[err.code])}</h2>
        <p className="text-sm break-words text-fg-muted">{unreachable ? t('errorBodyServerUnreachable') : err.message}</p>
        <p className="text-sm text-fg">{t(unreachable ? 'errorHintServerUnreachable' : ERROR_HINT_KEYS[err.code])}</p>
        {unreachable && (
          <details className="text-xs text-fg-subtle">
            <summary className="cursor-pointer rounded-sm hover:text-fg-muted">{t('errorTechnicalDetails')}</summary>
            <p className="mt-1 font-mono break-words" dir="ltr">
              {err.message}
            </p>
          </details>
        )}
      </div>
      {(onRetry || action) && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button
              variant="primary"
              size={size === 'page' ? 'md' : 'sm'}
              icon={<RotateCw size={16} aria-hidden />}
              loading={retrying}
              onClick={onRetry}
            >
              {t('retry')}
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
