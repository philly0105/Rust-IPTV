import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';

import { Input } from '@/ui';
import { buildXtreamConfig, type DraftErrors, type XtreamDraft } from '../lib/draft';
import { hasEdgeSpace, inputHost, parseXtreamLink } from '../lib/validate';
import { ConnectionTest } from './ConnectionTest';
import { Field } from './Field';
import { SecretInput } from './SecretInput';

export function XtreamForm({
  value,
  onChange,
  errors,
  onErrors,
  disabled,
  onSuggestName,
  onFieldBlur,
}: {
  value: XtreamDraft;
  onChange: (next: XtreamDraft) => void;
  errors: DraftErrors;
  /** Lets the test button surface field errors without submitting. */
  onErrors: (errors: DraftErrors) => void;
  disabled?: boolean;
  onSuggestName?: (input: string) => void;
  /** Validates one field (error path, e.g. `xtream.serverUrl`) when the user leaves it. */
  onFieldBlur?: (path: string) => void;
}) {
  const { t } = useTranslation('sources');
  const set = (patch: Partial<XtreamDraft>) => onChange({ ...value, ...patch });
  const err = (k: string) => {
    const key = errors[k];
    return key ? t(key) : null;
  };

  /** Pasting a full `get.php?username=&password=` link fills all three fields. */
  const onServerChange = (raw: string) => {
    const link = parseXtreamLink(raw);
    if (link) onChange({ ...link });
    else set({ serverUrl: raw });
  };

  return (
    <div className="flex flex-col gap-5">
      <Field label={t('serverUrl')} error={err('xtream.serverUrl')} hint={t('serverUrlHint')}>
        {(p) => (
          <Input
            {...p}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder="http://provider.example:8080"
            value={value.serverUrl}
            onChange={(e) => onServerChange(e.target.value)}
            onBlur={() => {
              onSuggestName?.(value.serverUrl);
              onFieldBlur?.('xtream.serverUrl');
            }}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('username')} error={err('xtream.username')}>
          {(p) => (
            <Input
              {...p}
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              value={value.username}
              onChange={(e) => set({ username: e.target.value })}
            />
          )}
        </Field>
        <Field label={t('password')} error={err('xtream.password')} hint={hasEdgeSpace(value.password) ? t('passwordSpaceHint') : undefined}>
          {(p) => <SecretInput {...p} disabled={disabled} value={value.password} onChange={(e) => set({ password: e.target.value })} />}
        </Field>
      </div>
      <ConnectionTest
        kind="xtream"
        disabled={disabled}
        inputs={JSON.stringify(value)}
        host={inputHost(value.serverUrl)}
        run={() => {
          const built = buildXtreamConfig(value);
          onErrors(built.errors);
          return built.ok ? rpc('xtream.test', { config: built.value }) : null;
        }}
      />
    </div>
  );
}
