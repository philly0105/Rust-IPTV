import { useState } from 'react';

import type { PlayerSource } from '@/api/types';

import { PlayerDock, PlayerStage, playSource, usePlayerStore } from '..';

const MOCK = 'http://127.0.0.1:7290';

const SAMPLES: PlayerSource[] = [
  {
    url: `${MOCK}/xtream/live/demo/secret/101.m3u8`,
    kind: 'hls',
    title: 'Mock live 101 (HLS)',
    isLive: true,
    isRadio: false,
  },
  {
    url: `${MOCK}/xtream/movie/demo/secret/201.mp4`,
    kind: 'direct',
    title: 'Mock movie 201 (MP4)',
    isLive: false,
    isRadio: false,
  },
];

/**
 * Route-less dev harness for the player slice. No backend is needed: rpc calls
 * (settings, recents, positions) fail and the store falls back to defaults.
 */
export function Harness() {
  const [staged, setStaged] = useState(true);
  const status = usePlayerStore((s) => s.status);
  const error = usePlayerStore((s) => s.error);
  const position = usePlayerStore((s) => s.positionSeconds);
  const duration = usePlayerStore((s) => s.durationSeconds);
  const dock = usePlayerStore((s) => s.dock);

  return (
    <div className="min-h-screen bg-bg p-6 text-fg">
      <h1 className="font-display text-2xl">Player harness</h1>
      <div className="mt-4 flex flex-wrap gap-2">
        {SAMPLES.map((s) => (
          <button
            key={s.url}
            type="button"
            onClick={() => void playSource(s)}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
          >
            {s.title}
          </button>
        ))}
        <button type="button" onClick={() => setStaged((v) => !v)} className="rounded-md border border-border px-3 py-1.5 text-sm">
          {staged ? 'Unmount stage (mini player)' : 'Mount stage'}
        </button>
        <button type="button" onClick={() => usePlayerStore.getState().stop()} className="rounded-md border border-border px-3 py-1.5 text-sm">
          Stop
        </button>
      </div>
      <p data-testid="harness-status" className="mt-3 text-sm text-fg-muted tabular-nums">
        status={status} dock={dock} position={position.toFixed(1)} duration={duration?.toFixed(1) ?? '-'}
        {error ? ` error=${error}` : ''}
      </p>
      {staged && (
        <PlayerStage className="relative mt-4 aspect-video w-full max-w-4xl overflow-hidden rounded-lg bg-black">
          <div className="flex h-full items-center justify-center text-sm text-fg-subtle">Pick a sample to play.</div>
        </PlayerStage>
      )}
      <PlayerDock />
    </div>
  );
}
