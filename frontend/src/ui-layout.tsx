import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useClientLayout } from './client-layout';

export function Tabs({
  id,
  label,
  tabs,
  value,
  onChange,
}: {
  id: string;
  label: string;
  tabs: { id: string; label: string; count?: number }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef(value);
  useLayoutEffect(() => {
    if (previous.current === value) return;
    const oldPanel = document.getElementById(`${id}-panel-${previous.current}`);
    previous.current = value;
    // List actions can open an editor and hide their own focused button.
    if (document.activeElement === document.body || oldPanel?.contains(document.activeElement)) {
      document.getElementById(`${id}-tab-${value}`)?.focus();
    }
  }, [id, value]);
  return (
    <div ref={list} className="page-tabs" role="tablist" aria-label={label}>
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`${id}-tab-${tab.id}`}
          aria-controls={`${id}-panel-${tab.id}`}
          aria-selected={value === tab.id}
          tabIndex={value === tab.id ? 0 : -1}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index - 1 + tabs.length) % tabs.length
                      : null;
            if (next === null) return;
            event.preventDefault();
            onChange(tabs[next]!.id);
            list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
          }}
        >
          {tab.label}
          {tab.count !== undefined && (
            <>
              {' '}
              <span className="tab-count">{tab.count.toLocaleString()}</span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  tabId,
  active,
  children,
  className = '',
}: {
  id: string;
  tabId: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`tab-panel ${className}`}
      role="tabpanel"
      id={`${id}-panel-${tabId}`}
      aria-labelledby={`${id}-tab-${tabId}`}
      hidden={!active}
    >
      {children}
    </section>
  );
}

export function usePagination<T>(values: T[], initialSize = 25, resetKey = '') {
  const { compactRecords } = useClientLayout();
  const [chosenSize, setSize] = useState<number | null>(null);
  const pageSize = chosenSize ?? (compactRecords ? 5 : initialSize);
  const [cursor, setCursor] = useState({ page: 1, key: resetKey, size: pageSize });
  const total = values.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.max(
    1,
    Math.min(cursor.key === resetKey && cursor.size === pageSize ? cursor.page : 1, pages),
  );
  useEffect(() => {
    setCursor((previous) =>
      previous.key !== resetKey || previous.size !== pageSize || previous.page > pages
        ? {
            key: resetKey,
            size: pageSize,
            page: Math.min(
              previous.key === resetKey && previous.size === pageSize ? previous.page : 1,
              pages,
            ),
          }
        : previous,
    );
  }, [resetKey, pageSize, pages]);
  return {
    page,
    pageSize,
    total,
    pages,
    start: total ? (page - 1) * pageSize + 1 : 0,
    end: Math.min(page * pageSize, total),
    items: values.slice((page - 1) * pageSize, page * pageSize),
    setPage: (next: number) =>
      setCursor({ key: resetKey, size: pageSize, page: Math.max(1, Math.min(next, pages)) }),
    setPageSize: (next: number) => {
      if (![5, 10, 25, 50].includes(next)) return;
      setSize(next);
      setCursor({ key: resetKey, size: next, page: 1 });
    },
  };
}

export function Pagination({
  label,
  page,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: {
  label: string;
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="pagination" aria-label={label}>
      <span className="pagination-range" role="status">
        {total
          ? `${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(page * pageSize, total).toLocaleString()} of ${total.toLocaleString()}`
          : '0 results'}
      </span>
      <div className="pagination-controls">
        {onPageSizeChange && (
          <label>
            Rows{' '}
            <select
              aria-label={`${label} per page`}
              value={pageSize}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
            >
              {[5, 10, 25, 50].map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className="btn btn-small btn-quiet"
          disabled={page <= 1}
          aria-label="Previous page"
          onClick={() => onPageChange(page - 1)}
        >
          Previous
        </button>
        <span className="pagination-page">
          Page {page} of {pages}
        </span>
        <button
          type="button"
          className="btn btn-small btn-quiet"
          disabled={page >= pages}
          aria-label="Next page"
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}
