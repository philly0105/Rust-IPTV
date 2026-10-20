import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { rpc } from '@/api/transport';

import { Input, Toggle } from '@/ui';
import { buildStalkerConfig, type DraftErrors, type StalkerDraft } from '../lib/draft';
import { INFOMIR_MAC_OUI, formatMacInput, hasEdgeSpace, hasInfomirOui, inputHost, looksLikeFullPortal, normalizeMac } from '../lib/validate';
import { ConnectionTest } from './ConnectionTest';
import { Field } from './Field';
import { HeadersFields } from './HeadersFields';
import { SecretInput } from './SecretInput';

const IDENTITY_FIELDS = ['serialNumber', 'deviceId1', 'deviceId2', 'signature1', 'signature2'] as const;

export function StalkerForm({
  value,
  onChange,
  errors,
  onErrors,
  disabled,
  storedMac,
  onSuggestName,
  onFieldBlur,
}: {
  value: StalkerDraft;
  onChange: (next: StalkerDraft) => void;
  errors: DraftErrors;
  onErrors: (errors: DraftErrors) => void;
  disabled?: boolean;
  /** Edit mode: the MAC already on the wire stays valid even if malformed. */
  storedMac?: string;
  onSuggestName?: (input: string) => void;
  /** Validates one field (error path, e.g. `stalker.macAddress`) when the user leaves it. */
  onFieldBlur?: (path: string) => void;
}) {
  const { t } = useTranslation('sources');
  const set = (patch: Partial<StalkerDraft>) => onChange({ ...value, ...patch });
  const err = (k: string) => {
    const key = errors[k];
    return key ? t(key) : null;
  };

  const onPortalChange = (portalUrl: string) => {
    // Turn on full-portal mode the first time the URL reveals it; never turn it off silently.
    const becameFull = looksLikeFullPortal(portalUrl) && !looksLikeFullPortal(value.portalUrl);
    set({ portalUrl, isFullPortal: becameFull ? true : value.isFullPortal });
  };

  const onMacChange = (raw: string) => {
    if (storedMac !== undefined && raw === storedMac) {
      set({ macAddress: raw });
      return;
    }
    set({ macAddress: formatMacInput(raw) });
  };

  const macValid = normalizeMac(value.macAddress) !== null;
  const macHint =
    macValid && !hasInfomirOui(value.macAddress) ? t('macOuiHint', { oui: INFOMIR_MAC_OUI }) : t('macHint');
  const identityFilled = IDENTITY_FIELDS.some((k) => value[k]);

  return (
    <div className="flex flex-col gap-5">
      <Field label={t('portalUrl')} error={err('stalker.portalUrl')} hint={t('portalUrlHint')}>
        {(p) => (
          <Input
            {...p}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
            placeholder="http://portal.example/c/"
            value={value.portalUrl}
            onChange={(e) => onPortalChange(e.target.value)}
            onBlur={() => {
              onSuggestName?.(value.portalUrl);
              onFieldBlur?.('stalker.portalUrl');
            }}
          />
        )}
      </Field>
      <Field label={t('macAddress')} error={err('stalker.macAddress')} hint={macHint}>
        {(p) => (
          <Input
            {...p}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="characters"
            disabled={disabled}
            placeholder="00:1A:79:00:00:00"
            className="font-mono tracking-wide"
            value={value.macAddress}
            onChange={(e) => onMacChange(e.target.value)}
            onBlur={() => onFieldBlur?.('stalker.macAddress')}
          />
        )}
      </Field>
      <Toggle
        checked={value.isFullPortal}
        onChange={(isFullPortal) => set({ isFullPortal })}
        disabled={disabled}
        label={t('fullPortal')}
        description={t('fullPortalHint')}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('username')} optional optionalLabel={t('optional')}>
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
        <Field
          label={t('password')}
          optional
          optionalLabel={t('optional')}
          hint={hasEdgeSpace(value.password) ? t('passwordSpaceHint') : undefined}
        >
          {(p) => <SecretInput {...p} disabled={disabled} value={value.password} onChange={(e) => set({ password: e.target.value })} />}
        </Field>
      </div>

      <details className="group rounded-md border border-edge bg-surface-2/50" open={identityFilled || undefined}>
        <summary className="flex cursor-pointer select-none items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium text-fg hover:bg-hover active:bg-active [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="size-4 shrink-0 text-fg-subtle motion-safe:transition-transform rtl:-scale-x-100 ltr:group-open:rotate-90 rtl:group-open:-rotate-90" />
          {t('deviceIdentity')}
        </summary>
        <div className="grid gap-4 px-3 pb-4 pt-1 sm:grid-cols-2">
          <p className="text-sm text-fg-muted sm:col-span-2">{t('deviceIdentityHint')}</p>
          {IDENTITY_FIELDS.map((k) => (
            <Field key={k} label={t(k)} optional optionalLabel={t('optional')} className={k === 'serialNumber' ? 'sm:col-span-2' : undefined}>
              {(p) => (
                <Input
                  {...p}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={disabled}
                  className="font-mono text-sm"
                  value={value[k]}
                  onChange={(e) => set({ [k]: e.target.value } as Partial<StalkerDraft>)}
                />
              )}
            </Field>
          ))}
        </div>
      </details>

      <HeadersFields
        value={value.headers}
        onChange={(headers) => set({ headers })}
        errors={errors}
        prefix="stalker.headers"
        disabled={disabled}
      />

      <ConnectionTest
        kind="stalker"
        disabled={disabled}
        inputs={JSON.stringify(value)}
        host={inputHost(value.portalUrl)}
        run={() => {
          const built = buildStalkerConfig(value, storedMac);
          onErrors(built.errors);
          return built.ok ? rpc('stalker.test', { config: built.value }) : null;
        }}
      />
    </div>
  );
}
