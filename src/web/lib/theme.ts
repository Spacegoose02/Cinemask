export const THEMES = ['dark', 'light', 'retro', 'futuristic', '16bit'] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABELS: Record<Theme, string> = { dark: 'Dark', light: 'Light', retro: 'Retro', futuristic: 'Futuristic', '16bit': '16-bit' };

/** Browser bar colour per theme, for phones and the installed app. */
const THEME_COLOR: Record<Theme, string> = { dark: '#0f1115', light: '#f6f7f9', retro: '#24170f', futuristic: '#05070f', '16bit': '#181838' };

const isTheme = (t: unknown): t is Theme => THEMES.includes(t as Theme);

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
}

/** Before sign-in: whatever this browser used last. */
export function applyStoredTheme(): void {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem('mm-theme');
  } catch {
    // storage blocked; fall back to dark
  }
  apply(isTheme(theme) ? theme : 'dark');
}

/** After sign-in: the theme saved on the account wins, so it follows you between devices. */
export function applyAccountTheme(theme: string | null | undefined): void {
  if (isTheme(theme)) setTheme(theme);
}

export function setTheme(theme: Theme): void {
  apply(theme);
  try {
    localStorage.setItem('mm-theme', theme);
  } catch {
    // ignore
  }
}
