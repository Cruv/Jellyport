import { createHash, randomUUID } from 'node:crypto';
import type { Service } from './service.js';
import type { UserOrganization } from './user-organization.js';
import type { IdentityReviewApplyResult } from './identity-review-types.js';
import { ServiceError } from './errors.js';

type RoleStatus = IdentityReviewApplyResult['roles'];
interface RoleTask {
  id: string;
  scope: string;
  context: string;
  owners: string[];
  created_at: string;
  roles: RoleStatus;
}
/** Durable, idempotent informational role outbox. Approvals return within a short
 * budget while large Discord updates survive proxy disconnects and restarts. */
export class IdentityRoleSync {
  private worker: Promise<void> | null = null;
  private stopped = false;
  constructor(
    readonly service: Service,
    readonly organization: UserOrganization,
  ) {}
  private context(): string {
    const settings = this.service.store.settings();
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.service.mediaOwnerships.scope(settings),
          settings.discord_emby_role_id,
          settings.discord_jellyfin_role_id,
          settings.discord_emby_only_role,
        ]),
      )
      .digest('hex');
  }
  private tasks(): RoleTask[] {
    const rows = this.service.store.db
      .prepare('SELECT encrypted FROM identity_role_sync_tasks ORDER BY created_ms,id LIMIT 501')
      .all();
    if (rows.length > 500)
      throw new ServiceError('Too many pending Discord role updates. Review existing tasks first.');
    return rows.map((row) => this.service.store.decrypt<RoleTask>(row.encrypted as Uint8Array));
  }
  private save(task: RoleTask): void {
    this.service.store.db
      .prepare('INSERT OR REPLACE INTO identity_role_sync_tasks VALUES (?,?,?)')
      .run(task.id, Date.parse(task.created_at), this.service.store.encrypt(task));
  }
  /** Called only inside the same transaction that confirms media ownership. */
  enqueue(owners: string[]): string {
    if (this.stopped || this.service.demo)
      throw new ServiceError('Discord role synchronization is unavailable.');
    const tasks = this.tasks();
    // Keep recent outcomes without allowing completed history to accumulate forever.
    const finished = tasks.filter((task) => task.roles.status !== 'queued');
    for (const task of finished.slice(0, Math.max(0, finished.length - 100)))
      this.service.store.db.prepare('DELETE FROM identity_role_sync_tasks WHERE id=?').run(task.id);
    if (tasks.filter((task) => task.roles.status === 'queued').length >= 100)
      throw new ServiceError(
        'Wait for the pending Discord role updates before approving more identities.',
      );
    const id = randomUUID();
    this.save({
      id,
      scope: this.service.mediaOwnerships.scope(this.service.store.settings()),
      context: this.context(),
      owners: [...new Set(owners)],
      created_at: new Date().toISOString(),
      roles: {
        status: 'queued',
        task_id: id,
        updated: 0,
        failed: 0,
        message: 'Ownership saved. Discord organization roles are updating in the background.',
      },
    });
    return id;
  }
  status(id: string): RoleStatus {
    const task = this.tasks().find(
      (item) =>
        item.id === id &&
        item.scope === this.service.mediaOwnerships.scope(this.service.store.settings()),
    );
    if (!task)
      throw new ServiceError('This Discord role update is not available for the current server.');
    return { ...task.roles };
  }
  recent(): { tasks: Array<RoleStatus & { task_id: string; created_at: string }> } {
    const scope = this.service.mediaOwnerships.scope(this.service.store.settings());
    return {
      tasks: this.tasks()
        .filter((task) => task.scope === scope)
        .slice(-20)
        .reverse()
        .map((task) => ({ ...task.roles, task_id: task.id, created_at: task.created_at })),
    };
  }
  start(): Promise<void> {
    if (this.worker) return this.worker;
    if (this.stopped || this.service.demo) return Promise.resolve();
    this.worker = (async () => {
      while (!this.stopped) {
        const task = this.tasks().find((item) => item.roles.status === 'queued');
        if (!task) return;
        const guard = () => {
          if (this.stopped) throw new ServiceError('Discord role synchronization is stopping.');
          if (task.context !== this.context())
            throw new ServiceError(
              'Discord role configuration changed. Review the associations again.',
            );
        };
        try {
          guard();
          const result = await this.organization.syncOwners(task.owners, guard);
          task.roles = {
            ...result,
            task_id: task.id,
            status: result.failed ? 'failed' : 'updated',
            ...(result.failed
              ? {
                  message:
                    'Ownership is saved. Some role updates failed; refresh and retry organization synchronization.',
                }
              : {}),
          };
        } catch {
          if (this.stopped) return; // Preserve queued intent for the next startup.
          task.roles = {
            task_id: task.id,
            status: 'failed',
            updated: 0,
            failed: 0,
            message:
              'Ownership is saved. Discord roles could not finish; review permissions or changed configuration and retry organization synchronization.',
          };
        }
        this.save(task);
      }
    })().finally(() => {
      this.worker = null;
      // A new approval can commit while the previous worker's final promise is
      // settling. Ensure that narrow window never leaves durable work idle.
      if (!this.stopped && this.tasks().some((task) => task.roles.status === 'queued'))
        queueMicrotask(() => {
          void this.start().catch(() => {});
        });
    });
    return this.worker;
  }
  async withinBudget(id: string): Promise<RoleStatus> {
    const worker = this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 4000);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return this.status(id);
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.worker;
  }
}
