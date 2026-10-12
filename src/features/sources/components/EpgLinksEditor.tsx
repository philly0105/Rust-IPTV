import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgLinks } from '@/api/types';

import { Badge, Button, IconButton, Input, Toggle } from '@/ui';
import { addManualEpgUrl, epgRows, removeManualEpgUrl, setEpgUrlEnabled } from '../lib/epgLinks';
import { redactUrl } from '../lib/redact';
import { Field } from './Field';

/** Per-source EPG URLs: detected from the playlist/portal, added by hand, and disabled. */
export function EpgLinksEditor({ value, onChange, disabled }: { value: EpgLinks; onChange: (next: EpgLinks) => void; disabled?: boolean }) {
  const { t } = useTranslation('sources');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const rows = epgRows(value);

  const add = () => {
    const r = addManualEpgUrl(value, draft);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setDraft('');
    onChange(r.links);
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-fg-muted">{t('epgLinksHint')}</p>
      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-fg-muted">{t('epgLinksEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider rounded-md border border-border" aria-label={t('epgLinks')}>
          {rows.map((row) => {
            // Xtream's detected xmltv.php link carries the account password.
            const shown = redactUrl(row.url);
            return (
              <li key={row.url} className="flex items-center gap-3 px-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className={`truncate font-mono text-sm ${row.enabled ? 'text-fg' : 'text-fg-subtle line-through'}`} title={shown} data-testid="epg-link-url">
                    {shown}
                  </span>
                  <span>
                    <Badge>{row.origin === 'detected' ? t('epgDetected') : t('epgManual')}</Badge>
                  </span>
                </div>
                <div className="shrink-0">
                  <Toggle
                    checked={row.enabled}
                    disabled={disabled}
                    onChange={(enabled) => onChange(setEpgUrlEnabled(value, row.url, enabled))}
                    label={<span className="sr-only">{t('epgUseUrl', { url: shown })}</span>}
                  />
                </div>
                {row.origin === 'manual' ? (
                  <IconButton
                    label={t('epgRemoveUrl', { url: shown })}
                    icon={<Trash2 aria-hidden className="size-4" />}
                    disabled={disabled}
                    onClick={() => onChange(removeManualEpgUrl(value, row.url))}
                  />
                ) : (
                  <span aria-hidden className="size-9 shrink-0" />
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-start gap-2">
        <Field label={t('epgAddUrl')} error={error ? t(error) : null} className="flex-1">
          {(p) => (
            <Input
              {...p}
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
              placeholder="https://epg.example/guide.xml.gz"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
            />
          )}
        </Field>
        <Button icon={<Plus aria-hidden className="size-4" />} disabled={disabled || !draft.trim()} onClick={add} className="mt-[1.625rem] shrink-0">
          {t('epgAddButton')}
        </Button>
      </div>
    </div>
  );
}
