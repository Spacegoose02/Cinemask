import { useState } from 'react';
import { api } from '../lib/api';
import { setTheme, STYLE_LABELS, THEME_LIST, type Theme, type ThemeStyle } from '../lib/theme';

const STYLES = [...new Set(THEME_LIST.map((t) => t.style))] as ThemeStyle[];

/** Swatches use each theme's own colours, so the picker previews them whatever theme is active. */
export function ThemePicker({ current }: { current: string | null }) {
  const [active, setActive] = useState(current ?? document.documentElement.dataset.theme ?? 'dark');
  const pick = (t: Theme) => {
    setTheme(t);
    setActive(t);
    // Saved on the account so it follows you to other devices; the local choice already applied.
    void api('/api/auth/theme', { method: 'PUT', body: { theme: t } }).catch(() => undefined);
  };
  return (
    <div className="space-y-4" role="radiogroup" aria-label="Theme">
      {STYLES.map((style) => (
        <div key={style}>
          <h3 className="mb-2 text-sm font-medium text-muted">{STYLE_LABELS[style]}</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {THEME_LIST.filter((t) => t.style === style).map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={active === t.id}
                aria-label={t.label}
                onClick={() => pick(t.id)}
                className={`overflow-hidden rounded-md border-2 text-left ${active === t.id ? 'border-accent' : 'border-border hover:border-muted'}`}
              >
                <div className="flex h-14 items-end gap-1 p-2" style={{ background: t.bg }}>
                  <span className="h-6 flex-1 rounded-sm" style={{ background: t.surface }} />
                  <span className="h-4 w-6 rounded-sm" style={{ background: t.accent }} />
                </div>
                <div className="truncate px-2 py-1 text-xs" style={{ background: t.surface, color: t.text }}>
                  {t.label}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
