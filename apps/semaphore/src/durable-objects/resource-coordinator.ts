import { DurableObject } from "cloudflare:workers";
import {
  AcquireResourceInput,
  DeleteResourceInput,
  ReleaseResourceInput,
  type SemaphoreJsonObject,
  type SemaphoreLeaseRecord,
} from "@iterate-com/semaphore-contract";
import type { Env } from "~/env.ts";
import {
  markResourceAvailableInDb,
  markResourceLeasedInDb,
  parseType,
  selectInventoryByType,
} from "~/lib/resource-store.ts";

type Waiter = {
  id: number;
  type: string;
  leaseMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (value: SemaphoreLeaseRecord | null) => void;
};

export class ResourceCoordinator extends DurableObject<Env> {
  private waiters: Waiter[] = [];
  private nextWaiterId = 0;
  private coordinatorType: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.initializeSql();
      await this.scheduleNextAlarm();
    });
  }

  async acquire(params: {
    type: string;
    leaseMs: number;
    waitMs?: number;
  }): Promise<SemaphoreLeaseRecord | null> {
    const { type, leaseMs, waitMs = 0 } = AcquireResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    const immediate = await this.tryAcquire(type, leaseMs);
    if (immediate) {
      return immediate;
    }
    if (waitMs <= 0) {
      return null;
    }

    return new Promise<SemaphoreLeaseRecord | null>((resolve) => {
      const waiterId = ++this.nextWaiterId;
      const waiter: Waiter = {
        id: waiterId,
        type,
        leaseMs,
        timeoutHandle: setTimeout(() => {
          if (waiter.settled) {
            return;
          }

          waiter.settled = true;
          this.waiters = this.waiters.filter((candidate) => candidate.id !== waiterId);
          resolve(null);
        }, waitMs),
        settled: false,
        resolve,
      };

      this.waiters.push(waiter);
    });
  }

  async release(params: { type: string; slug: string; leaseId: string }): Promise<boolean> {
    const { type, slug, leaseId } = ReleaseResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    const existing = this.ctx.storage.sql
      .exec<{ lease_id: string }>("SELECT lease_id FROM leases WHERE slug = ?", slug)
      .toArray()[0];

    if (!existing || existing.lease_id !== leaseId) {
      return false;
    }

    this.ctx.storage.sql.exec("DELETE FROM leases WHERE slug = ?", slug);
    this.logEvent("released", slug, { leaseId });
    await markResourceAvailableInDb(this.env.DB, {
      type,
      slug,
      lastReleasedAt: Date.now(),
    });
    await this.scheduleNextAlarm();
    await this.dispatchWaiters();
    return true;
  }

  async hasActiveLease(params: { type: string; slug: string }): Promise<boolean> {
    const { type, slug } = DeleteResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    await this.reapExpiredLeases(type);
    const row = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases WHERE slug = ?", slug)
      .one();
    return row.count > 0;
  }

  async inventoryChanged(params: { type: string }): Promise<void> {
    this.rememberCoordinatorType(params.type);
    await this.dispatchWaiters();
  }

  async alarm(): Promise<void> {
    await this.reapExpiredLeases();
    await this.scheduleNextAlarm();
    await this.dispatchWaiters();
  }

  private initializeSql() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        slug TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        event TEXT NOT NULL,
        slug TEXT,
        payload TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_leases_expires_at ON leases(expires_at)",
    );
  }

  private rememberCoordinatorType(type: string): void {
    const parsedType = parseType(type);
    const storedType = this.loadCoordinatorType();
    if (storedType && storedType !== parsedType) {
      throw new Error(
        `Coordinator type mismatch: expected ${storedType} but received ${parsedType}`,
      );
    }

    if (storedType === parsedType) {
      this.coordinatorType = parsedType;
      return;
    }

    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('type', ?)",
      parsedType,
    );
    this.coordinatorType = parsedType;
  }

  private loadCoordinatorType(): string | null {
    if (this.coordinatorType) {
      return this.coordinatorType;
    }

    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM metadata WHERE key = 'type'")
      .toArray()[0];
    const storedType = row?.value ? parseType(row.value) : null;
    this.coordinatorType = storedType;
    return storedType;
  }

  private async tryAcquire(type: string, leaseMs: number): Promise<SemaphoreLeaseRecord | null> {
    await this.reapExpiredLeases();

    const inventory = await selectInventoryByType(this.env.DB, type);
    if (inventory.length === 0) {
      return null;
    }

    const activeLeases = new Set(
      this.ctx.storage.sql
        .exec<{ slug: string }>("SELECT slug FROM leases")
        .toArray()
        .map((row) => row.slug),
    );

    const candidates = inventory.filter((resource) => !activeLeases.has(resource.slug));
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const now = Date.now();
      const expiresAt = now + leaseMs;
      const leaseId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO leases (slug, lease_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        candidate.slug,
        leaseId,
        expiresAt,
        now,
      );

      const mirrored = await markResourceLeasedInDb(this.env.DB, {
        type: candidate.type,
        slug: candidate.slug,
        leasedUntil: expiresAt,
        lastAcquiredAt: now,
      });
      if (!mirrored) {
        await this.releaseLease(type, candidate.slug, leaseId, "inventory-missing-after-acquire", {
          releasedAt: null,
        });
        continue;
      }

      this.logEvent("acquired", candidate.slug, { leaseId, expiresAt });
      await this.scheduleNextAlarm();

      return {
        type: candidate.type,
        slug: candidate.slug,
        data: candidate.data,
        leaseId,
        expiresAt,
      };
    }

    return null;
  }

  private async reapExpiredLeases(type?: string): Promise<void> {
    const now = Date.now();
    const expired = this.ctx.storage.sql
      .exec<{ slug: string; lease_id: string; expires_at: number }>(
        "SELECT slug, lease_id, expires_at FROM leases WHERE expires_at <= ? ORDER BY expires_at ASC",
        now,
      )
      .toArray();

    if (expired.length === 0) {
      return;
    }

    const coordinatorType = type ? parseType(type) : this.loadCoordinatorType();
    if (!coordinatorType) {
      throw new Error("Coordinator type is required to reap expired leases");
    }

    for (const lease of expired) {
      await this.releaseLease(coordinatorType, lease.slug, lease.lease_id, "expired", {
        expiresAt: lease.expires_at,
        releasedAt: now,
      });
    }
  }

  private async dispatchWaiters(): Promise<void> {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) {
        return;
      }

      if (waiter.settled) {
        continue;
      }

      const lease = await this.tryAcquire(waiter.type, waiter.leaseMs);
      if (!lease) {
        if (!waiter.settled) {
          this.waiters.unshift(waiter);
        }
        return;
      }

      if (waiter.settled) {
        await this.releaseLease(
          waiter.type,
          lease.slug,
          lease.leaseId,
          "timed-out-before-delivery",
          {
            releasedAt: null,
          },
        );
        continue;
      }

      waiter.settled = true;
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve(lease);
    }
  }

  private async releaseLease(
    type: string,
    slug: string,
    leaseId: string,
    event: string,
    payload: SemaphoreJsonObject & { releasedAt: number | null },
  ): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE slug = ? AND lease_id = ?", slug, leaseId);
    await markResourceAvailableInDb(this.env.DB, {
      type,
      slug,
      lastReleasedAt: payload.releasedAt,
    });
    this.logEvent(event, slug, { leaseId, ...payload });
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextLease = this.ctx.storage.sql
      .exec<{ expires_at: number }>("SELECT expires_at FROM leases ORDER BY expires_at ASC LIMIT 1")
      .toArray()[0];

    if (!nextLease) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextLease.expires_at);
  }

  private logEvent(event: string, slug: string | null, payload: SemaphoreJsonObject) {
    this.ctx.storage.sql.exec(
      "INSERT INTO events (occurred_at, event, slug, payload) VALUES (?, ?, ?, ?)",
      Date.now(),
      event,
      slug,
      JSON.stringify(payload),
    );
  }
}
