import { eq } from 'drizzle-orm';
import type { Orm } from '../db/database.js';
import { settings } from '../db/schema.js';
import { decryptString, encryptString } from '../security/crypto.js';
import { SETTINGS, type SectionName, type SectionValue } from './definitions.js';

type Json = Record<string, unknown>;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getPath(obj: Json, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Json)[k] : undefined), obj);
}

function setPath(obj: Json, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = {};
    o = o[k] as Json;
  }
  o[keys[keys.length - 1]!] = value;
}

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (UNSAFE_KEYS.has(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k] as Json, v as Json);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class SettingsStore {
  constructor(
    private readonly getOrm: () => Orm,
    private readonly getKey: () => Buffer,
  ) {}

  /** Full section with secrets decrypted. Server-side use only. */
  get<S extends SectionName>(section: S): SectionValue<S> {
    const def = SETTINGS[section];
    const row = this.getOrm().select().from(settings).where(eq(settings.key, section)).get();
    const raw: Json = row ? (JSON.parse(row.value) as Json) : {};
    for (const p of def.secrets) {
      const v = getPath(raw, p);
      if (typeof v === 'string' && v) setPath(raw, p, decryptString(this.getKey(), v));
    }
    return def.schema.parse(raw) as SectionValue<S>;
  }

  /**
   * Merges a partial update into the section. For secret fields: undefined keeps the stored
   * value, null clears it, a string replaces it.
   */
  update<S extends SectionName>(section: S, patch: Json): SectionValue<S> {
    const def = SETTINGS[section];
    const current = this.get(section) as Json;
    const cleaned = structuredClone(patch);
    for (const p of def.secrets) {
      const v = getPath(cleaned, p);
      if (v === undefined) setPath(cleaned, p, getPath(current, p));
      else if (v === null) setPath(cleaned, p, '');
    }
    const next = def.schema.parse(deepMerge(current, cleaned)) as Json;
    const stored = structuredClone(next);
    for (const p of def.secrets) {
      const v = getPath(stored, p);
      if (typeof v === 'string' && v) setPath(stored, p, encryptString(this.getKey(), v));
    }
    const value = JSON.stringify(stored);
    this.getOrm()
      .insert(settings)
      .values({ key: section, value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: Date.now() } })
      .run();
    return next as SectionValue<S>;
  }

  /** Section as sent to the browser: secret values replaced by whether they are set. */
  getPublic(section: SectionName): { values: Json; secretsSet: Record<string, boolean> } {
    const values = structuredClone(this.get(section)) as Json;
    const secretsSet: Record<string, boolean> = {};
    for (const p of SETTINGS[section].secrets) {
      secretsSet[p] = Boolean(getPath(values, p));
      setPath(values, p, '');
    }
    return { values, secretsSet };
  }
}
