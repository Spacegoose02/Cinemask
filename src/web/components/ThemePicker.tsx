import { useState } from 'react';
import { api } from '../lib/api';
import { setTheme, THEME_LABELS, THEMES, type Theme } from '../lib/theme';

/** Swatches use each theme's own colours, so the picker previews them whatever theme is active. */
const SWATCH: Record<Theme, { bg: string; surface: string; accent: string; text: string }> = {
  dark: { bg: '#0f1115', surface: '#1f232c', accent: '#f5a524', text: '#e6e8ee' },
  light: { bg: '#f6f7f9', surface: '#ffffff', accent: '#c27803', text: '#161a22' },
  retro: { bg: '#24170f', surface: '#402c20', accent: '#f08a24', text: '#f6e7c8' },
  futuristic: { bg: '#05070f', surface: '#10182e', accent: '#22d3ee', text: '#dbe6ff' },
  '16bit': { bg: '#181838', surface: '#303078', accent: '#f8d030', text: '#f8f8f8' },
};

export function ThemePicker({ current }: { current: string | null }) {
  const [active, setActive] = useState(current ?? document.documentElement.dataset.theme ?? 'dark');
  const pick = (t: Theme) => {
    setTheme(t);
    setActive(t);
    // Saved on the account so it follows you to other devices; the local choice already applied.
    void api('/api/auth/theme', { method: 'PUT', body: { theme: t } }).catch(() => undefined);
  };
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5" role="radiogroup" aria-label="Theme">
      {THEMES.map((t) => {
        const s = SWATCH[t];
        return (
          <button
            key={t}
            role="radio"
            aria-checked={active === t}
            onClick={() => pick(t)}
            className={`overflow-hidden rounded-md border-2 text-left ${active === t ? 'border-accent' : 'border-border hover:border-muted'}`}
          >
            <div className="flex h-14 items-end gap-1 p-2" style={{ background: s.bg }}>
              <span className="h-6 flex-1 rounded-sm" style={{ background: s.surface }} />
              <span className="h-4 w-6 rounded-sm" style={{ background: s.accent }} />
            </div>
            <div className="px-2 py-1 text-xs" style={{ background: s.surface, color: s.text }}>
              {THEME_LABELS[t]}
            </div>
          </button>
        );
      })}
    </div>
  );
}
