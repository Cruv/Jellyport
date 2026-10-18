import { useEffect, useState } from 'react';

export const COMPACT_RECORD_QUERY = '(max-width:700px), (max-width:1100px) and (pointer:coarse)';
export const NAVIGATION_DRAWER_QUERY = '(max-width:850px), (max-width:1100px) and (pointer:coarse)';

function capability(query: string, fallbackWidth: number): boolean {
  if (typeof window === 'undefined') return false;
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : window.innerWidth <= fallbackWidth;
}

/** Local layout capabilities only; never sent, persisted, or inferred from a user agent. */
export function useClientLayout() {
  const read = () => ({
    compactRecords: capability(COMPACT_RECORD_QUERY, 700),
    navigationDrawer: capability(NAVIGATION_DRAWER_QUERY, 850),
  });
  const [layout, setLayout] = useState(read);
  useEffect(() => {
    const update = () => {
      const next = read();
      setLayout((current) =>
        current.compactRecords === next.compactRecords &&
        current.navigationDrawer === next.navigationDrawer
          ? current
          : next,
      );
    };
    const lists =
      typeof window.matchMedia === 'function'
        ? [window.matchMedia(COMPACT_RECORD_QUERY), window.matchMedia(NAVIGATION_DRAWER_QUERY)]
        : [];
    for (const list of lists) {
      if (typeof list.addEventListener === 'function') list.addEventListener('change', update);
      else list.addListener?.(update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    update();
    return () => {
      for (const list of lists) {
        if (typeof list.removeEventListener === 'function')
          list.removeEventListener('change', update);
        else list.removeListener?.(update);
      }
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return layout;
}

/** Keep overlays inside the locally visible viewport when a mobile keyboard opens. */
export function useVisualViewport() {
  useEffect(() => {
    const style = document.documentElement.style;
    const height = '--viewport-height';
    const top = '--viewport-top';
    const previous = [height, top].map((key) => ({
      key,
      value: style.getPropertyValue(key),
      priority: style.getPropertyPriority(key),
    }));
    const viewport = window.visualViewport;
    const update = () => {
      const visibleHeight =
        viewport && Number.isFinite(viewport.height) && viewport.height > 0
          ? viewport.height
          : window.innerHeight;
      const visibleTop =
        viewport && Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : 0;
      style.setProperty(height, `${visibleHeight}px`);
      style.setProperty(top, `${visibleTop}px`);
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    update();
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      for (const item of previous) {
        if (item.value) style.setProperty(item.key, item.value, item.priority);
        else style.removeProperty(item.key);
      }
    };
  }, []);
}
