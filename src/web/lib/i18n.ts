import { useSyncExternalStore } from 'react';
import { api } from './api';
import de from '../locales/de';
import es from '../locales/es';
import fr from '../locales/fr';
import nl from '../locales/nl';

/**
 * Interface languages. Text is written in English in the code and looked up with t('English
 * text'); anything a language doesn't have yet shows in English. Keep LANGUAGE_CODES in
 * auth/apikey-routes.ts in step with LANGUAGES.
 */
export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'nl', label: 'Nederlands' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];

export const CATALOGS: Record<Exclude<Language, 'en'>, Record<string, string>> = { es, fr, de, nl };

const KEY = 'cinemask-language';
const known = (l: string | null | undefined): l is Language => LANGUAGES.some((x) => x.code === l);

function browserLanguage(): Language {
  if (typeof navigator === 'undefined') return 'en';
  for (const l of navigator.languages ?? [navigator.language]) {
    const code = l?.slice(0, 2).toLowerCase();
    if (known(code)) return code;
  }
  return 'en';
}

function stored(): Language | null {
  try {
    const v = localStorage.getItem(KEY);
    return known(v) ? v : null;
  } catch {
    return null;
  }
}

let current: Language = stored() ?? browserLanguage();
const listeners = new Set<() => void>();

function set(l: Language) {
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  for (const fn of listeners) fn();
}

/** Text in the current language, with {name} placeholders filled in. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const out = current === 'en' ? text : (CATALOGS[current][text] ?? text);
  return vars ? out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : out;
}

/** Re-renders the component when the language changes. */
export function useT(): typeof t {
  useSyncExternalStore(
    (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    () => current,
    () => current,
  );
  return t;
}

export const currentLanguage = () => current;

/** After sign-in: the account's language wins over the browser's. */
export function applyAccountLanguage(l: string | null | undefined) {
  if (known(l)) {
    try {
      localStorage.setItem(KEY, l);
    } catch {
      // private mode
    }
    set(l);
  } else set(stored() ?? browserLanguage());
}

/** Picks a language (null: follow the browser) and saves it to the account. */
export async function chooseLanguage(l: Language | null) {
  try {
    if (l) localStorage.setItem(KEY, l);
    else localStorage.removeItem(KEY);
  } catch {
    // private mode
  }
  set(l ?? browserLanguage());
  await api('/api/auth/language', { method: 'PUT', body: { language: l } });
}
