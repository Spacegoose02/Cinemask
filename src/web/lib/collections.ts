/** Plex libraries that collections came from, Movies first. */
export function collectionLibraries(cols: { library: string | null }[]): string[] {
  return [...new Set(cols.map((c) => c.library).filter((l): l is string => Boolean(l)))].sort((a, b) => (a === 'Movies' ? -1 : b === 'Movies' ? 1 : a.localeCompare(b)));
}

/** Collections in one library; ones made here (or from Jellyfin) belong to none and show in every library. */
export function inLibrary<T extends { library: string | null }>(cols: T[], library: string): T[] {
  return cols.filter((c) => library === 'all' || !c.library || c.library === library);
}
