// @vitest-environment jsdom
/// <reference types="node" />
import { StrictMode, useState } from 'react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Modal } from './components';
import { WorkspaceNotice, WorkspaceNoticeProvider } from './workspace-notices';
// Vitest stubs CSS imports by default; exercise the actual shared stylesheet.
const styles = readFileSync(`${import.meta.dirname}/styles.css`, 'utf8');

let stylesheet: HTMLStyleElement;
beforeEach(() => {
  stylesheet = document.createElement('style');
  stylesheet.textContent = styles;
  document.head.append(stylesheet);
});
afterEach(() => {
  cleanup();
  stylesheet.remove();
  document.body.classList.remove('modal-open');
});
const notice = { id: 1, message: 'Membership saved.', error: false };

function dialogWorkspace() {
  const dismiss = vi.fn();
  function Workspace({ current }: { current?: typeof notice }) {
    const [open, setOpen] = useState(false);
    return (
      <WorkspaceNoticeProvider notice={current} dismiss={dismiss}>
        <WorkspaceNotice />
        <button onClick={() => setOpen(true)}>Open review</button>
        {open && (
          <Modal
            title="Review"
            close={() => setOpen(false)}
            footer={<button onClick={() => setOpen(false)}>Cancel</button>}
          >
            <p>Review the requested change.</p>
          </Modal>
        )}
      </WorkspaceNoticeProvider>
    );
  }
  const view = render(<Workspace current={notice} />);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'Open review' }));
  open();
  return {
    dismiss,
    open,
    setNotice: (current?: typeof notice) => view.rerender(<Workspace current={current} />),
  };
}

describe('workspace notices', () => {
  it('keeps the dialog notice mounted through automatic expiry and releases it when the dialog closes', () => {
    const view = dialogWorkspace();
    const dialog = screen.getByRole('dialog', { name: 'Review' });
    const status = within(dialog).getByRole('status');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    cancel.focus();
    fireEvent.mouseDown(cancel);
    // App's ordinary timer removes its notice prop. That must not collapse a
    // live dialog body between pointer down and pointer up on a footer action.
    view.setNotice(undefined);
    expect(within(dialog).getByRole('status')).toBe(status);
    expect(status.isConnected).toBe(true);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(status.closest('.modal-body')).toBeTruthy();
    expect(document.activeElement).toBe(cancel);
    expect(view.dismiss).not.toHaveBeenCalled();
    fireEvent.mouseUp(cancel);
    fireEvent.click(cancel);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText(notice.message)).toBeNull();
    view.open();
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByText(notice.message)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retains only the latest dialog notice and allows explicit dismissal after parent expiry', () => {
    const view = dialogWorkspace();
    const latest = { id: 2, message: 'Latest request failed.', error: true };
    view.setNotice(latest);
    const error = screen.getByRole('alert');
    expect(screen.queryByText(notice.message)).toBeNull();
    view.setNotice(undefined);
    expect(screen.getByRole('alert')).toBe(error);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(view.dismiss).toHaveBeenCalledExactlyOnceWith(latest.id);
    expect(screen.queryByText(latest.message)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    view.setNotice(undefined);
    expect(screen.queryByText(latest.message)).toBeNull();
    const newer = { id: 3, message: 'Newer change saved.', error: false };
    view.setNotice(newer);
    view.setNotice(undefined);
    expect(screen.getByText(newer.message)).toBeTruthy();
    expect(screen.queryByText(latest.message)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    view.open();
    expect(screen.queryByText(newer.message)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows only the latest workspace toast outside document flow without blocking the primary action', () => {
    const dismiss = vi.fn();
    const view = render(
      <WorkspaceNoticeProvider notice={notice} dismiss={dismiss}>
        <WorkspaceNotice />
        <button>Create accounts</button>
      </WorkspaceNoticeProvider>,
    );
    const region = screen.getByText('Membership saved.').closest('.toast-region')!;
    expect(region.nextElementSibling).toBe(screen.getByRole('button', { name: 'Create accounts' }));
    expect(getComputedStyle(region).position).toBe('fixed');
    expect(getComputedStyle(region).pointerEvents).toBe('none');
    const button = screen.getByRole('button', { name: 'Dismiss notification' });
    expect(getComputedStyle(button).pointerEvents).toBe('auto');
    expect(getComputedStyle(button).minWidth).toBe('44px');
    expect(getComputedStyle(button).minHeight).toBe('44px');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    view.rerender(
      <WorkspaceNoticeProvider
        notice={{ id: 2, message: '<script>synthetic()</script> Request failed.', error: true }}
        dismiss={dismiss}
      >
        <WorkspaceNotice />
        <button>Create accounts</button>
      </WorkspaceNoticeProvider>,
    );
    expect(screen.queryByText('Membership saved.')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(document.querySelector('script')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(2);
    view.rerender(
      <WorkspaceNoticeProvider dismiss={dismiss}>
        <WorkspaceNotice />
        <button>Create accounts</button>
      </WorkspaceNoticeProvider>,
    );
    expect(document.querySelector('.toast-region')).toBeNull();
  });

  it('moves feedback into the dialog body without duplicates, leaves footer actions separate, and does not steal focus', () => {
    function Workspace({ message = notice.message }: { message?: string }) {
      const [open, setOpen] = useState(false);
      return (
        <WorkspaceNoticeProvider notice={{ ...notice, message }} dismiss={vi.fn()}>
          <WorkspaceNotice />
          <button onClick={() => setOpen(true)}>Open review</button>
          {open && (
            <Modal
              title="Review"
              close={() => setOpen(false)}
              footer={<button>Confirm changes</button>}
            >
              <label>
                Note
                <input />
              </label>
            </Modal>
          )}
        </WorkspaceNoticeProvider>
      );
    }
    const view = render(<Workspace />);
    const opener = screen.getByRole('button', { name: 'Open review' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    const status = within(dialog).getByRole('status');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(status.closest('.modal-body')).toBeTruthy();
    const confirm = within(dialog).getByRole('button', { name: 'Confirm changes' });
    expect(confirm.closest('.modal-footer')).toBeTruthy();
    expect(status.contains(confirm)).toBe(false);
    const input = screen.getByRole('textbox', { name: 'Note' });
    input.focus();
    view.rerender(<Workspace message="Review updated." />);
    expect(document.activeElement).toBe(input);
    expect(within(dialog).getByText('Review updated.')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(document.activeElement).toBe(opener);
    expect(screen.getByText('Review updated.').closest('.modal-body')).toBeNull();
  });

  it('registers only the topmost dialog and restores the underlying notice after StrictMode cleanup', () => {
    function Workspace() {
      const [second, setSecond] = useState(true),
        [first, setFirst] = useState(true);
      return (
        <WorkspaceNoticeProvider notice={notice} dismiss={vi.fn()}>
          <WorkspaceNotice />
          {first && (
            <Modal title="First" close={() => setFirst(false)}>
              <p>First content</p>
            </Modal>
          )}
          {second && (
            <Modal title="Second" close={() => setSecond(false)}>
              <p>Second content</p>
            </Modal>
          )}
        </WorkspaceNoticeProvider>
      );
    }
    render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    let dialogs = screen.getAllByRole('dialog');
    expect(within(dialogs[0]).queryByRole('status')).toBeNull();
    expect(within(dialogs[1]).getByRole('status')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(within(dialogs[1]).getByRole('button', { name: 'Close dialog' }));
    dialogs = screen.getAllByRole('dialog');
    expect(within(dialogs[0]).getByRole('status')).toBeTruthy();
    fireEvent.click(within(dialogs[0]).getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('has no persistent notice state outside its provider', () => {
    const view = render(
      <WorkspaceNoticeProvider notice={notice} dismiss={vi.fn()}>
        <WorkspaceNotice />
      </WorkspaceNoticeProvider>,
    );
    expect(screen.getByText(notice.message)).toBeTruthy();
    view.unmount();
    render(
      <WorkspaceNoticeProvider dismiss={vi.fn()}>
        <WorkspaceNotice />
      </WorkspaceNoticeProvider>,
    );
    expect(screen.queryByText(notice.message)).toBeNull();
  });
});
