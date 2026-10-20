import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { EpgLinks } from '@/api/types';
import { parseGuideShift } from '@/lib/guideShift';

import { Badge, Button, IconButton, Input, Toggle } from '@/ui';
import { addManualEpgUrl, epgRows, removeManualEpgUrl, setEpgUrlEnabled } from '../lib/epgLinks';
import { redactUrl } from '../lib/redact';
import { Field } from './Field';

/** The shift field's text for stored links: blank for none. */
export function shiftTextOf(links: EpgLinks): string {
  return links.shiftMinutes ? String(links.shiftMinutes) : '';
}

/**
 * Per-source EPG URLs (detected from the playlist/portal, added by hand, and disabled), and the
 * source's guide time shift. The dialog owns the shift's typed text (`shiftText`), so it can
 * refuse to save while the text is not a shift (SS-16) and keep it across tab switches.
 */
export function EpgLinksEditor({
  value,
  onChange,
  disabled,
  shiftText,
  onShiftTextChange,
}: {
  value: EpgLinks;
  onChange: (next: EpgLinks) => void;
  disabled?: boolean;
  shiftText: string;
  onShiftTextChange: (text: string) => void;
}) {
  const { t } = useTranslation('sources');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The links take the typed text only while it is a valid shift.
  const shiftValid = parseGuideShift(shiftText) !== null;
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
        <p className="rounded-md border border-dashed border-edge px-4 py-6 text-center text-sm text-fg-muted">{t('epgLinksEmpty')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider rounded-md border border-edge" aria-label={t('epgLinks')}>
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
      <Field label={t('epgShift')} hint={t('epgShiftHint')} error={shiftValid ? null : t('epgShiftError')}>
        {(p) => (
          <div className="flex items-center gap-2">
            <Input
              {...p}
              type="text"
              // Not "numeric": phone keypads for it have no minus sign, and the shift can be negative.
              inputMode="text"
              autoComplete="off"
              disabled={disabled}
              placeholder="0"
              value={shiftText}
              className="w-28 text-end tabular-nums"
              data-testid="epg-shift-minutes"
              onChange={(e) => {
                onShiftTextChange(e.target.value);
                const minutes = parseGuideShift(e.target.value);
                if (minutes !== null) onChange({ ...value, shiftMinutes: minutes });
              }}
            />
            <span className="text-sm text-fg-muted">{t('epgShiftUnit')}</span>
          </div>
        )}
      </Field>
    </div>
  );
}
