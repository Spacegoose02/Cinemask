export const BACKUP_REASONS = ['manual', 'scheduled', 'pre-upgrade', 'pre-restore'] as const;
export type BackupReason = (typeof BACKUP_REASONS)[number];

/** backup-20261019-220000-manual.tar.gz[.enc] — the only file names the API will read or serve. */
export const BACKUP_NAME = /^backup-\d{8}-\d{6}-(manual|scheduled|pre-upgrade|pre-restore)\.tar\.gz(\.enc)?$/;

export function backupFileName(reason: BackupReason, encrypted: boolean, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}`;
  return `backup-${stamp}-${reason}.tar.gz${encrypted ? '.enc' : ''}`;
}
