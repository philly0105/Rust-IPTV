import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useRpcQuery } from '@/api/query';
import { isDesktop } from '@/api/transport';
import type { Settings, StreamFormat, VideoPlayer } from '@/api/types';
import { BackgroundChoice, ColorChoice, PositionSlider, SizeChoice, SubtitlePreview } from '@/features/player/components/SubtitleStyleFields';
import { styleFromSettings } from '@/features/player/subtitles/style';

import { useMediaQuery } from '@/shell/useMediaQuery';
import { Badge, Button, Select, errorDescription } from '@/ui';
import { Segmented, SettingsGroup, SettingsRow, SettingsSection, SwitchRow, TOUCH_ONLY_QUERY } from '../components';
import type { SectionProps } from './types';

type BoolKey = {
  [K in keyof Settings]-?: Settings[K] extends boolean ? K : never;
}[keyof Settings];

type Toggle = { key: BoolKey; label: string; hint: string };

/** Live TV's switches, under Stream format. Double-click to play is left out on a touch-only device unless it is on (see below). */
const LIVE_TOGGLES: Toggle[] = [
  // failover: smart reconnect and live failover.
  { key: 'streamReconnect', label: 'streamReconnect', hint: 'streamReconnectHint' },
  { key: 'liveFailover', label: 'liveFailover', hint: 'liveFailoverHint' },
  { key: 'zapBanner', label: 'zapBanner', hint: 'zapBannerHint' },
  { key: 'fullscreenChannelPanel', label: 'fullscreenChannelPanel', hint: 'fullscreenChannelPanelHint' },
  { key: 'openStreamOnDoubleClick', label: 'doubleClick', hint: 'doubleClickHint' },
];

const EPISODE_TOGGLES: Toggle[] = [
  { key: 'playerAutoplayNextEpisode', label: 'autoplayNext', hint: 'autoplayNextHint' },
  { key: 'playerUpNextRail', label: 'upNextRail', hint: 'upNextRailHint' },
  { key: 'vodAutoFailover', label: 'vodAutoFailover', hint: 'vodAutoFailoverHint' },
];

/** One SwitchRow per toggle; its switch carries `toggle-<key>`, so each setting stays findable. */
function ToggleRows({ toggles, settings, update }: SectionProps & { toggles: Toggle[] }) {
  const { t } = useTranslation('settings');
  return toggles.map((tg) => (
    <SwitchRow
      key={tg.key}
      label={t(tg.label)}
      description={t(tg.hint)}
      checked={settings[tg.key]}
      onChange={(v) => void update({ [tg.key]: v })}
      testId={`toggle-${tg.key}`}
    />
  ));
}

/**
 * Subtitles: whether they show (Show captions) first, then their look for both players (C6), with
 * a preview that follows every change at once.
 */
function SubtitleGroup({ settings, update }: SectionProps) {
  const { t } = useTranslation('player');
  // The slider's position while it moves; saved when the drag or key press ends.
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const saved = styleFromSettings(settings);
  const style = draftPosition === null ? saved : { ...saved, position: draftPosition };
  return (
    <SettingsGroup id="subtitles" title={t('subtitleStyle.title')} description={t('subtitleStyle.description')}>
      <ToggleRows toggles={[{ key: 'showCaptions', label: 'showCaptions', hint: 'showCaptionsHint' }]} settings={settings} update={update} />
      <div className="px-4 pt-4 pb-1" data-testid="settings-subtitles">
        <div className="mx-auto w-full max-w-xl">
          <SubtitlePreview style={style} />
        </div>
      </div>
      <SettingsRow label={t('subtitleStyle.size')} description={t('subtitleStyle.sizeHint')}>
        {({ id, describedBy }) => (
          <SizeChoice tone="page" id={id} describedBy={describedBy} value={style.size} onChange={(subtitleSize) => void update({ subtitleSize })} />
        )}
      </SettingsRow>
      <SettingsRow label={t('subtitleStyle.color')} description={t('subtitleStyle.colorHint')}>
        {({ id, describedBy }) => (
          <ColorChoice tone="page" id={id} describedBy={describedBy} value={style.color} onChange={(subtitleColor) => void update({ subtitleColor })} />
        )}
      </SettingsRow>
      <SettingsRow label={t('subtitleStyle.background')} description={t('subtitleStyle.backgroundHint')}>
        {({ id, describedBy }) => (
          <BackgroundChoice
            tone="page"
            id={id}
            describedBy={describedBy}
            value={style.background}
            color={style.color}
            onChange={(subtitleBackground) => void update({ subtitleBackground })}
          />
        )}
      </SettingsRow>
      <SettingsRow label={t('subtitleStyle.position')} description={t('subtitleStyle.positionHint')}>
        {({ id, describedBy }) => (
          <PositionSlider
            tone="page"
            id={id}
            describedBy={describedBy}
            value={saved.position}
            onPreview={setDraftPosition}
            onCommit={(subtitlePosition) => {
              setDraftPosition(null);
              if (subtitlePosition !== saved.position) void update({ subtitlePosition });
            }}
          />
        )}
      </SettingsRow>
    </SettingsGroup>
  );
}

export function PlaybackSection({ settings, update }: SectionProps) {
  const { t } = useTranslation('settings');
  const caps = useRpcQuery('player.capabilities', undefined, { staleTime: 60_000 });
  // A phone or tablet has no double click; the row stays while the setting is on, so a choice
  // made on a computer can still be turned off here (settings are shared).
  const touchOnly = useMediaQuery(TOUCH_ONLY_QUERY);
  const liveToggles = touchOnly && !settings.openStreamOnDoubleClick ? LIVE_TOGGLES.filter((tg) => tg.key !== 'openStreamOnDoubleClick') : LIVE_TOGGLES;

  const players: { value: VideoPlayer; label: string; hint: string; available: boolean; note?: string }[] = [
    { value: 'html5', label: t('playerBuiltIn'), hint: t('playerBuiltInHint'), available: true },
  ];
  const embedded = caps.data?.embeddedMpv ?? false;
  // The list keeps its shape while the capabilities load (L3-visual-10): no placeholder above it that
  // goes away again. Only the desktop app can embed mpv, so there the row is always listed, available
  // until the answer says otherwise and then with the reason; in the browser it appears only if chosen.
  const selected = [settings.livePlayer ?? settings.player, settings.catchupPlayer ?? settings.player, settings.vodPlayer ?? settings.player];
  const embeddedPending = caps.isPending && (isDesktop || selected.includes('embedded-mpv'));
  if (embedded || isDesktop || selected.includes('embedded-mpv')) {
    players.push({
      value: 'embedded-mpv',
      label: t('playerEmbeddedMpv'),
      hint: t('playerEmbeddedMpvHint'),
      available: embedded || embeddedPending,
      note: embedded || embeddedPending ? undefined : (caps.data?.reason ?? t('playerEmbeddedUnavailable')),
    });
  }
  // External players run only in the desktop app; the core refuses `player.openExternal` elsewhere.
  if (isDesktop) {
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
  }
  // Older settings had one choice for every stream. Each row uses it until the user selects
  // its own player. Video.js and desktop-only choices in the browser play through built-in.
  const current = (value: VideoPlayer): VideoPlayer =>
    value === 'videojs' || (!isDesktop && (value === 'mpv' || value === 'vlc')) ? 'html5' : value;
  const rows = [
    { key: 'livePlayer' as const, label: t('livePlayer'), hint: t('livePlayerHint') },
    { key: 'catchupPlayer' as const, label: t('catchupPlayer'), hint: t('catchupPlayerHint') },
    { key: 'vodPlayer' as const, label: t('vodPlayer'), hint: t('vodPlayerHint') },
  ];

  return (
    <SettingsSection title={t('sectionPlayback')} testId="settings-playback">
      {/* The caps error and the three player rows sit straight in the group, so they keep its
          padding and dividers; only the browser's single line has a frame of its own. */}
      <SettingsGroup title={t('player')}>
        {caps.isError ? (
          <div role="alert" className="m-2 flex flex-wrap items-center gap-3 rounded-md bg-danger/10 px-3 py-2 text-sm" data-testid="player-caps-error">
            <span className="min-w-0 flex-1 text-danger">
              {t('capabilitiesFailed')} {errorDescription(caps.error)}
            </span>
            <Button size="sm" variant="secondary" onClick={() => void caps.refetch()}>
              {t('retry')}
            </Button>
          </div>
        ) : null}
        {players.length === 1 ? (
          // A browser has the built-in player only: one radio with nothing to choose reads as
          // broken, so it is a plain line saying what plays, with where the others live.
          <div className="flex flex-col p-2">
            <div className="flex items-start gap-3 px-2 py-1.5" data-testid="player-only">
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-body font-medium text-fg">{players[0]!.label}</span>
                <span className="text-body-sm text-fg-muted">{players[0]!.hint}</span>
                <span className="text-caption text-fg-subtle">{t('playerDesktopOnlyNote')}</span>
              </span>
              <Badge className="mt-0.5">{t('playerInUse')}</Badge>
            </div>
          </div>
        ) : (
          rows.map(({ key, label, hint }) => {
            const value = current(settings[key] ?? settings.player);
            const choice = players.find((p) => p.value === value);
            return (
              <SettingsRow key={key} label={label} description={choice?.note ?? hint}>
                {({ id, describedBy }) => (
                  <Select
                    id={id}
                    aria-describedby={describedBy}
                    value={value}
                    options={players.map((p) => ({
                      value: p.value,
                      label: p.label,
                      disabled: !p.available && value !== p.value,
                    }))}
                    onValueChange={(player) => void update({ [key]: player as VideoPlayer })}
                    data-testid={`select-${key}`}
                  />
                )}
              </SettingsRow>
            );
          })
        )}
      </SettingsGroup>

      {/* settings-01: three small groups by what they act on, not one grab bag. */}
      <SettingsGroup id="live" title={t('playbackLiveGroup')}>
        {/* Auto's rule differs by host: the desktop app also has mpv and VLC, which keep HLS; a
            browser has only the built-in player, which gets MPEG-TS where it can play it. */}
        <SettingsRow label={t('streamFormat')} description={isDesktop ? t('streamFormatHint') : t('streamFormatHintServer')}>
          {({ id }) => (
            <Segmented<StreamFormat>
              id={id}
              label={t('streamFormat')}
              value={settings.streamFormat}
              options={[
                { value: 'auto', label: t('streamFormatAuto') },
                { value: 'm3u8', label: t('streamFormatHls') },
                { value: 'ts', label: t('streamFormatTs') },
              ]}
              onChange={(streamFormat) => void update({ streamFormat })}
            />
          )}
        </SettingsRow>
        <ToggleRows toggles={liveToggles} settings={settings} update={update} />
      </SettingsGroup>

      <SettingsGroup id="episodes" title={t('playbackEpisodesGroup')}>
        <ToggleRows toggles={EPISODE_TOGGLES} settings={settings} update={update} />
      </SettingsGroup>

      <SettingsGroup id="picture" title={t('playbackPictureGroup')}>
        <ToggleRows toggles={[{ key: 'playerAmbientMode', label: 'ambientMode', hint: 'ambientModeHint' }]} settings={settings} update={update} />
      </SettingsGroup>

      <SubtitleGroup settings={settings} update={update} />
    </SettingsSection>
  );
}
