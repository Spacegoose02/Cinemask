import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { THEME_NAMES } from '../src/server/auth/apikey-routes.js';
import { THEME_LIST } from '../src/web/lib/theme.js';
import { makeApp, setupOwner } from './helpers.js';

describe('themes', () => {
  it('the server accepts exactly the themes the app offers, and each has colours in styles.css', () => {
    expect([...THEME_NAMES]).toEqual(THEME_LIST.map((t) => t.id));
    const css = fs.readFileSync(new URL('../src/web/styles.css', import.meta.url), 'utf8');
    for (const t of THEME_LIST) expect(css, t.id).toContain(`[data-theme='${t.id}'] {\n  --mm-bg: ${t.bg};`);
  });

  it('has five themes in each style, plus Blockbuster', () => {
    const counts: Record<string, number> = {};
    for (const t of THEME_LIST) counts[t.style] = (counts[t.style] ?? 0) + 1;
    expect(counts).toEqual({ dark: 5, light: 5, retro: 5, futuristic: 5, '16bit': 5, cinema: 5, blockbuster: 1 });
  });

  describe('saving a theme', () => {
    let t: Awaited<ReturnType<typeof makeApp>>;
    beforeAll(async () => (t = await makeApp()));
    afterAll(async () => t.close());
    it('accepts a new theme and refuses an unknown one', async () => {
      const owner = await setupOwner(t.app);
      expect((await owner.req('PUT', '/api/auth/theme', { theme: 'blockbuster' })).statusCode).toBe(200);
      expect((await owner.req('GET', '/api/auth/me')).json().user.theme).toBe('blockbuster');
      expect((await owner.req('PUT', '/api/auth/theme', { theme: 'nope' })).statusCode).toBe(400);
    });
  });
});
