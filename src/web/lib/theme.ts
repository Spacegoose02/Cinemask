export const THEMES = ['dark', 'light'] as const;
export type Theme = (typeof THEMES)[number];

export function applyStoredTheme(): void {
  let theme: string | null = null;
  try {
    theme = localStorage.getItem('mm-theme');
  } catch {
    // storage blocked; fall back to dark
  }
  document.documentElement.dataset.theme = THEMES.includes(theme as Theme) ? theme! : 'dark';
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem('mm-theme', theme);
  } catch {
    // ignore
  }
}
