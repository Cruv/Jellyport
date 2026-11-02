import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Callout, Loading, Modal } from './components';
import SettingsPage from './SettingsPage';
import { LocalWorkspaceRoute, type WorkspaceRoute } from './routing';
import type {
  Api,
  Notify,
  Settings,
  Users,
  WorkflowAction,
  WorkflowReadinessSnapshot,
} from './types';

const Context = createContext<{
  snapshot: WorkflowReadinessSnapshot | null;
  loading: boolean;
  error: string;
  check: (refresh?: boolean) => Promise<void>;
  repair: (route: WorkspaceRoute) => void;
} | null>(null);

export function WorkflowProvider({
  api,
  notify,
  enabled,
  onSettingsSaved,
  demo = false,
  pendingSave = false,
  children,
}: {
  api: Api;
  notify: Notify;
  enabled: boolean;
  onSettingsSaved: (settings: Settings) => void;
  demo?: boolean;
  pendingSave?: boolean;
  children: ReactNode;
}) {
  const [snapshot, setSnapshot] = useState<WorkflowReadinessSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [setup, setSetup] = useState<WorkspaceRoute | null>(null);
  const [setupData, setSetupData] = useState<{ settings: Settings; users: Users } | null>(null);
  const [setupError, setSetupError] = useState('');
  const mounted = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const queuedRefresh = useRef<Promise<void> | null>(null);
  const setupGeneration = useRef(0);
  const setupController = useRef<AbortController | null>(null);
  const checkedAt = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controllers.current.forEach((controller) => controller.abort());
    };
  }, []);
  const check = useCallback(
    async (refresh = false): Promise<void> => {
      if (!enabled) return;
      if (pending.current) {
        if (!refresh) return pending.current;
        if (!queuedRefresh.current) {
          queuedRefresh.current = pending.current.then(async () => {
            queuedRefresh.current = null;
            await check(true);
          });
        }
        return queuedRefresh.current;
      }
      if (!refresh && checkedAt.current > Date.now() - 10_000) return;
      const controller = new AbortController();
      controllers.current.add(controller);
      setLoading(true);
      const task = (async () => {
        try {
          const result = await api<WorkflowReadinessSnapshot>(
            refresh ? '/api/workflow-readiness/refresh' : '/api/workflow-readiness',
            {
              ...(refresh ? { method: 'POST' as const, body: {} } : {}),
              signal: controller.signal,
            },
          );
          if (
            !result?.actions ||
            !Number.isFinite(Date.parse(result.checked_at)) ||
            !Object.values(result.actions).length ||
            Object.values(result.actions).some(
              (state) =>
                typeof state.ready !== 'boolean' ||
                !Array.isArray(state.blockers) ||
                !Array.isArray(state.warnings) ||
                state.ready !== (state.blockers.length === 0),
            )
          )
            throw new Error('Workflow requirements could not be checked.');
          if (mounted.current && !controller.signal.aborted) {
            setSnapshot(result);
            setError('');
            checkedAt.current = Date.now();
          }
        } catch (reason) {
          if (mounted.current && !controller.signal.aborted) {
            setSnapshot(null);
            setError(
              reason instanceof Error
                ? reason.message
                : 'Workflow requirements could not be checked.',
            );
          }
        } finally {
          controllers.current.delete(controller);
          if (mounted.current && !controller.signal.aborted) setLoading(false);
        }
      })();
      pending.current = task;
      try {
        await task;
      } finally {
        if (pending.current === task) pending.current = null;
      }
    },
    [api, enabled],
  );
  useEffect(() => {
    if (enabled) void check();
    else {
      checkedAt.current = 0;
      setSnapshot(null);
      setError('');
      setSetup(null);
    }
  }, [enabled, check]);
  const loadSetup = useCallback(async () => {
    const version = setupGeneration.current;
    setupController.current?.abort();
    const controller = new AbortController();
    setupController.current = controller;
    controllers.current.add(controller);
    setSetupError('');
    try {
      const [settings, users] = await Promise.all([
        api<Settings>('/api/settings', { signal: controller.signal }),
        api<Users>('/api/users', { signal: controller.signal }),
      ]);
      if (!mounted.current || controller.signal.aborted || version !== setupGeneration.current)
        return;
      setSetupData({ settings, users });
      onSettingsSaved(settings);
    } catch (reason) {
      if (mounted.current && !controller.signal.aborted && version === setupGeneration.current)
        setSetupError(reason instanceof Error ? reason.message : 'Setup could not be loaded.');
    } finally {
      controllers.current.delete(controller);
    }
  }, [api, onSettingsSaved]);
  const closeSetup = useCallback(() => {
    setupGeneration.current++;
    setupController.current?.abort();
    setSetup(null);
    setSetupData(null);
  }, []);
  const repair = useCallback(
    (route: WorkspaceRoute) => {
      setupGeneration.current++;
      setSetup(route);
      setSetupData(null);
      void loadSetup();
    },
    [loadSetup],
  );
  return (
    <Context.Provider value={{ snapshot, loading, error, check, repair }}>
      {children}
      {setup && (
        <Modal
          title="Complete required setup"
          description="Your current task stays open. Save the required setting, then return to continue."
          closeDisabled={pendingSave}
          close={() => {
            if (!pendingSave) closeSetup();
          }}
        >
          {setupError ? (
            <Callout warning title="Setup needs attention.">
              {setupError}
              <button type="button" className="btn" onClick={() => void loadSetup()}>
                Try again
              </button>
            </Callout>
          ) : !setupData ? (
            <Loading />
          ) : (
            <LocalWorkspaceRoute key={`${setup.page}:${setup.tab}:${setup.subtab}`} initial={setup}>
              <SettingsPage
                settings={setupData.settings}
                users={setupData.users}
                demo={demo}
                api={api}
                notify={notify}
                refresh={async () => {
                  await loadSetup();
                  await check(true);
                }}
                embedded
                pendingSave={pendingSave}
              />
            </LocalWorkspaceRoute>
          )}
          <div className="form-actions workflow-return">
            <button
              type="button"
              className="btn btn-primary"
              disabled={pendingSave}
              onClick={() => {
                closeSetup();
                void check(true);
              }}
            >
              Return to my task
            </button>
          </div>
        </Modal>
      )}
    </Context.Provider>
  );
}

export function useWorkflowAction(action: WorkflowAction) {
  const context = useContext(Context);
  useEffect(() => {
    if (context) void context.check();
  }, [action, context?.check]);
  return {
    managed: !!context,
    ready: context
      ? !!context.snapshot?.actions[action]?.ready && !context.error && !context.loading
      : true,
    loading: context?.loading ?? false,
    state: context?.snapshot?.actions[action],
    error: context?.error ?? '',
  };
}

export default function WorkflowRequirements({
  action,
  compact = false,
}: {
  action: WorkflowAction;
  compact?: boolean;
}) {
  const context = useContext(Context);
  const readiness = useWorkflowAction(action);
  if (!context) return null;
  if (readiness.loading && !readiness.state)
    return (
      <div className="workflow-check" role="status">
        Checking requirements…
      </div>
    );
  if (readiness.error || !readiness.state)
    return (
      <Callout warning title="Check requirements before continuing.">
        {readiness.error || 'Requirements have not been checked.'}{' '}
        <button className="text-button" type="button" onClick={() => void context.check(true)}>
          Check again
        </button>
      </Callout>
    );
  if (readiness.ready)
    return compact ? null : (
      <div className="workflow-check good">
        <span>Ready to continue</span>
        <small>Confirmed identities are reused. Optional links can be added within the task.</small>
      </div>
    );
  return (
    <section className="workflow-requirements" aria-label="Requirements for this task">
      <div>
        <h2>Before you continue</h2>
        <p>Resolve these requirements here. Your selected accounts and draft stay in place.</p>
      </div>
      <ul>
        {readiness.state.blockers.map((blocker) => (
          <li key={blocker.code}>
            <span>{blocker.message}</span>
            <button
              className="btn btn-small"
              type="button"
              onClick={() => context.repair(blocker.route)}
            >
              Resolve requirement
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="text-button" onClick={() => void context.check(true)}>
        Check requirements again
      </button>
    </section>
  );
}
