/** Client-side sanity check of a backup file before it is sent to `backup.import`. */

export interface BackupSummary {
  version: number;
  exportedAt?: string;
  includeSecrets: boolean;
  playlists: number;
  byKind: { m3u: number; xtream: number; stalker: number };
  epgUrls: number;
  /** Entries the import will skip: not an object, or an unknown `portalType`. */
  skipped: number;
}

export type BackupCheck = { ok: true; summary: BackupSummary } | { ok: false; error: string };

/** 50 MB: anything larger is not a playlist backup. */
export const MAX_BACKUP_BYTES = 50 * 1024 * 1024;

/** Integer from a number or numeric string, as the core reads `version`. */
function intOf(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : Number.NaN;
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

/**
 * Mirrors the core's manifest checks (`backup/import.rs` `parse_manifest`)
 * so a file is accepted or refused here for the same reasons, with a
 * specific message: a leading BOM is ignored, `version` may be a numeric
 * string, and a bare array is an old-style export the import cannot read.
 */
export function inspectBackup(text: string): BackupCheck {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === '') return { ok: false, error: 'backupEmptyFile' };
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return { ok: false, error: 'backupNotJson' };
  }
  if (Array.isArray(data)) return { ok: false, error: 'backupLegacyArray' };
  if (!data || typeof data !== 'object') return { ok: false, error: 'backupWrongFormat' };
  const o = data as Record<string, unknown>;
  if (o.kind !== 'iptvnator-playlist-backup') return { ok: false, error: 'backupWrongFormat' };
  const version = intOf(o.version);
  // Newer than this app reads, or older (or missing): each gets its own advice.
  if (version !== undefined && version > 1) return { ok: false, error: 'backupWrongVersion' };
  if (version !== 1) return { ok: false, error: 'backupOldVersion' };
  if (!Array.isArray(o.playlists)) return { ok: false, error: 'backupWrongFormat' };
  const byKind = { m3u: 0, xtream: 0, stalker: 0 };
  let skipped = 0;
  for (const p of o.playlists) {
    const kind = p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>).portalType : undefined;
    if (kind === 'm3u' || kind === 'xtream' || kind === 'stalker') byKind[kind] += 1;
    else skipped += 1;
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
      skipped,
    },
  };
}

/** Default file name for a new backup. */
export function backupFileName(now = new Date()): string {
  return `tsrust-iptv-backup-${now.toISOString().slice(0, 10)}.json`;
}

/** Desktop only: native save dialog. Null when canceled. */
export async function chooseBackupSavePath(title: string, defaultName: string, filterName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const picked = await save({ title, defaultPath: defaultName, filters: [{ name: filterName, extensions: ['json'] }] });
  return typeof picked === 'string' && picked.length > 0 ? picked : null;
}
