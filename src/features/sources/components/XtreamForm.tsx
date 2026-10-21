import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';

import { Input } from '@/ui';
import { buildXtreamConfig, type DraftErrors, type XtreamDraft } from '../lib/draft';
import { hasEdgeSpace, inputHost, parseXtreamLink } from '../lib/validate';
import { ConnectionTest } from './ConnectionTest';
import { Field } from './Field';
import { HeadersFields } from './HeadersFields';
import { SecretInput } from './SecretInput';

export function XtreamForm({
  value,
  onChange,
  errors,
  onErrors,
  disabled,
  onFieldBlur,
  autoFocusAddress,
  showHeaders = true,
}: {
  value: XtreamDraft;
  onChange: (next: XtreamDraft) => void;
  errors: DraftErrors;
  /** Lets the test button surface field errors without submitting. */
  onErrors: (errors: DraftErrors) => void;
  disabled?: boolean;
  /** Validates one field (error path, e.g. `xtream.serverUrl`) when the user leaves it. */
  onFieldBlur?: (path: string) => void;
  /** The Add dialog opens on the server address (SS-2). */
  autoFocusAddress?: boolean;
  /** False: the dialog draws the request headers itself, with the other advanced options last. */
  showHeaders?: boolean;
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
    if (link) onChange({ ...value, ...link });
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
            data-autofocus={autoFocusAddress ? '' : undefined}
            value={value.serverUrl}
            onChange={(e) => onServerChange(e.target.value)}
            onBlur={() => onFieldBlur?.('xtream.serverUrl')}
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
      {showHeaders ? (
        <HeadersFields
          value={value.headers}
          onChange={(headers) => set({ headers })}
          errors={errors}
          prefix="xtream.headers"
          disabled={disabled}
        />
      ) : null}
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
