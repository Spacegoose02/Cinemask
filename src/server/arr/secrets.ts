import type { AppContext } from '../context.js';
import { decryptString, encryptString } from '../security/crypto.js';

/** Encrypts credentials kept in table columns (indexer keys, client passwords) with the instance key. */
export const sealSecret = (ctx: AppContext, v: string | null | undefined) => (v ? encryptString(ctx.secretKey, v) : null);
export const openSecret = (ctx: AppContext, v: string | null | undefined) => (v ? decryptString(ctx.secretKey, v) : '');
