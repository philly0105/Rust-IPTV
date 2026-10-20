import { useQuery } from '@tanstack/react-query';
import { Copy, EyeOff, QrCode, Smartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { invalidate, rpcKey } from '@/api/query';
import type { RemoteDevice, RemoteLanAddress, RemotePairing, RemoteServerStatus } from '@/api/rpc';
import { RpcError, isDesktop, rpc } from '@/api/transport';
import { Button, Dialog, Select, Skeleton, useToast, errorDescription } from '@/ui';

import { relativeTime } from '../../sources/lib/format';
import { SettingsGroup, SwitchRow } from '../components';
import { addressLabel, deviceLabel, lanView, nextReveal, pickAddress, qrViewBox, type Reveal } from '../lib/remoteLan';
import type { SectionProps } from './types';

/** How often the pairing code and device list refresh while shown. */
const REFRESH_MS = 5_000;

interface Props extends SectionProps {
  status: RemoteServerStatus | undefined;
}

/** Settings > Remote: phones on the local network (LAN mode, pairing, devices). */
export function RemoteLanPanel({ settings, update, status }: Props) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const [confirmOn, setConfirmOn] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const lanEnabled = settings.remoteLanEnabled === true;
  const view = lanView(isDesktop, lanEnabled, status);

  if (view.kind === 'server') {
    return (
      <SettingsGroup title={t('remoteLanTitle')}>
        <p className="px-4 py-4 text-sm text-fg-muted" data-testid="remote-lan-server">
          {t('remoteLanServerMode')}
        </p>
      </SettingsGroup>
    );
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast({ variant: 'error', title: t('remoteFailed'), description: errorDescription(e) });
    } finally {
      setBusy(false);
      void invalidate('remote.');
    }
  };

  // The core restarts the server with the new LAN mode on `remote.start`.
  const setLan = (v: boolean) =>
    run(async () => {
      if (!(await update({ remoteLanEnabled: v }))) return;
      if (status?.running) await rpc('remote.start');
    });

  const reset = () =>
    run(async () => {
      await rpc('remote.resetPairing');
      setConfirmReset(false);
      toast({ variant: 'success', title: t('remoteResetDone') });
    });

  return (
    <>
      <SettingsGroup title={t('remoteLanTitle')}>
        <SwitchRow
          label={t('remoteLanEnabled')}
          description={t('remoteLanEnabledHint')}
          checked={lanEnabled}
          disabled={busy}
          onChange={(v) => (v ? setConfirmOn(true) : void setLan(false))}
          testId="toggle-remote-lan"
        />
        {view.kind === 'stopped' ? (
          <p className="px-4 py-3 text-sm text-fg-muted" data-testid="remote-lan-stopped">
            {t('remoteLanNeedsRemote')}
          </p>
        ) : view.kind === 'error' ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="remote-lan-error">
            <span className="min-w-0 flex-1 text-warning">{t('remoteLanUnavailable', { message: view.message })}</span>
            <Button size="sm" variant="secondary" loading={busy} onClick={() => void run(() => rpc('remote.start'))}>
              {t('retry')}
            </Button>
          </div>
        ) : view.kind === 'ready' ? (
          <PairingCard addresses={view.addresses} warning={view.warning} />
        ) : null}
      </SettingsGroup>

      {view.kind !== 'off' ? (
        <SettingsGroup
          title={t('remoteDevicesTitle')}
          actions={
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)} disabled={busy} data-testid="remote-reset-pairing">
              {t('remoteResetPairing')}
            </Button>
          }
        >
          <DeviceList />
        </SettingsGroup>
      ) : null}

      <Dialog
        open={confirmOn}
        onClose={() => setConfirmOn(false)}
        title={t('remoteLanConfirmTitle')}
        description={t('remoteLanConfirmBody')}
        size="sm"
        testId="remote-lan-confirm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOn(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => {
                setConfirmOn(false);
                void setLan(true);
              }}
              data-testid="remote-lan-confirm-on"
            >
              {t('remoteLanConfirm')}
            </Button>
          </>
        }
      />
      <Dialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title={t('remoteResetTitle')}
        description={t('remoteResetBody')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              {t('cancel')}
            </Button>
            <Button variant="danger" loading={busy} onClick={() => void reset()} data-testid="remote-reset-confirm">
              {t('remoteResetPairing')}
            </Button>
          </>
        }
      />
    </>
  );
}

/**
 * The pairing QR code stays hidden until the user asks for it, so it does not
 * leak through screen sharing or a glance at the screen. Once shown it stays
 * up for one pairing or until the code expires, whichever comes first.
 */
function PairingCard({ addresses, warning }: { addresses: RemoteLanAddress[]; warning?: string }) {
  const { t } = useTranslation('settings');
  const { toast } = useToast();
  const [chosen, setChosen] = useState<string>();
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const address = pickAddress(addresses, chosen);
  const args = { address };
  const pairing = useQuery<RemotePairing, RpcError>({
    queryKey: rpcKey('remote.pairingCode', args),
    queryFn: () => rpc('remote.pairingCode', args),
    refetchInterval: REFRESH_MS,
    staleTime: 0,
    enabled: reveal !== null,
  });

  // Pin the first fresh code; hide once a phone used it or it changed.
  const { data, dataUpdatedAt } = pairing;
  useEffect(() => {
    if (!reveal || !data) return;
    const next = nextReveal(reveal, data, dataUpdatedAt, Date.now());
    if (next === reveal) return;
    setReveal(next);
    if (next === null) void invalidate('remote.devices');
  }, [reveal, data, dataUpdatedAt]);

  // Hide when the shown code expires.
  const until = reveal?.until;
  useEffect(() => {
    if (until === undefined) return;
    const id = setTimeout(() => setReveal(null), Math.max(0, until - Date.now()));
    return () => clearTimeout(id);
  }, [until]);

  const shown = reveal?.code !== undefined && data && dataUpdatedAt >= reveal.since ? data : undefined;
  const error = reveal && pairing.isError ? pairing.error : undefined;

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ variant: 'success', title: t('remoteCopied') });
    } catch {
      toast({ variant: 'error', title: t('remoteCopyFailed') });
    }
  };

  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-start" data-testid="remote-pairing">
      <div className="shrink-0">
        {reveal === null ? (
          <div className="flex size-48 flex-col items-center justify-center gap-3 rounded-md border border-dashed border-edge p-3 text-center">
            <QrCode aria-hidden className="size-10 text-fg-subtle" />
            <Button size="sm" variant="primary" onClick={() => setReveal({ since: Date.now() })} data-testid="remote-show-code">
              {t('remoteLanShowCode')}
            </Button>
          </div>
        ) : shown ? (
          // QR scanners need dark modules on a light field whatever the app theme.
          <svg
            role="img"
            aria-label={t('remoteLanQrAlt')}
            viewBox={qrViewBox(shown.qr.size)}
            className="size-48 rounded-md bg-white text-black"
            shapeRendering="crispEdges"
            data-testid="remote-qr"
          >
            <path d={shown.qr.path} fill="currentColor" />
          </svg>
        ) : error ? (
          <div className="flex size-48 items-center justify-center rounded-md border border-edge p-3 text-center text-sm text-danger" role="alert">
            {t('remoteLanPairingFailed', { message: error.message })}
          </div>
        ) : (
          <Skeleton className="size-48 rounded-md" />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="flex items-center gap-2 font-medium text-fg">
          <Smartphone aria-hidden className="size-4 text-fg-muted" />
          {t('remoteLanScan')}
        </p>
        <p className="text-sm text-fg-muted">{t(reveal === null ? 'remoteLanShowCodeHint' : 'remoteLanScanHint')}</p>
        {addresses.length > 1 ? (
          <Select
            label={t('remoteLanAddress')}
            value={address}
            onValueChange={setChosen}
            options={addresses.map((a) => ({ value: a.ip, label: addressLabel(a) }))}
            wrapperClassName="max-w-xs"
            data-testid="remote-lan-address"
          />
        ) : null}
        {shown ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 max-w-full truncate rounded-sm bg-surface-2 px-2 py-1 font-mono text-sm text-fg" data-testid="remote-pair-url">
              {shown.url}
            </code>
            <Button size="sm" variant="secondary" icon={<Copy aria-hidden className="size-4" />} onClick={() => void copy(shown.url)}>
              {t('remoteLanCopy')}
            </Button>
          </div>
        ) : null}
        {reveal !== null ? (
          <div>
            <Button size="sm" variant="ghost" icon={<EyeOff aria-hidden className="size-4" />} onClick={() => setReveal(null)} data-testid="remote-hide-code">
              {t('remoteLanHideCode')}
            </Button>
          </div>
        ) : null}
        {warning ? <p className="text-sm text-warning">{t('remoteLanUnavailable', { message: warning })}</p> : null}
      </div>
    </div>
  );
}

function DeviceList() {
  const { t, i18n } = useTranslation('settings');
  const { toast } = useToast();
  const [revoking, setRevoking] = useState<string>();
  const devices = useQuery<RemoteDevice[], RpcError>({
    queryKey: rpcKey('remote.devices', undefined),
    queryFn: () => rpc('remote.devices'),
    refetchInterval: REFRESH_MS,
    staleTime: 0,
  });

  const revoke = async (d: RemoteDevice) => {
    setRevoking(d.id);
    try {
      await rpc('remote.revokeDevice', { id: d.id });
      toast({ variant: 'success', title: t('remoteDeviceRevoked') });
    } catch (e) {
      toast({ variant: 'error', title: t('remoteFailed'), description: errorDescription(e) });
    } finally {
      setRevoking(undefined);
      void invalidate('remote.devices');
    }
  };

  if (devices.isPending) {
    return (
      <div className="px-4 py-4">
        <Skeleton className="h-6 w-56" />
      </div>
    );
  }
  if (devices.isError) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm" data-testid="remote-devices-error">
        <span className="min-w-0 flex-1 text-danger">{t('remoteDevicesFailed', { message: devices.error.message })}</span>
        <Button size="sm" variant="secondary" onClick={() => void devices.refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (devices.data.length === 0) {
    return (
      <p className="px-4 py-4 text-sm text-fg-muted" data-testid="remote-devices-empty">
        {t('remoteDevicesEmpty')}
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-divider" data-testid="remote-devices">
      {devices.data.map((d) => {
        const name = deviceLabel(d.name, t);
        return (
          <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <Smartphone aria-hidden className="size-4 shrink-0 text-fg-subtle" />
            <div className="flex min-w-0 flex-1 flex-col">
              <span dir="auto" className="truncate text-match-parent text-sm font-medium text-fg">{name}</span>
              <span className="text-xs text-fg-muted">
                <time dateTime={d.lastSeen}>{t('remoteDeviceSeen', { when: relativeTime(d.lastSeen, i18n.language) ?? d.lastSeen })}</time>
              </span>
            </div>
            <Button
              size="sm"
              variant="secondary"
              loading={revoking === d.id}
              onClick={() => void revoke(d)}
              aria-label={t('remoteDeviceRevokeLabel', { name })}
            >
              {t('remoteDeviceRevoke')}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
