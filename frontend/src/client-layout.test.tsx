// @vitest-environment jsdom
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  COMPACT_RECORD_QUERY,
  NAVIGATION_DRAWER_QUERY,
  useClientLayout,
  useVisualViewport,
} from './client-layout';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--viewport-height');
  document.documentElement.style.removeProperty('--viewport-top');
});
function Layout() {
  const layout = useClientLayout();
  return (
    <output>{`${layout.compactRecords ? 'compact' : 'regular'} / ${layout.navigationDrawer ? 'drawer' : 'sidebar'}`}</output>
  );
}
function Viewport() {
  useVisualViewport();
  return null;
}
function mediaQueries(initialWidth: number, initialCoarse: boolean) {
  let width = initialWidth;
  let coarse = initialCoarse;
  const lists = new Map<string, MediaQueryList>();
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      if (!lists.has(query)) {
        const target = new EventTarget() as MediaQueryList;
        Object.defineProperty(target, 'matches', {
          get: () =>
            width <= (query === COMPACT_RECORD_QUERY ? 700 : 850) || (width <= 1100 && coarse),
        });
        lists.set(query, target);
      }
      return lists.get(query)!;
    }),
  );
  return {
    lists,
    change(nextWidth: number, nextCoarse: boolean) {
      width = nextWidth;
      coarse = nextCoarse;
      act(() => {
        for (const list of lists.values()) list.dispatchEvent(new Event('change'));
      });
    },
  };
}

describe('local viewport and touch layout capabilities', () => {
  it('reacts to phone orientation and pointer changes without treating a fine-pointer desktop as a phone', () => {
    const media = mediaQueries(430, true);
    render(<Layout />);
    expect(screen.getByText('compact / drawer')).toBeTruthy();
    media.change(956, true);
    expect(screen.getByText('compact / drawer')).toBeTruthy();
    media.change(838, true);
    expect(screen.getByText('compact / drawer')).toBeTruthy();
    media.change(956, false);
    expect(screen.getByText('regular / sidebar')).toBeTruthy();
    media.change(800, false);
    expect(screen.getByText('regular / drawer')).toBeTruthy();
    media.change(1200, true);
    expect(screen.getByText('regular / sidebar')).toBeTruthy();
    expect(media.lists.size).toBe(2);
  });

  it('uses live width and orientation events as a fallback when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    vi.stubGlobal('innerWidth', 700);
    render(<Layout />);
    expect(screen.getByText('compact / drawer')).toBeTruthy();
    vi.stubGlobal('innerWidth', 701);
    fireEvent(window, new Event('orientationchange'));
    expect(screen.getByText('regular / drawer')).toBeTruthy();
    vi.stubGlobal('innerWidth', 851);
    fireEvent(window, new Event('resize'));
    expect(screen.getByText('regular / sidebar')).toBeTruthy();
  });

  it('releases media and fallback listeners on unmount, including StrictMode restarts', () => {
    const media = mediaQueries(430, true);
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(
      <StrictMode>
        <Layout />
      </StrictMode>,
    );
    const removeCompact = vi.spyOn(media.lists.get(COMPACT_RECORD_QUERY)!, 'removeEventListener');
    const removeDrawer = vi.spyOn(media.lists.get(NAVIGATION_DRAWER_QUERY)!, 'removeEventListener');
    unmount();
    expect(removeCompact).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removeDrawer).toHaveBeenCalledWith('change', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('orientationchange', expect.any(Function));
  });

  it('supports older media-query listener APIs and removes those subscriptions', () => {
    const callbacks = new Set<() => void>();
    let compact = false;
    const addListener = vi.fn((listener: () => void) => callbacks.add(listener));
    const removeListener = vi.fn((listener: () => void) => callbacks.delete(listener));
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return compact;
      },
      addListener,
      removeListener,
    }));
    const { unmount } = render(<Layout />);
    expect(screen.getByText('regular / sidebar')).toBeTruthy();
    compact = true;
    act(() => {
      for (const listener of callbacks) listener();
    });
    expect(screen.getByText('compact / drawer')).toBeTruthy();
    unmount();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(removeListener).toHaveBeenCalledTimes(2);
    expect(callbacks.size).toBe(0);
  });
});

describe('visible viewport CSS boundaries', () => {
  it('updates overlay bounds for keyboard resize and viewport panning, then restores prior CSS values', () => {
    const viewport = Object.assign(new EventTarget(), { height: 900, offsetTop: 0 });
    vi.stubGlobal('visualViewport', viewport);
    const style = document.documentElement.style;
    style.setProperty('--viewport-height', '111px', 'important');
    style.setProperty('--viewport-top', '2px');
    const removed = vi.spyOn(viewport, 'removeEventListener');
    const { unmount } = render(
      <StrictMode>
        <Viewport />
      </StrictMode>,
    );
    expect(style.getPropertyValue('--viewport-height')).toBe('900px');
    viewport.height = 390;
    viewport.offsetTop = 24;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(style.getPropertyValue('--viewport-height')).toBe('390px');
    expect(style.getPropertyValue('--viewport-top')).toBe('24px');
    viewport.offsetTop = 54;
    act(() => {
      viewport.dispatchEvent(new Event('scroll'));
    });
    expect(style.getPropertyValue('--viewport-top')).toBe('54px');
    unmount();
    expect(style.getPropertyValue('--viewport-height')).toBe('111px');
    expect(style.getPropertyPriority('--viewport-height')).toBe('important');
    expect(style.getPropertyValue('--viewport-top')).toBe('2px');
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('scroll', expect.any(Function));
    viewport.height = 200;
    act(() => {
      viewport.dispatchEvent(new Event('resize'));
    });
    expect(style.getPropertyValue('--viewport-height')).toBe('111px');
  });

  it('uses the live window height without visualViewport and removes its properties/listeners on unmount', () => {
    vi.stubGlobal('visualViewport', undefined);
    vi.stubGlobal('innerHeight', 600);
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Viewport />);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--viewport-height')).toBe('600px');
    expect(style.getPropertyValue('--viewport-top')).toBe('0px');
    vi.stubGlobal('innerHeight', 300);
    fireEvent(window, new Event('orientationchange'));
    expect(style.getPropertyValue('--viewport-height')).toBe('300px');
    unmount();
    expect(style.getPropertyValue('--viewport-height')).toBe('');
    expect(style.getPropertyValue('--viewport-top')).toBe('');
    expect(removed).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(removed).toHaveBeenCalledWith('orientationchange', expect.any(Function));
  });

  it('does not emit invalid CSS coordinates from unavailable viewport measurements', () => {
    vi.stubGlobal('innerHeight', 600);
    const viewport = Object.assign(new EventTarget(), { height: NaN, offsetTop: NaN });
    vi.stubGlobal('visualViewport', viewport);
    render(<Viewport />);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--viewport-height')).toBe('600px');
    expect(style.getPropertyValue('--viewport-top')).toBe('0px');
  });
});
