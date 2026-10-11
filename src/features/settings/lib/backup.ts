/** Client-side sanity check of a backup file before it is sent to `backup.import`. */

export interface BackupSummary {
  version: number;
  exportedAt?: string;
  includeSecrets: boolean;
  playlists: number;
  byKind: { m3u: number; xtream: number; stalker: number };
  epgUrls: number;
}

export type BackupCheck = { ok: true; summary: BackupSummary } | { ok: false; error: string };

/** 50 MB: anything larger is not a playlist backup. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

export function inspectBackup(text: string): BackupCheck {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'backupNotJson' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'backupWrongFormat' };
  const o = data as Record<string, unknown>;
  if (o.kind !== 'iptvnator-playlist-backup') return { ok: false, error: 'backupWrongFormat' };
  if (o.version !== 1) return { ok: false, error: 'backupWrongVersion' };
  if (!Array.isArray(o.playlists)) return { ok: false, error: 'backupWrongFormat' };
  const byKind = { m3u: 0, xtream: 0, stalker: 0 };
  for (const p of o.playlists) {
    const kind = p && typeof p === 'object' ? (p as Record<string, unknown>).portalType : undefined;
    if (kind === 'm3u' || kind === 'xtream' || kind === 'stalker') byKind[kind] += 1;
  }
  const settings = o.settings && typeof o.settings === 'object' ? (o.settings as Record<string, unknown>) : undefined;
  return {
    ok: true,
    summary: {
      version: 1,
      exportedAt: typeof o.exportedAt === 'string' ? o.exportedAt : undefined,
      includeSecrets: o.includeSecrets === true,
      playlists: o.playlists.length,
      byKind,
      epgUrls: Array.isArray(settings?.epgUrls) ? settings.epgUrls.length : 0,
    },
  };
}
