import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useState,
  type ReactNode,
} from 'react';

interface Notice {
  id: number;
  message: string;
  error: boolean;
}
interface NoticeContext {
  notice?: Notice;
  dismiss: (id: number) => void;
  activeModal: string | undefined;
  registerModal: (id: string) => () => void;
}
const WorkspaceNotices = createContext<NoticeContext | null>(null);

/** Keep feedback in the active workspace or topmost dialog, never over its controls. */
export function WorkspaceNoticeProvider({
  notice,
  dismiss,
  children,
}: {
  notice?: Notice;
  dismiss: (id: number) => void;
  children: ReactNode;
}) {
  const [modals, setModals] = useState<string[]>([]);
  const registerModal = useCallback((id: string) => {
    setModals((current) => (current.includes(id) ? current : [...current, id]));
    return () => setModals((current) => current.filter((value) => value !== id));
  }, []);
  return (
    <WorkspaceNotices.Provider
      value={{ notice, dismiss, activeModal: modals.at(-1), registerModal }}
    >
      {children}
    </WorkspaceNotices.Provider>
  );
}

export function useWorkspaceNoticeModal() {
  const context = useContext(WorkspaceNotices);
  const id = useId();
  const register = context?.registerModal;
  useLayoutEffect(() => register?.(id), [register, id]);
  return context?.activeModal === id;
}

export function WorkspaceNotice({ dialog = false }: { dialog?: boolean }) {
  const context = useContext(WorkspaceNotices);
  if (!context?.notice || (dialog ? !context.activeModal : !!context.activeModal)) return null;
  const { notice, dismiss } = context;
  return (
    <div className="toast-region" aria-label="Notifications">
      <div
        className={`toast${notice.error ? ' error' : ''}`}
        role={notice.error ? 'alert' : 'status'}
        aria-atomic="true"
        key={notice.id}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {notice.error ? (
            <>
              <path d="m12 3 10 18H2L12 3Z" />
              <path d="M12 9v5M12 17h.01" />
            </>
          ) : (
            <path d="m5 12 4 4L19 6" />
          )}
        </svg>
        <span className="toast-message">{notice.message}</span>
        <button
          className="icon-button"
          type="button"
          aria-label="Dismiss notification"
          onClick={() => dismiss(notice.id)}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </div>
    </div>
  );
}
