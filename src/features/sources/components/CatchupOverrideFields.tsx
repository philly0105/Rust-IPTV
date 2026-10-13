import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { CatchupOverrideType } from '@/api/types';
import { Input, Select, type SelectOption } from '@/ui';

import { CATCHUP_DAYS_MAX, CATCHUP_OVERRIDE_TYPES, CATCHUP_TEMPLATE_MAX, type CatchupDraft, type DraftErrors } from '../lib/draft';
import { Field } from './Field';

function isOverrideType(v: string): v is CatchupOverrideType {
  return CATCHUP_OVERRIDE_TYPES.some((t) => t === v);
}

/**
 * Guide slice: catch-up override for every live channel of an M3U source. Collapsed unless an
 * override is set or a field has an error, like the request headers above it.
 */
export function CatchupOverrideFields({
  value,
  onChange,
  errors,
  disabled,
}: {
  value: CatchupDraft;
  onChange: (next: CatchupDraft) => void;
  errors: DraftErrors;
  disabled?: boolean;
}) {
  const { t } = useTranslation('sources');
  const templateError = errors['m3u.catchup.template'];
  const daysError = errors['m3u.catchup.days'];
  const hasError = Boolean(templateError || daysError);
  const options: SelectOption[] = [
    { value: '', label: t('catchupTypePlaylist') },
    { value: 'default', label: t('catchupTypeDefault') },
    { value: 'append', label: t('catchupTypeAppend') },
    { value: 'shift', label: t('catchupTypeShift') },
    { value: 'flussonic', label: t('catchupTypeFlussonic') },
    { value: 'xc', label: t('catchupTypeXc') },
    { value: 'none', label: t('catchupTypeNone') },
  ];
  const fieldsOn = value.type !== '' && value.type !== 'none';
  return (
    <details className="group rounded-md border border-border bg-surface-2/50" open={value.type !== '' || hasError || undefined} data-testid="catchup-override">
      <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-fg hover:bg-surface-2 active:bg-surface-3 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle motion-safe:transition-transform rtl:-scale-x-100 ltr:group-open:rotate-90 rtl:group-open:-rotate-90" />
        {t('catchupOverride')}
        {value.type !== '' ? <span className="text-xs font-normal text-fg-subtle">{t('catchupOverrideSet')}</span> : null}
      </summary>
      <div className="grid gap-4 px-3 pb-4 pt-1">
        <p className="text-sm text-fg-muted">{t('catchupOverrideHint')}</p>
        <Select
          label={t('catchupType')}
          options={options}
          value={value.type}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, type: isOverrideType(v) ? v : '' })}
          data-testid="catchup-type"
        />
        {fieldsOn ? (
          <>
            <Field
              label={t('catchupTemplate')}
              optional
              optionalLabel={t('optional')}
              hint={t('catchupTemplateHint')}
              error={templateError ? t(templateError, { max: CATCHUP_TEMPLATE_MAX }) : null}
            >
              {(p) => (
                <Input
                  {...p}
                  value={value.template}
                  disabled={disabled}
                  autoComplete="off"
                  spellCheck={false}
                  dir="ltr"
                  maxLength={CATCHUP_TEMPLATE_MAX}
                  placeholder="?utc={utc}&lutc={lutc}"
                  onChange={(e) => onChange({ ...value, template: e.target.value })}
                  data-testid="catchup-template"
                />
              )}
            </Field>
            <Field
              label={t('catchupDays')}
              optional
              optionalLabel={t('optional')}
              hint={t('catchupDaysHint')}
              error={daysError ? t(daysError, { max: CATCHUP_DAYS_MAX }) : null}
            >
              {(p) => (
                <Input
                  {...p}
                  value={value.days}
                  disabled={disabled}
                  inputMode="numeric"
                  autoComplete="off"
                  className="w-28"
                  placeholder="7"
                  onChange={(e) => onChange({ ...value, days: e.target.value })}
                  data-testid="catchup-days"
                />
              )}
            </Field>
          </>
        ) : null}
      </div>
    </details>
  );
}
