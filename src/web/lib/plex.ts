import { api } from './api';

/** Opens plex.tv in a popup and waits for the user to approve. Resolves once signed in (or linked). */
export async function signInWithPlex(link: boolean): Promise<void> {
  // Open the window synchronously from the click so popup blockers allow it.
  const popup = window.open('about:blank', 'plex-auth', 'width=600,height=700');
  const { state, authUrl } = await api<{ state: string; authUrl: string }>('/api/auth/plex/start', { body: { link } });
  if (popup) popup.location.href = authUrl;
  else window.open(authUrl, '_blank', 'noopener');

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await api<{ done: boolean; ok?: boolean; error?: string }>('/api/auth/plex/poll', { body: { state } });
    if (!res.done) continue;
    popup?.close();
    if (!res.ok) throw new Error(res.error ?? 'Plex sign-in failed');
    return;
  }
  popup?.close();
  throw new Error('Plex sign-in timed out');
}
