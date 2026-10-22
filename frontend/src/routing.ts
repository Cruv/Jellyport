import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { Page } from './types';

export interface WorkspaceRoute {
  page: Page;
  tab?: string;
  subtab?: string;
}
const pages: readonly Page[] = [
  'overview',
  'users',
  'migrate',
  'mappings',
  'roles',
  'accounts',
  'memberships',
  'subscriptions',
  'activity',
  'settings',
];
const pageTabs: Partial<Record<Page, readonly string[]>> = {
  users: ['directory', 'organization'],
  mappings: ['list', 'editor'],
  roles: ['list', 'editor', 'apply'],
  accounts: ['create', 'recover'],
  memberships: ['overview', 'accounts', 'events'],
  subscriptions: ['review', 'history', 'all'],
  settings: ['media', 'accounts', 'discord', 'stripe', 'automation', 'history', 'activity'],
};
const settingsSubtabs: Record<string, readonly string[]> = {
  media: ['emby', 'jellyfin', 'paths'],
  accounts: ['permissions', 'passwords'],
  discord: ['connection', 'alerts'],
  automation: ['tiers', 'rules'],
  history: ['emby', 'jellyfin'],
};
const membershipSubtabs: Record<string, readonly string[]> = {
  accounts: ['list', 'editor'],
  events: ['review', 'history', 'all'],
};
const routeEvent = 'jellyport:routechange';
const skipAnchor = '#workspace-content';

function normalized(route: WorkspaceRoute): WorkspaceRoute {
  // Preserve bookmarks from the former separate subscriptions and membership editors.
  if (route.page === 'subscriptions')
    route = { page: 'memberships', tab: 'events', subtab: route.tab };
  else if (route.page === 'memberships' && ['list', 'editor'].includes(route.tab || ''))
    route = { page: 'memberships', tab: 'accounts', subtab: route.tab };
  const page = pages.includes(route.page) ? route.page : 'overview';
  const tabs = pageTabs[page];
  const tab = tabs ? (tabs.includes(route.tab ?? '') ? route.tab! : tabs[0]!) : undefined;
  const nested =
    page === 'settings' && tab && Object.hasOwn(settingsSubtabs, tab)
      ? settingsSubtabs[tab]
      : page === 'memberships' && tab && Object.hasOwn(membershipSubtabs, tab)
        ? membershipSubtabs[tab]
        : undefined;
  const subtab = nested
    ? nested.includes(route.subtab ?? '')
      ? route.subtab!
      : nested[0]!
    : undefined;
  return { page, ...(tab ? { tab } : {}), ...(subtab ? { subtab } : {}) };
}

/** Only literal navigation IDs are accepted. Records, filters and actions are never routes. */
export function parseWorkspaceRoute(hash: string): WorkspaceRoute {
  if (typeof hash !== 'string') return { page: 'overview' };
  const legacy = /^#settings-(media|accounts|discord|automation|history|activity)$/.exec(hash);
  if (legacy) return normalized({ page: 'settings', tab: legacy[1] });
  if (!hash.startsWith('#/') || hash.length > 128) return { page: 'overview' };
  const parts = hash.slice(2).split('/');
  if (parts.length > 3 || !pages.includes(parts[0] as Page)) return { page: 'overview' };
  return normalized({ page: parts[0] as Page, tab: parts[1], subtab: parts[2] });
}
export function workspaceRouteHash(route: WorkspaceRoute): string {
  const value = normalized(route);
  const segments: string[] = [value.page];
  if (value.tab && (value.page === 'settings' || value.tab !== pageTabs[value.page]?.[0]))
    segments.push(value.tab);
  if (value.subtab) segments.push(value.subtab);
  return '#/' + segments.join('/');
}
export function navigateWorkspace(
  route: WorkspaceRoute,
  options: { replace?: boolean } = {},
): void {
  if (typeof window.location.hash !== 'string') return;
  const hash = workspaceRouteHash(route);
  if (window.location.hash === hash) return;
  window.history[options.replace ? 'replaceState' : 'pushState'](null, '', hash);
  window.dispatchEvent(new Event(routeEvent));
}
function useRouteSnapshot(): WorkspaceRoute {
  const [route, setRoute] = useState(() => parseWorkspaceRoute(window.location.hash));
  useEffect(() => {
    const update = () => {
      // A legacy skip link is an in-page anchor, not a request to leave the workspace.
      if (window.location.hash !== skipAnchor) setRoute(parseWorkspaceRoute(window.location.hash));
    };
    window.addEventListener('popstate', update);
    window.addEventListener('hashchange', update);
    window.addEventListener(routeEvent, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener('hashchange', update);
      window.removeEventListener(routeEvent, update);
    };
  }, []);
  return route;
}
export function useWorkspaceRoute(): WorkspaceRoute {
  const route = useRouteSnapshot();
  useEffect(() => {
    if (window.location.hash !== skipAnchor) navigateWorkspace(route, { replace: true });
  }, [route]);
  return route;
}

/** Persist only a structural tab. All editor fields and selected records stay in memory. */
export function useRouteTab(
  page: Page,
  settingsSection?: string,
): [string, Dispatch<SetStateAction<string>>] {
  const route = useRouteSnapshot();
  const allowed = settingsSection
    ? ((page === 'memberships' ? membershipSubtabs : settingsSubtabs)[settingsSection] ?? [])
    : (pageTabs[page] ?? []);
  const fallback = allowed[0] ?? '';
  const selected =
    route.page === page && (!settingsSection || route.tab === settingsSection)
      ? ((settingsSection ? route.subtab : route.tab) ?? fallback)
      : null;
  const [remembered, setRemembered] = useState(selected ?? fallback);
  useEffect(() => {
    if (selected !== null) setRemembered(selected);
  }, [selected]);
  const value = selected ?? remembered;
  const currentValue = useRef(value);
  currentValue.current = value;
  const change = useCallback<Dispatch<SetStateAction<string>>>(
    (next) => {
      const target = typeof next === 'function' ? next(currentValue.current) : next;
      if (!allowed.includes(target)) return;
      currentValue.current = target;
      setRemembered(target);
      navigateWorkspace(
        settingsSection ? { page, tab: settingsSection, subtab: target } : { page, tab: target },
      );
    },
    [page, settingsSection, allowed],
  );
  return [value, change];
}
