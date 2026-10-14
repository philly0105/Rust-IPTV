import { clsx } from 'clsx';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import type { Settings, StreamFormat, VideoPlayer } from '@/api/types';

import { Button, Skeleton } from '@/ui';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow } from '../components';
import type { SectionProps } from './types';

type BoolKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

const TOGGLES: { key: BoolKey; label: string; hint: string }[] = [
  { key: 'playerAutoplayNextEpisode', label: 'autoplayNext', hint: 'autoplayNextHint' },
  { key: 'playerUpNextRail', label: 'upNextRail', hint: 'upNextRailHint' },
  { key: 'vodAutoFailover', label: 'vodAutoFailover', hint: 'vodAutoFailoverHint' },
  // failover: smart reconnect and live failover.
  { key: 'streamReconnect', label: 'streamReconnect', hint: 'streamReconnectHint' },
  { key: 'liveFailover', label: 'liveFailover', hint: 'liveFailoverHint' },
  { key: 'playerAmbientMode', label: 'ambientMode', hint: 'ambientModeHint' },
  { key: 'fullscreenChannelPanel', label: 'fullscreenChannelPanel', hint: 'fullscreenChannelPanelHint' },
  { key: 'zapBanner', label: 'zapBanner', hint: 'zapBannerHint' },
  { key: 'showCaptions', label: 'showCaptions', hint: 'showCaptionsHint' },
  { key: 'openStreamOnDoubleClick', label: 'doubleClick', hint: 'doubleClickHint' },
];

export function PlaybackSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const caps = useRpcQuery('player.capabilities', undefined, { staleTime: 60_000 });

  const players: { value: VideoPlayer; label: string; hint: string; available: boolean; note?: string }[] = [
    { value: 'html5', label: t('playerBuiltIn'), hint: t('playerBuiltInHint'), available: true },
  ];
  const embedded = caps.data?.embeddedMpv ?? false;
  if (embedded || settings.player === 'embedded-mpv') {
    players.push({
      value: 'embedded-mpv',
      label: t('playerEmbeddedMpv'),
      hint: t('playerEmbeddedMpvHint'),
      available: embedded,
      note: embedded ? undefined : (caps.data?.reason ?? t('playerEmbeddedUnavailable')),
    });
  }
  players.push(
    {
      value: 'mpv',
      label: t('playerMpv'),
      hint: t('playerExternalHint', { player: 'mpv' }),
      available: true,
      note: caps.data && !caps.data.mpvPath ? t('playerNotFound', { player: 'mpv' }) : undefined,
    },
    {
      value: 'vlc',
      label: t('playerVlc'),
      hint: t('playerExternalHint', { player: 'VLC' }),
      available: true,
      note: caps.data && !caps.data.vlcPath ? t('playerNotFound', { player: 'VLC' }) : undefined,
    },
  );
  // Legacy value from the old app's Video.js player maps to the built-in one.
  const current: VideoPlayer = settings.player === 'videojs' ? 'html5' : settings.player;

  return (
    <SettingsSection title={t('sectionPlayback')} description={t('sectionPlaybackLead')} testId="settings-playback">
      <SettingsGroup title={t('player')} description={t('playerHint')}>
        <div role="radiogroup" aria-label={t('player')} className="flex flex-col p-2">
          {caps.isPending ? <Skeleton className="m-2 h-12" /> : null}
          {caps.isError ? (
            <div role="alert" className="m-2 flex flex-wrap items-center gap-3 rounded-md bg-danger/10 px-3 py-2 text-sm" data-testid="player-caps-error">
              <span className="min-w-0 flex-1 text-danger">{t('capabilitiesFailed', { message: caps.error.message })}</span>
              <Button size="sm" variant="secondary" onClick={() => void caps.refetch()}>
                {t('retry')}
              </Button>
            </div>
          ) : null}
          {players.map((p) => {
            const selected = current === p.value;
            return (
              <label
                key={p.value}
                className={clsx(
                  'flex cursor-pointer items-start gap-3 rounded-md px-3 py-3 hover:bg-surface-2',
                  selected && 'bg-surface-2',
                  !p.available && 'cursor-not-allowed opacity-60',
                )}
              >
                <input
                  type="radio"
                  name="settings-player"
                  value={p.value}
                  checked={selected}
                  disabled={!p.available && !selected}
                  onChange={() => void update({ player: p.value })}
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                  data-testid={`player-${p.value}`}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium text-fg">{p.label}</span>
                  <span className="text-sm text-fg-muted">{p.hint}</span>
                  {p.note ? <span className="text-sm text-warning">{p.note}</span> : null}
                </span>
              </label>
            );
          })}
        </div>
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow label={t('streamFormat')} description={t('streamFormatHint')}>
          {({ id }) => (
            <Segmented<StreamFormat>
              id={id}
              label={t('streamFormat')}
              value={settings.streamFormat}
              options={[
                { value: 'm3u8', label: t('streamFormatHls') },
                { value: 'ts', label: t('streamFormatTs') },
              ]}
              onChange={(streamFormat) => void update({ streamFormat })}
            />
          )}
        </SettingsRow>
        {TOGGLES.map((tg) => (
          <SwitchRow
            key={tg.key}
            label={t(tg.label)}
            description={t(tg.hint)}
            checked={settings[tg.key]}
            onChange={(v) => void update({ [tg.key]: v })}
            testId={`toggle-${tg.key}`}
          />
        ))}
      </SettingsGroup>
    </SettingsSection>
  );
}
