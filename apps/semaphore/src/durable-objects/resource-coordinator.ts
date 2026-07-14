import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  AcquireExclusiveResourceInput,
  AcquireResourceInput,
  AcquireSpecificResourceInput,
  DeleteResourceInput,
  MarkResourceLeaseReadyInput,
  ReleaseResourceInput,
  type SemaphoreJsonObject,
  type SemaphoreLeaseRecord,
} from "~/contract.ts";
import type { Env } from "~/env.ts";
import {
  markResourceAvailableInDb,
  markResourceLeasedInDb,
  parseType,
  selectInventoryByType,
} from "~/lib/resource-store.ts";

type LeaseRow = {
  slug: string;
  lease_id: string;
  expires_at: number;
  holder: string | null;
  phase: SemaphoreLeaseRecord["phase"];
};

export type AcquireExclusiveResult =
  | {
      status: "acquired";
      lease: SemaphoreLeaseRecord;
    }
  | { status: "unavailable" }
  | {
      status: "conflict";
      reason: "holder-already-active";
    };

type WaiterBase = {
  id: number;
  type: string;
  leaseMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settled: boolean;
};

type AcquireWaiter = WaiterBase & {
  kind: "acquire";
  holder: string | null;
  resolve: (value: SemaphoreLeaseRecord | null) => void;
};

type AcquireExclusiveWaiter = WaiterBase & {
  kind: "acquire-exclusive";
  holder: string;
  resolve: (value: AcquireExclusiveResult) => void;
};

type Waiter = AcquireWaiter | AcquireExclusiveWaiter;

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
    holder?: string;
  }): Promise<SemaphoreLeaseRecord | null> {
    const { type, leaseMs, waitMs = 0, holder } = AcquireResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    const immediate = await this.tryAcquire(type, leaseMs, holder ?? null);
    if (immediate) {
      return immediate;
    }
    if (waitMs <= 0) {
      return null;
    }

    return new Promise<SemaphoreLeaseRecord | null>((resolve) => {
      const waiterId = ++this.nextWaiterId;
      const waiter: AcquireWaiter = {
        kind: "acquire",
        id: waiterId,
        type,
        leaseMs,
        holder: holder ?? null,
        timeoutHandle: setTimeout(() => {
          this.timeoutWaiter(waiter);
        }, waitMs),
        settled: false,
        resolve,
      };

      this.waiters.push(waiter);
    });
  }

  async acquireExclusive(params: {
    type: string;
    holder: string;
    leaseMs: number;
    waitMs?: number;
  }): Promise<AcquireExclusiveResult> {
    const { type, holder, leaseMs, waitMs = 0 } = AcquireExclusiveResourceInput.parse(params);
    this.rememberCoordinatorType(type);

    const immediate = await this.tryAcquireExclusive(type, holder, leaseMs);
    if (immediate.status !== "unavailable" || waitMs <= 0) {
      return immediate;
    }

    return new Promise<AcquireExclusiveResult>((resolve) => {
      const waiterId = ++this.nextWaiterId;
      const waiter: AcquireExclusiveWaiter = {
        kind: "acquire-exclusive",
        id: waiterId,
        type,
        leaseMs,
        holder,
        timeoutHandle: setTimeout(() => {
          this.timeoutWaiter(waiter);
        }, waitMs),
        settled: false,
        resolve,
      };

      this.waiters.push(waiter);
    });
  }

  async release(params: {
    type: string;
    slug: string;
    leaseId?: string;
    force?: boolean;
  }): Promise<boolean> {
    const { type, slug, leaseId, force } = ReleaseResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    const existing = this.ctx.storage.sql
      .exec<{
        lease_id: string;
        holder: string | null;
      }>("SELECT lease_id, holder FROM leases WHERE slug = ?", slug)
      .toArray()[0];

    if (!existing) {
      return false;
    }
    const matchesLeaseId = existing.lease_id === leaseId;
    if (!matchesLeaseId && !force) {
      return false;
    }

    this.ctx.storage.sql.exec("DELETE FROM leases WHERE slug = ?", slug);
    this.logEvent(matchesLeaseId ? "released" : "force-released", slug, {
      leaseId: existing.lease_id,
      holder: existing.holder,
    });
    await markResourceAvailableInDb(this.env.DB, {
      type,
      slug,
      lastReleasedAt: Date.now(),
    });
    await this.scheduleNextAlarm();
    await this.dispatchWaiters();
    return true;
  }

  async getLease(params: { type: string; slug: string }) {
    const parsed = DeleteResourceInput.parse(params);
    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const existing = this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT slug, lease_id, expires_at, holder, phase FROM leases WHERE slug = ?",
        parsed.slug,
      )
      .toArray()[0];

    if (!existing) {
      return null;
    }

    return {
      leaseId: existing.lease_id,
      expiresAt: existing.expires_at,
      holder: existing.holder,
      phase: existing.phase,
    };
  }

  async acquireSpecific(params: {
    type: string;
    slug: string;
    leaseMs: number;
    holder?: string;
    force?: boolean;
  }) {
    const parsed = AcquireSpecificResourceInput.parse(params);

    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const activeLease = this.ctx.storage.sql
      .exec<{ lease_id: string; holder: string | null }>(
        "SELECT lease_id, holder FROM leases WHERE slug = ?",
        parsed.slug,
      )
      .toArray()[0];
    if (activeLease && !parsed.force) {
      return null;
    }
    if (activeLease) {
      await this.releaseLease(parsed.type, parsed.slug, activeLease.lease_id, "evicted", {
        holder: activeLease.holder,
        evictedBy: parsed.holder ?? null,
        releasedAt: Date.now(),
      });
    }

    const inventory = await selectInventoryByType(this.env.DB, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    const lease = candidate
      ? await this.createLease(candidate, parsed.leaseMs, parsed.holder ?? null)
      : null;
    if (activeLease && !lease) {
      // The eviction freed capacity but no new lease took it; wake waiters
      // like the public release path does.
      await this.dispatchWaiters();
    }

    return lease;
  }

  async renew(params: { type: string; slug: string; leaseId: string; leaseMs: number }) {
    const parsed = z
      .object({
        type: AcquireResourceInput.shape.type,
        slug: DeleteResourceInput.shape.slug,
        leaseId: z.uuid(),
        leaseMs: AcquireResourceInput.shape.leaseMs,
      })
      .parse(params);

    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const existing = this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT slug, lease_id, expires_at, holder, phase FROM leases WHERE slug = ?",
        parsed.slug,
      )
      .toArray()[0];
    if (!existing || existing.lease_id !== parsed.leaseId) {
      return null;
    }

    return this.renewLease(parsed.type, existing, parsed.leaseMs);
  }

  async markReady(params: {
    type: string;
    slug: string;
    leaseId: string;
  }): Promise<SemaphoreLeaseRecord | null> {
    const parsed = MarkResourceLeaseReadyInput.parse(params);
    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);

    const existing = this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT slug, lease_id, expires_at, holder, phase FROM leases WHERE slug = ? AND lease_id = ?",
        parsed.slug,
        parsed.leaseId,
      )
      .toArray()[0];
    if (!existing) {
      return null;
    }

    const inventory = await selectInventoryByType(this.env.DB, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    if (!candidate) {
      return null;
    }

    const updated = this.ctx.storage.sql
      .exec<LeaseRow>(
        `UPDATE leases
         SET phase = 'ready'
         WHERE slug = ? AND lease_id = ? AND expires_at > ?
         RETURNING slug, lease_id, expires_at, holder, phase`,
        parsed.slug,
        parsed.leaseId,
        Date.now(),
      )
      .toArray()[0];
    if (!updated) {
      return null;
    }

    if (existing.phase === "preparing") {
      this.logEvent("ready", parsed.slug, {
        leaseId: parsed.leaseId,
        expiresAt: updated.expires_at,
        holder: updated.holder,
      });
    }

    return this.toLeaseRecord(candidate, updated);
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
        created_at INTEGER NOT NULL,
        holder TEXT,
        phase TEXT NOT NULL DEFAULT 'preparing' CHECK (phase IN ('preparing', 'ready'))
      )
    `);
    const leaseColumns = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('leases')")
      .toArray();
    if (!leaseColumns.some((column) => column.name === "holder")) {
      this.ctx.storage.sql.exec("ALTER TABLE leases ADD COLUMN holder TEXT");
    }
    if (!leaseColumns.some((column) => column.name === "phase")) {
      this.ctx.storage.sql.exec(
        "ALTER TABLE leases ADD COLUMN phase TEXT NOT NULL DEFAULT 'preparing' CHECK (phase IN ('preparing', 'ready'))",
      );
    }
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
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS idx_leases_holder ON leases(holder) WHERE holder IS NOT NULL",
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

  private async tryAcquireExclusive(
    type: string,
    holder: string,
    leaseMs: number,
  ): Promise<AcquireExclusiveResult> {
    await this.reapExpiredLeases(type);
    if (this.hasLeaseForHolder(holder)) {
      return { status: "conflict", reason: "holder-already-active" };
    }

    const acquired = await this.tryAcquire(type, leaseMs, holder, { exclusiveHolder: holder });
    if (!acquired && this.hasLeaseForHolder(holder)) {
      return { status: "conflict", reason: "holder-already-active" };
    }
    return acquired ? { status: "acquired", lease: acquired } : { status: "unavailable" };
  }

  private hasLeaseForHolder(holder: string): boolean {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) AS count FROM leases WHERE holder = ?", holder)
        .one().count > 0
    );
  }

  private async tryAcquire(
    type: string,
    leaseMs: number,
    holder: string | null,
    options: { exclusiveHolder?: string } = {},
  ): Promise<SemaphoreLeaseRecord | null> {
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

    // Hand out the least-recently-released slot (never-released first). A
    // freed slot often still carries its previous holder's deployment; resting
    // it as long as possible maximizes the chance that holder retakes its own
    // slot before anyone else lands on it.
    const candidates = inventory
      .filter((resource) => !activeLeases.has(resource.slug))
      .sort((left, right) => (left.lastReleasedAt ?? 0) - (right.lastReleasedAt ?? 0));
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const lease = await this.createLease(candidate, leaseMs, holder, options);
      if (lease) {
        return lease;
      }
    }

    return null;
  }

  private async reapExpiredLeases(type?: string): Promise<void> {
    const now = Date.now();
    const expired = this.ctx.storage.sql
      .exec<{ slug: string; lease_id: string; expires_at: number; holder: string | null }>(
        "SELECT slug, lease_id, expires_at, holder FROM leases WHERE expires_at <= ? ORDER BY expires_at ASC",
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
        holder: lease.holder,
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

      if (waiter.kind === "acquire") {
        const lease = await this.tryAcquire(waiter.type, waiter.leaseMs, waiter.holder);
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
        continue;
      }

      const result = await this.tryAcquireExclusive(waiter.type, waiter.holder, waiter.leaseMs);
      if (result.status === "unavailable") {
        if (!waiter.settled) {
          this.waiters.unshift(waiter);
        }
        return;
      }

      if (waiter.settled) {
        if (result.status === "acquired") {
          await this.releaseLease(
            waiter.type,
            result.lease.slug,
            result.lease.leaseId,
            "timed-out-before-delivery",
            { releasedAt: null },
          );
        }
        continue;
      }

      waiter.settled = true;
      clearTimeout(waiter.timeoutHandle);
      waiter.resolve(result);
    }
  }

  private timeoutWaiter(waiter: Waiter): void {
    if (waiter.settled) {
      return;
    }

    waiter.settled = true;
    this.waiters = this.waiters.filter((candidate) => candidate.id !== waiter.id);
    if (waiter.kind === "acquire") {
      waiter.resolve(null);
    } else {
      waiter.resolve({ status: "unavailable" });
    }
  }

  private async releaseLease(
    type: string,
    slug: string,
    leaseId: string,
    event: string,
    payload: SemaphoreJsonObject & { releasedAt: number | null },
  ): Promise<boolean> {
    const deleted = this.ctx.storage.sql
      .exec<{ slug: string }>(
        "DELETE FROM leases WHERE slug = ? AND lease_id = ? RETURNING slug",
        slug,
        leaseId,
      )
      .toArray()[0];
    if (!deleted) {
      return false;
    }

    await markResourceAvailableInDb(this.env.DB, {
      type,
      slug,
      lastReleasedAt: payload.releasedAt,
    });
    this.logEvent(event, slug, { leaseId, ...payload });
    await this.scheduleNextAlarm();
    return true;
  }

  private async renewLease(
    type: string,
    existing: LeaseRow,
    leaseMs: number,
  ): Promise<SemaphoreLeaseRecord | null> {
    const inventory = await selectInventoryByType(this.env.DB, type);
    const candidate = inventory.find((resource) => resource.slug === existing.slug);
    if (!candidate) {
      await this.releaseLease(
        type,
        existing.slug,
        existing.lease_id,
        "inventory-missing-on-renew",
        {
          releasedAt: null,
        },
      );
      return null;
    }

    const now = Date.now();
    const expiresAt = now + leaseMs;
    const updated = this.ctx.storage.sql
      .exec<LeaseRow>(
        `UPDATE leases
         SET expires_at = ?
         WHERE slug = ? AND lease_id = ? AND expires_at > ?
         RETURNING slug, lease_id, expires_at, holder, phase`,
        expiresAt,
        existing.slug,
        existing.lease_id,
        now,
      )
      .toArray()[0];
    if (!updated) {
      return null;
    }

    const mirrored = await markResourceLeasedInDb(this.env.DB, {
      type,
      slug: existing.slug,
      leasedUntil: expiresAt,
      lastAcquiredAt: now,
      holder: updated.holder,
    });
    if (!mirrored) {
      await this.releaseLease(
        type,
        existing.slug,
        existing.lease_id,
        "inventory-missing-on-renew",
        {
          releasedAt: null,
        },
      );
      return null;
    }

    await this.scheduleNextAlarm();
    // D1 is an external binding, so awaiting the inventory mirror above lets
    // another request release or replace this generation. Never return a
    // capability unless the exact local lease still exists after that I/O.
    const current = this.readActiveLease(existing.slug, existing.lease_id);
    if (!current) {
      return null;
    }

    this.logEvent("renewed", existing.slug, {
      leaseId: existing.lease_id,
      expiresAt: current.expires_at,
      holder: current.holder,
      phase: current.phase,
    });
    return this.toLeaseRecord(candidate, current);
  }

  private async createLease(
    candidate: Awaited<ReturnType<typeof selectInventoryByType>>[number],
    leaseMs: number,
    holder: string | null,
    options: { exclusiveHolder?: string } = {},
  ) {
    const now = Date.now();
    const expiresAt = now + leaseMs;
    const leaseId = crypto.randomUUID();
    const inserted = options.exclusiveHolder
      ? this.ctx.storage.sql
          .exec<{ slug: string }>(
            `INSERT OR IGNORE INTO leases
               (slug, lease_id, expires_at, created_at, holder, phase)
             SELECT ?, ?, ?, ?, ?, 'preparing'
             WHERE NOT EXISTS (SELECT 1 FROM leases WHERE holder = ?)
             RETURNING slug`,
            candidate.slug,
            leaseId,
            expiresAt,
            now,
            holder,
            options.exclusiveHolder,
          )
          .toArray()[0]
      : this.ctx.storage.sql
          .exec<{ slug: string }>(
            `INSERT OR IGNORE INTO leases
               (slug, lease_id, expires_at, created_at, holder, phase)
             VALUES (?, ?, ?, ?, ?, 'preparing')
             RETURNING slug`,
            candidate.slug,
            leaseId,
            expiresAt,
            now,
            holder,
          )
          .toArray()[0];
    if (!inserted) {
      return null;
    }

    const mirrored = await markResourceLeasedInDb(this.env.DB, {
      type: candidate.type,
      slug: candidate.slug,
      leasedUntil: expiresAt,
      lastAcquiredAt: now,
      holder,
    });
    if (!mirrored) {
      await this.releaseLease(
        candidate.type,
        candidate.slug,
        leaseId,
        "inventory-missing-after-acquire",
        {
          releasedAt: null,
        },
      );
      return null;
    }

    await this.scheduleNextAlarm();
    const current = this.readActiveLease(candidate.slug, leaseId, "preparing");
    if (!current) {
      return null;
    }

    this.logEvent("acquired", candidate.slug, {
      leaseId,
      expiresAt: current.expires_at,
      holder: current.holder,
      phase: current.phase,
    });
    return this.toLeaseRecord(candidate, current);
  }

  private readActiveLease(
    slug: string,
    leaseId: string,
    requiredPhase?: LeaseRow["phase"],
  ): LeaseRow | null {
    const row = this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT slug, lease_id, expires_at, holder, phase FROM leases WHERE slug = ? AND lease_id = ? AND expires_at > ?",
        slug,
        leaseId,
        Date.now(),
      )
      .toArray()[0];
    if (!row || (requiredPhase && row.phase !== requiredPhase)) {
      return null;
    }
    return row;
  }

  private toLeaseRecord(
    candidate: Awaited<ReturnType<typeof selectInventoryByType>>[number],
    lease: LeaseRow,
  ): SemaphoreLeaseRecord {
    return {
      type: candidate.type,
      slug: candidate.slug,
      data: candidate.data,
      leaseId: lease.lease_id,
      expiresAt: lease.expires_at,
      holder: lease.holder,
      phase: lease.phase,
    };
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
