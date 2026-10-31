/**
 * A day as YYYY-MM-DD in the server's time zone (TZ, which the Docker setup asks for), not UTC. Air dates are
 * local days, so with UTC an episode airing tomorrow evening in the Americas counted as aired the night before.
 */
export function localDay(d: Date | number = new Date()): string {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
