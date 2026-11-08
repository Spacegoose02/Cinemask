import { JellyfinClient } from './jellyfin.js';

/**
 * Emby: Jellyfin began as a fork of it, so the library, sessions and refresh calls are the same.
 * Only the key's header differs, and newer Emby lists accounts at /Users/Query.
 */
export class EmbyClient extends JellyfinClient {
  protected override readonly service: string = 'Emby';

  protected override auth(): Record<string, string> {
    return { 'X-Emby-Token': this.apiKey };
  }

  protected override async listUsers() {
    type U = { Id: string; Name: string; Policy?: { IsAdministrator?: boolean } };
    try {
      return (await this.get<{ Items: U[] }>('/Users/Query')).Items;
    } catch {
      return this.get<U[]>('/Users');
    }
  }
}
