// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { Pagination, TabPanel, Tabs, usePagination } from './ui-layout';
import { COMPACT_RECORD_QUERY } from './client-layout';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function DraftTabs() {
  const [tab, select] = useState('one');
  return (
    <form aria-label="Draft">
      <Tabs
        id="draft"
        label="Draft sections"
        tabs={[
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
          { id: 'three', label: 'Three' },
        ]}
        value={tab}
        onChange={select}
      />
      <TabPanel id="draft" tabId="one" active={tab === 'one'}>
        <label>
          Draft name
          <input name="name" defaultValue="Original" />
        </label>
        <button type="button" onClick={() => select('two')}>
          Open note editor
        </button>
      </TabPanel>
      <TabPanel id="draft" tabId="two" active={tab === 'two'}>
        <label>
          Draft note
          <input name="note" />
        </label>
      </TabPanel>
      <TabPanel id="draft" tabId="three" active={tab === 'three'}>
        Summary
      </TabPanel>
    </form>
  );
}
function Paged({ values, filter = '' }: { values: number[]; filter?: string }) {
  const pager = usePagination(values, 25, filter);
  return (
    <>
      <ol>
        {pager.items.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ol>
      <Pagination
        label="Records"
        page={pager.page}
        pageSize={pager.pageSize}
        total={pager.total}
        onPageChange={pager.setPage}
        onPageSizeChange={pager.setPageSize}
      />
    </>
  );
}
function reactiveCompact(initial: boolean) {
  let compact = initial;
  const list = new EventTarget();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return query === COMPACT_RECORD_QUERY && compact;
    },
    addEventListener: list.addEventListener.bind(list),
    removeEventListener: list.removeEventListener.bind(list),
  }));
  return (next: boolean) => {
    compact = next;
    act(() => list.dispatchEvent(new Event('change')));
  };
}

describe('Focused task layout behavior', () => {
  it('restores task focus when a list action opens a different panel', () => {
    render(<DraftTabs />);
    const open = screen.getByRole('button', { name: 'Open note editor' });
    open.focus();
    fireEvent.click(open);
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.queryByRole('button', { name: 'Open note editor' })).toBeNull();
  });
  it('links tabs to panels and supports wrapping arrow, Home and End keyboard navigation', () => {
    render(<DraftTabs />);
    const one = screen.getByRole('tab', { name: 'One' });
    one.focus();
    fireEvent.keyDown(one, { key: 'ArrowLeft' });
    const three = screen.getByRole('tab', { name: 'Three' });
    expect(document.activeElement).toBe(three);
    expect(three.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').id).toBe(three.getAttribute('aria-controls'));
    fireEvent.keyDown(three, { key: 'Home' });
    expect(document.activeElement).toBe(one);
    fireEvent.keyDown(one, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Two' }));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(three);
    expect(one.tabIndex).toBe(-1);
    expect(three.tabIndex).toBe(0);
  });

  it('hides unrelated controls while retaining edits in the same form submission', () => {
    render(<DraftTabs />);
    const name = screen.getByRole('textbox', { name: 'Draft name' });
    fireEvent.change(name, { target: { value: 'Unsaved edit' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.queryByRole('textbox', { name: 'Draft name' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft note' }), {
      target: { value: 'Second edit' },
    });
    const fields = new FormData(screen.getByRole('form') as HTMLFormElement);
    expect(Object.fromEntries(fields)).toEqual({ name: 'Unsaved edit', note: 'Second edit' });
    fireEvent.click(screen.getByRole('tab', { name: 'One' }));
    expect((screen.getByRole('textbox', { name: 'Draft name' }) as HTMLInputElement).value).toBe(
      'Unsaved edit',
    );
  });

  it('bounds rendered records, resets after filtering, and clamps after refresh removes a page', () => {
    const values = Array.from({ length: 120 }, (_, i) => i + 1);
    const { rerender } = render(<Paged values={values} />);
    const nav = screen.getByRole('navigation', { name: 'Records' });
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }));
    expect(screen.getAllByRole('listitem')[0]!.textContent).toBe('26');
    rerender(<Paged values={[117, 118, 119, 120]} filter="last" />);
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(within(nav).getByText('1–4 of 4')).toBeTruthy();
    rerender(<Paged values={values} />);
    fireEvent.click(within(nav).getByRole('button', { name: 'Next page' }));
    rerender(<Paged values={values.slice(0, 12)} />);
    expect(screen.getAllByRole('listitem')[0]!.textContent).toBe('1');
    expect(within(nav).getByText('1–12 of 12')).toBeTruthy();
    fireEvent.change(within(nav).getByRole('combobox'), { target: { value: '10' } });
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
  });

  it('starts mobile directories with five records and disables pagination for empty results', () => {
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(400);
    const { rerender } = render(<Paged values={Array.from({ length: 120 }, (_, i) => i)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    rerender(<Paged values={[]} filter="none" />);
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(screen.getByText('0 results')).toBeTruthy();
    for (const control of screen.getAllByRole('button'))
      expect((control as HTMLButtonElement).disabled).toBe(true);
  });

  it('reactively changes automatic page sizes, resets the page, and preserves unsaved form drafts', () => {
    const compact = reactiveCompact(false);
    render(
      <>
        <DraftTabs />
        <Paged values={Array.from({ length: 120 }, (_, i) => i + 1)} />
      </>,
    );
    const draft = screen.getByRole('textbox', { name: 'Draft name' });
    fireEvent.change(draft, { target: { value: 'Unsaved phone draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getAllByRole('listitem')[0]!.textContent).toBe('26');
    compact(true);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('1–5 of 120')).toBeTruthy();
    expect((draft as HTMLInputElement).value).toBe('Unsaved phone draft');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    compact(true); // Portrait and coarse-pointer landscape both retain the compact layout.
    expect(screen.getByText('6–10 of 120')).toBeTruthy();
    compact(false);
    expect(screen.getAllByRole('listitem')).toHaveLength(25);
    expect(screen.getByText('1–25 of 120')).toBeTruthy();
    expect((draft as HTMLInputElement).value).toBe('Unsaved phone draft');
  });

  it('preserves an explicit record count and current page across automatic layout changes', () => {
    const compact = reactiveCompact(true);
    render(<Paged values={Array.from({ length: 120 }, (_, i) => i + 1)} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('11–20 of 120')).toBeTruthy();
    compact(false);
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText('11–20 of 120')).toBeTruthy();
    compact(true);
    expect(screen.getByText('11–20 of 120')).toBeTruthy();
  });
});
