import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

/**
 * Back and Forward return to where the page was scrolled, and pages can keep their filters per
 * history entry. BrowserRouter has no scroll restoration of its own, and the browser's gives up
 * because the page is still loading (and short) when it tries. Everything is keyed by the history
 * entry's key and kept in sessionStorage, so it also survives a reload of the tab.
 */

const SCROLL_KEY = 'cinemask:scroll';
// How long to keep trying while the page loads enough content to scroll that far.
const RESTORE_FOR_MS = 4000;

function readStore<T>(name: string): Record<string, T> {
  try {
    return JSON.parse(sessionStorage.getItem(name) ?? '{}') as Record<string, T>;
  } catch {
    return {};
  }
}

function writeStore(name: string, value: unknown) {
  try {
    sessionStorage.setItem(name, JSON.stringify(value));
  } catch {
    // Storage full or blocked: positions just aren't remembered.
  }
}

const positions = readStore<number>(SCROLL_KEY);
let flush = 0;
function remember(key: string, y: number) {
  positions[key] = Math.round(y);
  clearTimeout(flush);
  flush = window.setTimeout(() => writeStore(SCROLL_KEY, positions), 200);
}

export function ScrollRestoration() {
  const location = useLocation();
  const navigation = useNavigationType();
  const current = useRef(location.key);

  useEffect(() => {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    const onScroll = () => remember(current.current, window.scrollY);
    const onHide = () => writeStore(SCROLL_KEY, positions);
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', onHide);
    };
  }, []);

  // A layout effect runs before the browser fires the scroll event for the new, shorter page, so
  // that event can't overwrite the position saved for the page being left.
  useLayoutEffect(() => {
    current.current = location.key;
    if (navigation === 'REPLACE') return; // a filter tweak or redirect: stay put
    const target = navigation === 'POP' ? (positions[location.key] ?? 0) : 0;
    window.scrollTo(0, target);
    if (target <= 0) return;

    // Data is often still loading; keep scrolling down as the page grows, until the user takes over.
    const until = Date.now() + RESTORE_FOR_MS;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) window.removeEventListener(e, stop);
    };
    const step = () => {
      if (Math.abs(window.scrollY - target) <= 1 || Date.now() > until) return stop();
      window.scrollTo(0, target);
      frame = requestAnimationFrame(step);
    };
    for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) window.addEventListener(e, stop, { passive: true });
    frame = requestAnimationFrame(step);
    return stop;
  }, [location.key, navigation]);

  return null;
}

/**
 * useState that belongs to the current history entry: Back to this page brings the value back,
 * while opening the page fresh from a link starts from `initial`.
 */
export function usePageState<T>(name: string, initial: T): [T, (value: T) => void] {
  const { key, pathname } = useLocation();
  const storeName = `cinemask:page:${pathname}:${name}`;
  const [value, setValue] = useState<T>(() => {
    const saved = readStore<T>(storeName)[key];
    return saved === undefined ? initial : saved;
  });
  useEffect(() => {
    const all = readStore<T>(storeName);
    all[key] = value;
    // Keep the most recent entries only, so the store can't grow without end.
    writeStore(storeName, Object.fromEntries(Object.entries(all).slice(-30)));
  }, [storeName, key, value]);
  return [value, setValue];
}
