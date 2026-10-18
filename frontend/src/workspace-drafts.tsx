import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';

const WorkspaceDrafts = createContext<Map<string, unknown> | null>(null);

/** Unsubmitted editor input only, scoped to one authenticated workspace lifetime. */
export function WorkspaceDraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, unknown>());
  useEffect(() => {
    const current = drafts.current;
    return () => current.clear();
  }, []);
  return <WorkspaceDrafts.Provider value={drafts.current}>{children}</WorkspaceDrafts.Provider>;
}

export function useWorkspaceDraftState<T>(
  key: string,
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>] {
  const drafts = useContext(WorkspaceDrafts);
  const [value, setValue] = useState<T>(() =>
    drafts?.has(key)
      ? (drafts.get(key) as T)
      : typeof initial === 'function'
        ? (initial as () => T)()
        : initial,
  );
  const current = useRef(value);
  current.current = value;
  const setDraft = useCallback<Dispatch<SetStateAction<T>>>(
    (action) => {
      const previous = drafts?.has(key) ? (drafts.get(key) as T) : current.current;
      const next = typeof action === 'function' ? (action as (value: T) => T)(previous) : action;
      current.current = next;
      drafts?.set(key, next);
      setValue(next);
    },
    [drafts, key],
  );
  return [value, drafts ? setDraft : setValue];
}
