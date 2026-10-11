import { FolderOpen, ScanSearch } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate } from '@/api/query';
import { RpcError, isDesktop, rpc } from '@/api/transport';

import { Button, IconButton } from '../../sources/_shim';
import { pickExecutableDesktop } from '../../sources/lib/files';
import { CommitInput, SettingsGroup, SettingsRow, SettingsSection } from '../components';
import { cleanPath, optionalStringPatch, validateArgs } from '../lib/patch';
import type { SectionProps } from './types';

type DetectState = { status: 'idle' } | { status: 'running' } | { status: 'done'; mpv?: string; vlc?: string } | { status: 'failed'; message: string };

export function PlayersSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [detect, setDetect] = useState<DetectState>({ status: 'idle' });
  const setError = (k: string) => (e: string | null) => setErrors((prev) => ({ ...prev, [k]: e }));
  const err = (k: string) => (errors[k] ? t(errors[k] as string) : null);

  const savePath = async (key: 'mpvPath' | 'vlcPath', raw: string) => {
    if (await update(optionalStringPatch(key, cleanPath(raw)))) void invalidate('player.');
  };

  const runDetect = async () => {
    setDetect({ status: 'running' });
    try {
      const found = await rpc('settings.detectPlayers');
      setDetect({ status: 'done', mpv: found.mpvPath, vlc: found.vlcPath });
      const patch: { mpvPath?: string; vlcPath?: string } = {};
      if (found.mpvPath && found.mpvPath !== settings.mpvPath) patch.mpvPath = found.mpvPath;
      if (found.vlcPath && found.vlcPath !== settings.vlcPath) patch.vlcPath = found.vlcPath;
      if (Object.keys(patch).length > 0 && (await update(patch))) void invalidate('player.');
    } catch (e) {
      setDetect({ status: 'failed', message: RpcError.from(e).message });
    }
  };

  const browse = async (key: 'mpvPath' | 'vlcPath') => {
    try {
      const path = await pickExecutableDesktop(key === 'mpvPath' ? t('chooseMpv') : t('chooseVlc'));
      if (path) await savePath(key, path);
    } catch (e) {
      setDetect({ status: 'failed', message: RpcError.from(e).message });
    }
  };

  const pathRow = (key: 'mpvPath' | 'vlcPath', label: string, placeholder: string) => (
    <SettingsRow label={label} description={isDesktop ? t('playerPathHint') : t('playerPathHintServer')} error={err(key)} stack>
      {({ id, describedBy }) => (
        <div className="flex w-full items-center gap-2">
          <CommitInput
            id={id}
            describedBy={describedBy}
            mono
            value={settings[key] ?? ''}
            placeholder={placeholder}
            onError={setError(key)}
            validate={(v) => (/[\r\n]/.test(v) ? 'errorPathNewline' : null)}
            onCommit={(v) => void savePath(key, v)}
            testId={`input-${key}`}
          />
          {isDesktop ? (
            <IconButton label={t('browse')} icon={<FolderOpen aria-hidden className="size-4" />} onClick={() => void browse(key)} />
          ) : null}
        </div>
      )}
    </SettingsRow>
  );

  const argsRow = (key: 'mpvArgs' | 'vlcArgs', label: string, placeholder: string) => (
    <SettingsRow label={label} description={t('extraArgsHint')} error={err(key)} stack>
      {({ id, describedBy }) => (
        <CommitInput
          id={id}
          describedBy={describedBy}
          mono
          value={settings[key]}
          placeholder={placeholder}
          onError={setError(key)}
          validate={validateArgs}
          onCommit={(v) => void update({ [key]: v.trim() })}
          testId={`input-${key}`}
        />
      )}
    </SettingsRow>
  );

  return (
    <SettingsSection title={t('sectionPlayers')} description={t('sectionPlayersLead')} testId="settings-players">
      <SettingsGroup
        title={t('playerPaths')}
        description={t('playerPathsHint')}
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={<ScanSearch aria-hidden className="size-4" />}
            loading={detect.status === 'running'}
            onClick={() => void runDetect()}
            data-testid="detect-players"
          >
            {t('detectPlayers')}
          </Button>
        }
      >
        {detect.status === 'done' || detect.status === 'failed' ? (
          <p aria-live="polite" className="px-4 py-3 text-sm" data-testid="detect-result">
            {detect.status === 'failed' ? (
              <span className="text-danger">{t('detectFailed', { message: detect.message })}</span>
            ) : (
              <span className="text-fg-muted">
                {detect.mpv ? t('detectFound', { player: 'mpv', path: detect.mpv }) : t('detectMissing', { player: 'mpv' })}{' '}
                {detect.vlc ? t('detectFound', { player: 'VLC', path: detect.vlc }) : t('detectMissing', { player: 'VLC' })}
              </span>
            )}
          </p>
        ) : null}
        {pathRow('mpvPath', t('mpvPath'), 'C:\\Program Files\\mpv\\mpv.exe')}
        {pathRow('vlcPath', t('vlcPath'), 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe')}
      </SettingsGroup>

      <SettingsGroup title={t('extraArgs')}>
        {argsRow('mpvArgs', t('mpvArgs'), '--hwdec=auto --cache=yes')}
        {argsRow('vlcArgs', t('vlcArgs'), '--network-caching=1500')}
      </SettingsGroup>
    </SettingsSection>
  );
}
