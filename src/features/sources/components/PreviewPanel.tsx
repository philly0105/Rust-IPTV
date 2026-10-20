import { useTranslation } from 'react-i18next';

import { Button, Skeleton } from '@/ui';
import { formatCount } from '../lib/format';
import { redactText, redactUrl } from '../lib/redact';
import type { PreviewState } from '../lib/usePreview';

const MAX_GROUPS = 14;

/** Live summary of a pasted or uploaded playlist from `m3u.parsePreview`. */
export function PreviewPanel({ state }: { state: PreviewState }) {
  const { t, i18n } = useTranslation('sources');
  if (state.status === 'idle') return null;

  return (
    <section aria-live="polite" aria-label={t('previewTitle')} className="rounded-md border border-edge bg-surface-2/60 p-4">
      {state.status === 'loading' ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <span className="sr-only">{t('previewLoading')}</span>
          <Skeleton className="h-7 w-40" />
          <div className="flex flex-wrap gap-1.5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-6 w-20" />
            ))}
          </div>
        </div>
      ) : null}

      {state.status === 'error' ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-danger" data-testid="preview-error">
          <p className="min-w-0 flex-1">{t('previewFailed', { message: redactText(state.error.message) })}</p>
          <Button size="sm" variant="secondary" onClick={state.retry}>
            {t('tryAgain')}
          </Button>
        </div>
      ) : null}

      {state.status === 'ready' ? (
        state.preview.channelCount === 0 ? (
          <p className="text-sm text-warning">{t('previewEmpty')}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-baseline gap-2">
              <span className="font-display text-2xl font-semibold tabular-nums text-fg" data-testid="preview-channel-count">
                {formatCount(state.preview.channelCount, i18n.language)}
              </span>
              <span className="text-sm text-fg-muted">
                {t('previewChannels', { count: state.preview.channelCount })}
                {state.truncated ? ` ${t('previewTruncated')}` : ''}
              </span>
            </p>
            {state.preview.groups.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-sm text-fg-muted">{t('previewGroups', { count: state.preview.groups.length })}</span>
                <ul className="flex flex-wrap gap-1.5">
                  {state.preview.groups.slice(0, MAX_GROUPS).map((g, i) => (
                    <li key={`${i}:${g}`} className="max-w-56 truncate rounded-sm border border-edge bg-surface px-2 py-0.5 text-xs text-fg">
                      {g}
                    </li>
                  ))}
                  {state.preview.groups.length > MAX_GROUPS ? (
                    <li className="px-1 py-0.5 text-xs text-fg-subtle">
                      {t('previewMoreGroups', { count: state.preview.groups.length - MAX_GROUPS })}
                    </li>
                  ) : null}
                </ul>
              </div>
            ) : null}
            {state.preview.epgUrls.length > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="text-sm text-fg-muted">{t('previewEpg', { count: state.preview.epgUrls.length })}</span>
                <ul className="flex flex-col gap-0.5">
                  {state.preview.epgUrls.map((u, i) => (
                    <li key={`${i}:${u}`} className="truncate font-mono text-xs text-fg" title={redactUrl(u)}>
                      {redactUrl(u)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )
      ) : null}
    </section>
  );
}
