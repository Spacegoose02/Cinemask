/**
 * Every theme, grouped by style. Colours here are only for the picker's swatches and the browser
 * bar; the theme itself is the matching [data-theme] block in styles.css, and the style's shared
 * touches (fonts, borders, glow) hang off [data-style]. Keep THEME_NAMES in auth/apikey-routes.ts in step.
 */
export const THEME_LIST = [
  { id: 'dark', scheme: 'dark', label: 'Dark', style: 'dark', bg: '#0f1115', surface: '#1f232c', accent: '#f5a524', text: '#e6e8ee' },
  { id: 'midnight', scheme: 'dark', label: 'Midnight', style: 'dark', bg: '#0b1020', surface: '#1a2440', accent: '#6ea8ff', text: '#e3e9f7' },
  { id: 'oled', scheme: 'dark', label: 'OLED black', style: 'dark', bg: '#000000', surface: '#161616', accent: '#ffffff', text: '#f2f2f2' },
  { id: 'forest', scheme: 'dark', label: 'Forest', style: 'dark', bg: '#0e1612', surface: '#1c2b23', accent: '#7bc96f', text: '#e4efe7' },
  { id: 'plum', scheme: 'dark', label: 'Plum', style: 'dark', bg: '#150f1a', surface: '#281d33', accent: '#d07cff', text: '#efe6f5' },
  { id: 'light', scheme: 'light', label: 'Light', style: 'light', bg: '#f6f7f9', surface: '#eef0f4', accent: '#c27803', text: '#161a22' },
  { id: 'paper', scheme: 'light', label: 'Paper', style: 'light', bg: '#f5efe3', surface: '#efe6d4', accent: '#8a4b14', text: '#2b2418' },
  { id: 'mint', scheme: 'light', label: 'Mint', style: 'light', bg: '#f1f8f5', surface: '#e3f1eb', accent: '#0b7a5a', text: '#10231c' },
  { id: 'sky', scheme: 'light', label: 'Sky', style: 'light', bg: '#f2f6fc', surface: '#e4ecf8', accent: '#2563eb', text: '#0f1b2e' },
  { id: 'rose', scheme: 'light', label: 'Rosé', style: 'light', bg: '#fbf3f4', surface: '#f6e6e9', accent: '#be185d', text: '#2a1418' },
  { id: 'retro', scheme: 'dark', label: 'Picture palace', style: 'retro', bg: '#24170f', surface: '#402c20', accent: '#f08a24', text: '#f6e7c8' },
  { id: 'drivein', scheme: 'dark', label: 'Drive-in', style: 'retro', bg: '#12302f', surface: '#1f4a47', accent: '#ff7aa8', text: '#fdf3e1' },
  { id: 'vhs', scheme: 'dark', label: 'VHS', style: 'retro', bg: '#1a1033', surface: '#2d1d50', accent: '#ff3ea5', text: '#f3ecff' },
  { id: 'technicolor', scheme: 'dark', label: 'Technicolor', style: 'retro', bg: '#1b0d0d', surface: '#361a1a', accent: '#e8b923', text: '#fbeedd' },
  { id: 'kodachrome', scheme: 'light', label: 'Kodachrome', style: 'retro', bg: '#f4ead5', surface: '#efe1c4', accent: '#b4461a', text: '#2e2116' },
  { id: 'futuristic', scheme: 'dark', label: 'Neon', style: 'futuristic', bg: '#05070f', surface: '#10182e', accent: '#22d3ee', text: '#dbe6ff' },
  { id: 'synthwave', scheme: 'dark', label: 'Synthwave', style: 'futuristic', bg: '#120424', surface: '#261047', accent: '#ff4fd8', text: '#ffe9fb' },
  { id: 'terminal', scheme: 'dark', label: 'Terminal', style: 'futuristic', bg: '#020a04', surface: '#082010', accent: '#39ff6a', text: '#b7ffc9' },
  { id: 'ice', scheme: 'light', label: 'Ice', style: 'futuristic', bg: '#e9f1f8', surface: '#dde8f3', accent: '#0e7490', text: '#0b1a2c' },
  { id: 'mars', scheme: 'dark', label: 'Red planet', style: 'futuristic', bg: '#120806', surface: '#2a140e', accent: '#ff6a2b', text: '#ffe8dd' },
  { id: '16bit', scheme: 'dark', label: 'Console', style: '16bit', bg: '#181838', surface: '#303078', accent: '#f8d030', text: '#f8f8f8' },
  { id: 'pocket', scheme: 'light', label: 'Pocket', style: '16bit', bg: '#9bbc0f', surface: '#a6c41a', accent: '#0f380f', text: '#0f380f' },
  { id: 'arcade', scheme: 'dark', label: 'Arcade', style: '16bit', bg: '#050510', surface: '#1c1c40', accent: '#ffe600', text: '#ffffff' },
  { id: 'dungeon', scheme: 'dark', label: 'Dungeon', style: '16bit', bg: '#1c1a17', surface: '#3a362f', accent: '#e07b2c', text: '#ece3cf' },
  { id: 'island', scheme: 'dark', label: 'Island', style: '16bit', bg: '#173f96', surface: '#2a5fc8', accent: '#7ae87a', text: '#ffffff' },
  { id: 'velvet', scheme: 'dark', label: 'Velvet', style: 'cinema', bg: '#1a0508', surface: '#380f17', accent: '#d4af37', text: '#f9e9e4' },
  { id: 'artdeco', scheme: 'dark', label: 'Art deco', style: 'cinema', bg: '#0d0d0d', surface: '#201e1a', accent: '#c9a646', text: '#f3ead6' },
  { id: 'multiplex', scheme: 'dark', label: 'Multiplex', style: 'cinema', bg: '#12141c', surface: '#232737', accent: '#d62839', text: '#eef0f6' },
  { id: 'arthouse', scheme: 'light', label: 'Arthouse', style: 'cinema', bg: '#f3f0ea', surface: '#ebe6dd', accent: '#1f1c18', text: '#1f1c18' },
  { id: 'silver', scheme: 'dark', label: 'Silver screen', style: 'cinema', bg: '#141414', surface: '#272727', accent: '#d9d9d9', text: '#ededed' },
  { id: 'blockbuster', scheme: 'dark', label: 'Blockbuster', style: 'blockbuster', bg: '#00205b', surface: '#003aa3', accent: '#ffd100', text: '#ffffff' },
] as const;

export type Theme = (typeof THEME_LIST)[number]['id'];
export type ThemeStyle = (typeof THEME_LIST)[number]['style'];
export const THEMES = THEME_LIST.map((t) => t.id) as Theme[];

export const STYLE_LABELS: Record<ThemeStyle, string> = { dark: 'Dark', light: 'Light', retro: 'Retro', futuristic: 'Futuristic', '16bit': '16-bit', cinema: 'Cinemas', blockbuster: 'Special' };

const byId = new Map<string, (typeof THEME_LIST)[number]>(THEME_LIST.map((t) => [t.id, t]));
const isTheme = (t: unknown): t is Theme => typeof t === 'string' && byId.has(t);

function apply(theme: Theme) {
  const t = byId.get(theme)!;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.style = t.style;
  // Light themes get light form controls and scrollbars.
  document.documentElement.style.colorScheme = t.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
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
