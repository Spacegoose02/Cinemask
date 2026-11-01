import type { AppContext } from '../context.js';
import { probeTitle } from './mediainfo.js';
import { autoSubtitles } from './subtitles.js';

/** Work done after files are imported: read their details with ffprobe, then fetch subtitles. */
export async function afterImport(ctx: AppContext, monitoredId: number): Promise<void> {
  await probeTitle(ctx, monitoredId).catch(() => 0);
  await autoSubtitles(ctx, monitoredId).catch(() => undefined);
}
