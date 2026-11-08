import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';

export const passkeysSupported = () => browserSupportsWebAuthn();

/** Signs in with a passkey: on its own, or as the second step after a password (with that step's token). */
export async function signInWithPasskey(token?: string): Promise<void> {
  const { state, options } = await api<{ state: string; options: Parameters<typeof startAuthentication>[0]['optionsJSON'] }>('/api/auth/passkey/options', { body: token ? { token } : {} });
  const response = await startAuthentication({ optionsJSON: options });
  await api('/api/auth/passkey', { body: { state, response } });
}

/** Adds a passkey to the signed-in account. Returns new recovery codes when these are the first. */
export async function addPasskey(name: string, confirm: { password?: string; code?: string }): Promise<string[] | null> {
  const { token, options } = await api<{ token: string; options: Parameters<typeof startRegistration>[0]['optionsJSON'] }>('/api/auth/passkeys/options', { body: {} });
  const response = await startRegistration({ optionsJSON: options });
  const res = await api<{ recoveryCodes: string[] | null }>('/api/auth/passkeys', { body: { token, name, response, ...confirm } });
  return res.recoveryCodes;
}
