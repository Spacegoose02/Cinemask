import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
let waiting: ServiceWorker | null = null;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Registers the service worker (production builds only) and listens for the install prompt. */
export function setupPwa() {
  window.addEventListener('beforeinstallprompt', (e) => {
    // Chrome, Edge and Android: keep the prompt so the app can offer its own Install button.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    changed();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    changed();
  });

  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        const track = (sw: ServiceWorker | null) => {
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            // Installed while an older version controls the page: offer a reload.
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              waiting = sw;
              changed();
            }
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) {
          waiting = reg.waiting;
          changed();
        }
        track(reg.installing);
        reg.addEventListener('updatefound', () => track(reg.installing));
        // Installed apps can stay open for days; look for a new version now and then.
        setInterval(() => void reg.update().catch(() => undefined), 60 * 60 * 1000);
      })
      .catch(() => undefined);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !waiting) return;
      reloading = true;
      window.location.reload();
    });
  });
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function useStore() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

/**
 * How this browser can install Cinemask: 'prompt' (we can show the browser's install dialog),
 * 'ios' (Safari needs Share → Add to Home Screen), or null (already installed, or not supported).
 */
export function useInstall(): { mode: 'prompt' | 'ios' | null; install: () => Promise<void> } {
  useStore();
  if (isStandalone()) return { mode: null, install: async () => {} };
  if (deferred) {
    return {
      mode: 'prompt',
      install: async () => {
        const e = deferred;
        if (!e) return;
        await e.prompt();
        await e.userChoice.catch(() => undefined);
        deferred = null;
        changed();
      },
    };
  }
  return { mode: isIos() ? 'ios' : null, install: async () => {} };
}

/** A new version of the app has been downloaded; `apply` switches to it. */
export function useUpdateReady(): { ready: boolean; apply: () => void } {
  useStore();
  return { ready: waiting !== null, apply: () => waiting?.postMessage('skip-waiting') };
}

/** Whether the browser thinks it's online. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}
