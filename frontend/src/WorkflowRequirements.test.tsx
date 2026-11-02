// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import WorkflowRequirements, { WorkflowProvider, useWorkflowAction } from './WorkflowRequirements';
import { Modal } from './components';
import type { Api, Settings, WorkflowReadinessSnapshot } from './types';

vi.mock('./SettingsPage', async () => {
  const { useRouteTab } = await import('./routing');
  return {
    default: ({ api, refresh }: { api: Api; refresh: () => Promise<void> }) => {
      const [tab, select] = useRouteTab('settings');
      return (
        <div>
          <p>Local setup section: {tab}</p>
          <button onClick={() => select('accounts')}>Account defaults section</button>
          <button
            onClick={async () => {
              await api('/api/settings', { method: 'PUT', body: { template_user_id: 'template' } });
              await refresh();
            }}
          >
            Save required setup
          </button>
        </div>
      );
    },
  };
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '#/accounts');
});
const settings = { template_user_id: '' } as Settings;
const ready = (value: boolean): WorkflowReadinessSnapshot => ({
  checked_at: new Date().toISOString(),
  sources: {
    emby: { configured: true, available: true },
    jellyfin: { configured: true, available: true },
  },
  actions: Object.fromEntries(
    [
      'create_account',
      'migrate',
      'migrate_saved',
      'account_roles',
      'account_mappings',
      'discord_roles',
      'identity_review',
      'account_access_emby',
      'account_access_jellyfin',
    ].map((name) => [
      name,
      {
        ready: value,
        blockers: value
          ? []
          : [
              {
                code: 'account_defaults',
                message: 'Choose account defaults first.',
                route: { page: 'settings', tab: 'accounts', subtab: 'permissions' },
              },
            ],
        warnings: [],
      },
    ]),
  ) as unknown as WorkflowReadinessSnapshot['actions'],
});
function Task() {
  const [draft, setDraft] = useState('');
  const check = useWorkflowAction('create_account');
  return (
    <>
      <label>
        Private task draft
        <input value={draft} onChange={(event) => setDraft(event.target.value)} />
      </label>
      <WorkflowRequirements action="create_account" />
      <button disabled={!check.ready}>Confirm task</button>
    </>
  );
}
function fixture(initial = false) {
  let current = initial;
  const api = vi.fn(async (path: string, options?: { method?: string }) => {
    if (path.startsWith('/api/workflow-readiness')) return ready(current);
    if (path === '/api/users') return { emby: [], jellyfin: [] };
    if (path === '/api/settings') {
      if (options?.method === 'PUT') current = true;
      return settings;
    }
    throw new Error('Unexpected synthetic API request');
  }) as Api;
  return {
    api,
    allow: () => {
      current = true;
    },
  };
}
describe('requirements within the current task', () => {
  it('blocks final action until checked and repairs setup without losing the task draft or route', async () => {
    window.history.replaceState(null, '', '#/accounts');
    const f = fixture();
    const onSettingsSaved = vi.fn();
    render(
      <WorkflowProvider api={f.api} notify={vi.fn()} enabled onSettingsSaved={onSettingsSaved}>
        <Task />
      </WorkflowProvider>,
    );
    fireEvent.change(screen.getByLabelText('Private task draft'), {
      target: { value: 'synthetic-private-account' },
    });
    await screen.findByText('Choose account defaults first.');
    expect(
      (screen.getByRole('button', { name: 'Confirm task' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve requirement' }));
    const setup = await screen.findByRole('dialog', { name: 'Complete required setup' });
    await within(setup).findByText('Local setup section: accounts');
    fireEvent.click(within(setup).getByRole('button', { name: 'Account defaults section' }));
    expect(window.location.hash).toBe('#/accounts');
    fireEvent.click(within(setup).getByRole('button', { name: 'Save required setup' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Confirm task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(within(setup).getByRole('button', { name: 'Return to my task' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByLabelText('Private task draft') as HTMLInputElement).value).toBe(
      'synthetic-private-account',
    );
    expect(window.location.hash).toBe('#/accounts');
    expect(onSettingsSaved).toHaveBeenCalled();
  });
  it('treats failed requirement reads as unavailable and supports retry before enabling the action', async () => {
    const f = fixture(true);
    let fail = true;
    const api = vi.fn(async (...args: Parameters<Api>) => {
      if (fail) throw new Error('Synthetic requirement outage');
      return f.api(...args);
    }) as Api;
    render(
      <WorkflowProvider api={api} notify={vi.fn()} enabled onSettingsSaved={vi.fn()}>
        <Task />
      </WorkflowProvider>,
    );
    await screen.findByText('Synthetic requirement outage');
    expect(
      (screen.getByRole('button', { name: 'Confirm task' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Confirm task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
  it('closes only the top setup dialog and preserves the parent focus and scroll lock', async () => {
    const f = fixture();
    const parentClosed = vi.fn();
    render(
      <WorkflowProvider api={f.api} notify={vi.fn()} enabled onSettingsSaved={vi.fn()}>
        <Modal title="Account task" close={parentClosed}>
          <Task />
        </Modal>
      </WorkflowProvider>,
    );
    await screen.findByText('Choose account defaults first.');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve requirement' }));
    await screen.findByRole('dialog', { name: 'Complete required setup' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Complete required setup' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Account task' })).toBeTruthy();
    expect(parentClosed).not.toHaveBeenCalled();
    expect(document.body.classList.contains('modal-open')).toBe(true);
  });
  it('discards setup reads that finish after the repair dialog is closed', async () => {
    const f = fixture();
    let finish!: (value: Settings) => void;
    let readSignal!: AbortSignal;
    const api = vi.fn(async (path: string, options?: { signal?: AbortSignal }) => {
      if (path === '/api/settings') {
        readSignal = options!.signal!;
        return new Promise<Settings>((done) => {
          finish = done;
        });
      }
      return f.api(path, options);
    }) as Api;
    const saved = vi.fn();
    render(
      <WorkflowProvider api={api} notify={vi.fn()} enabled onSettingsSaved={saved}>
        <Task />
      </WorkflowProvider>,
    );
    await screen.findByText('Choose account defaults first.');
    fireEvent.click(screen.getByRole('button', { name: 'Resolve requirement' }));
    const setup = await screen.findByRole('dialog', { name: 'Complete required setup' });
    fireEvent.click(within(setup).getByRole('button', { name: 'Close dialog' }));
    expect(readSignal.aborted).toBe(true);
    await act(async () => finish(settings));
    expect(saved).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('queues one fresh requirement read after an older check was in flight during setup save', async () => {
    const f = fixture();
    let finish!: (value: WorkflowReadinessSnapshot) => void;
    let refreshes = 0;
    const api = vi.fn(async (path: string, options?: Parameters<Api>[1]) => {
      if (path === '/api/workflow-readiness/refresh' && ++refreshes === 1)
        return new Promise<WorkflowReadinessSnapshot>((done) => {
          finish = done;
        });
      return f.api(path, options);
    }) as Api;
    render(
      <WorkflowProvider api={api} notify={vi.fn()} enabled onSettingsSaved={vi.fn()}>
        <Task />
      </WorkflowProvider>,
    );
    await screen.findByText('Choose account defaults first.');
    fireEvent.click(screen.getByRole('button', { name: 'Check requirements again' }));
    fireEvent.click(screen.getByRole('button', { name: 'Resolve requirement' }));
    const setup = await screen.findByRole('dialog', { name: 'Complete required setup' });
    fireEvent.click(await within(setup).findByRole('button', { name: 'Save required setup' }));
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith('/api/settings', expect.objectContaining({ method: 'PUT' })),
    );
    await act(async () => finish(ready(false)));
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Confirm task' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(refreshes).toBe(2);
  });
  it('restores focus to the parent task when Safari leaves the opener focus on the connected body', async () => {
    const f = fixture();
    render(
      <WorkflowProvider api={f.api} notify={vi.fn()} enabled onSettingsSaved={vi.fn()}>
        <Modal title="Account task" close={vi.fn()}>
          <Task />
        </Modal>
      </WorkflowProvider>,
    );
    await screen.findByText('Choose account defaults first.');
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByRole('button', { name: 'Resolve requirement' }));
    const setup = await screen.findByRole('dialog', { name: 'Complete required setup' });
    fireEvent.click(within(setup).getByRole('button', { name: 'Return to my task' }));
    const parent = screen.getByRole('dialog', { name: 'Account task' });
    expect(parent.contains(document.activeElement)).toBe(true);
  });
});
