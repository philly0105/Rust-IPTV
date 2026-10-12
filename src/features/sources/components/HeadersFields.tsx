import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Input } from '@/ui';
import type { DraftErrors, HeadersDraft } from '../lib/draft';
import { Field } from './Field';

/** Collapsible User-Agent / Referer / Origin fields. Opens itself when a value or error is present. */
export function HeadersFields({
  value,
  onChange,
  errors,
  prefix,
  disabled,
}: {
  value: HeadersDraft;
  onChange: (next: HeadersDraft) => void;
  errors: DraftErrors;
  prefix: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation('sources');
  const hasValue = Boolean(value.userAgent || value.referrer || value.origin);
  const hasError = Boolean(errors[`${prefix}.userAgent`] || errors[`${prefix}.referrer`] || errors[`${prefix}.origin`]);
  const err = (k: keyof HeadersDraft) => {
    const key = errors[`${prefix}.${k}`];
    return key ? t(key) : null;
  };
  return (
    <details className="group rounded-md border border-border bg-surface-2/50" open={hasValue || hasError || undefined}>
      <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-fg hover:bg-surface-2 active:bg-surface-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle motion-safe:transition-transform rtl:-scale-x-100 ltr:group-open:rotate-90 rtl:group-open:-rotate-90" />
        {t('requestHeaders')}
        {hasValue ? <span className="text-xs font-normal text-fg-subtle">{t('requestHeadersSet')}</span> : null}
      </summary>
      <div className="grid gap-4 px-3 pb-4 pt-1">
        <p className="text-sm text-fg-muted">{t('requestHeadersHint')}</p>
        <Field label={t('userAgent')} optional optionalLabel={t('optional')} error={err('userAgent')}>
          {(p) => (
            <Input
              {...p}
              value={value.userAgent}
              disabled={disabled}
              autoComplete="off"
              spellCheck={false}
              placeholder="VLC/3.0.20 LibVLC/3.0.20"
              onChange={(e) => onChange({ ...value, userAgent: e.target.value })}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('referrer')} optional optionalLabel={t('optional')} error={err('referrer')}>
            {(p) => (
              <Input
                {...p}
                value={value.referrer}
                disabled={disabled}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com/"
                onChange={(e) => onChange({ ...value, referrer: e.target.value })}
              />
            )}
          </Field>
          <Field label={t('origin')} optional optionalLabel={t('optional')} error={err('origin')}>
            {(p) => (
              <Input
                {...p}
                value={value.origin}
                disabled={disabled}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://example.com"
                onChange={(e) => onChange({ ...value, origin: e.target.value })}
              />
            )}
          </Field>
        </div>
      </div>
    </details>
  );
}
