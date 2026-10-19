import { hash, verify } from '@node-rs/argon2';

// OWASP recommended Argon2id parameters (m=19 MiB, t=2, p=1).
const OPTIONS = { algorithm: 2 /* Argon2id */ as const, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// Verified against when the username does not exist, so response time doesn't reveal valid usernames.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

/** Returns a reason the password is unacceptable, or null. Length-based, per NIST SP 800-63B. */
export function passwordProblem(password: string, username: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters`;
  if (password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username';
  if (new Set(password).size < 4) return 'Password is too repetitive';
  return null;
}
