import { z } from "zod";
import { DurableObject } from "cloudflare:workers";
import {
  AcquireResourceInput,
  AcquireSpecificResourceInput,
  DeleteResourceInput,
  RenewResourceLeaseInput,
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

type Waiter = {
  id: number;
  type: string;
  leaseMs: number;
  holder: string | null;
  allowedSlugs: string[] | undefined;
  preferredTags: Record<string, string> | undefined;
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
    holder?: string;
    allowedSlugs?: string[];
    preferredTags?: Record<string, string>;
  }): Promise<SemaphoreLeaseRecord | null> {
    const {
      type,
      leaseMs,
      waitMs = 0,
      holder,
      allowedSlugs,
      preferredTags,
    } = AcquireResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    const immediate = await this.tryAcquire(
      type,
      leaseMs,
      holder || null,
      allowedSlugs,
      preferredTags,
    );
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
        holder: holder || null,
        allowedSlugs,
        preferredTags,
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

  async release(params: {
    type: string;
    slug: string;
    leaseId?: string;
    force?: boolean;
    tags?: Record<string, string>;
  }): Promise<boolean> {
    const { type, slug, leaseId, force, tags } = ReleaseResourceInput.parse(params);
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

    // Both writes happen without yielding: a taker cannot see stale preparation.
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO available_tags (slug, tags, lease_id) VALUES (?, ?, ?)",
      slug,
      JSON.stringify(matchesLeaseId ? tags || {} : {}),
      existing.lease_id,
    );
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
      .exec<{ lease_id: string; expires_at: number; holder: string | null }>(
        "SELECT lease_id, expires_at, holder FROM leases WHERE slug = ?",
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
    };
  }

  async acquireSpecific(params: {
    type: string;
    slug: string;
    leaseMs: number;
    holder?: string;
    force?: boolean;
    expectedHolder?: string;
    allowedSlugs?: string[];
  }) {
    const parsed = AcquireSpecificResourceInput.parse(params);

    this.rememberCoordinatorType(parsed.type);
    if (parsed.allowedSlugs && !parsed.allowedSlugs.includes(parsed.slug)) {
      return null;
    }
    await this.reapExpiredLeases(parsed.type);
    const inventory = await selectInventoryByType(this.env.DB, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    if (!candidate) return null;
    const activeLease = this.ctx.storage.sql
      .exec<{ lease_id: string; holder: string | null }>(
        "SELECT lease_id, holder FROM leases WHERE slug = ?",
        parsed.slug,
      )
      .toArray()[0];
    if (parsed.expectedHolder) {
      if (activeLease?.holder !== parsed.expectedHolder) return null;
      // Replace our own token atomically. Available tags never survive intervening use.
      this.ctx.storage.sql.exec("DELETE FROM leases WHERE slug = ?", parsed.slug);
      return this.createLease(candidate, parsed.leaseMs, parsed.holder || parsed.expectedHolder);
    }
    if (activeLease && !parsed.force) {
      return null;
    }
    if (activeLease) {
      await this.releaseLease(parsed.type, parsed.slug, activeLease.lease_id, "evicted", {
        holder: activeLease.holder,
        evictedBy: parsed.holder || null,
        releasedAt: Date.now(),
      });
    }

    const lease = candidate
      ? await this.createLease(candidate, parsed.leaseMs, parsed.holder || null)
      : null;
    if (activeLease && !lease) {
      // The eviction freed capacity but no new lease took it; wake waiters
      // like the public release path does.
      await this.dispatchWaiters();
    }

    return lease;
  }

  async renew(params: { type: string; slug: string; leaseId: string; leaseMs: number }) {
    const parsed = RenewResourceLeaseInput.parse(params);

    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const existing = this.ctx.storage.sql
      .exec<{
        lease_id: string;
        holder: string | null;
      }>("SELECT lease_id, holder FROM leases WHERE slug = ?", parsed.slug)
      .toArray()[0];
    if (!existing || existing.lease_id !== parsed.leaseId) {
      return null;
    }

    const inventory = await selectInventoryByType(this.env.DB, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    if (!candidate) {
      await this.release(parsed);
      return null;
    }

    const now = Date.now();
    const expiresAt = now + parsed.leaseMs;
    this.ctx.storage.sql.exec(
      "UPDATE leases SET expires_at = ? WHERE slug = ? AND lease_id = ?",
      expiresAt,
      parsed.slug,
      parsed.leaseId,
    );
    await markResourceLeasedInDb(this.env.DB, {
      type: parsed.type,
      slug: parsed.slug,
      leasedUntil: expiresAt,
      lastAcquiredAt: now,
      holder: existing.holder,
    });
    this.logEvent("renewed", parsed.slug, {
      leaseId: parsed.leaseId,
      expiresAt,
      holder: existing.holder,
    });
    await this.scheduleNextAlarm();

    return {
      type: candidate.type,
      slug: candidate.slug,
      data: candidate.data,
      leaseId: parsed.leaseId,
      expiresAt,
      holder: existing.holder,
    };
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

  /** Available-only metadata, kept next to the authoritative leases. */
  async availableTags(params: { type: string }): Promise<Record<string, Record<string, string>>> {
    this.rememberCoordinatorType(params.type);
    return Object.fromEntries(
      this.ctx.storage.sql
        .exec<{ slug: string; tags: string }>(
          `SELECT t.slug, t.tags FROM available_tags t
           JOIN events e ON e.id = (SELECT MAX(id) FROM events WHERE slug = t.slug)
           WHERE t.slug NOT IN (SELECT slug FROM leases)
             AND e.event = 'released' AND json_extract(e.payload, '$.leaseId') = t.lease_id`,
        )
        .toArray()
        .map((row) => [row.slug, z.record(z.string(), z.string()).parse(JSON.parse(row.tags))]),
    );
  }

  /** Deleted inventory must not carry preparation into a later resource with the same name. */
  async forgetTags(params: { type: string; slug: string }) {
    this.rememberCoordinatorType(params.type);
    this.ctx.storage.sql.exec("DELETE FROM available_tags WHERE slug = ?", params.slug);
  }

  private initializeSql() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS available_tags (slug TEXT PRIMARY KEY, tags TEXT NOT NULL)",
    );
    const tagColumns = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('available_tags')")
      .toArray();
    if (!tagColumns.some((column) => column.name === "lease_id")) {
      // Unbound records from before this migration cannot prove uninterrupted preparation.
      this.ctx.storage.sql.exec("ALTER TABLE available_tags ADD COLUMN lease_id TEXT");
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS leases (
        slug TEXT PRIMARY KEY,
        lease_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        holder TEXT
      )
    `);
    const leaseColumns = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM pragma_table_info('leases')")
      .toArray();
    if (!leaseColumns.some((column) => column.name === "holder")) {
      this.ctx.storage.sql.exec("ALTER TABLE leases ADD COLUMN holder TEXT");
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
    this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_events_slug_id ON events(slug, id)");
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

  private async tryAcquire(
    type: string,
    leaseMs: number,
    holder: string | null,
    allowedSlugs: string[] | undefined,
    preferredTags: Record<string, string> | undefined,
  ): Promise<SemaphoreLeaseRecord | null> {
    await this.reapExpiredLeases();

    const inventory = await selectInventoryByType(this.env.DB, type);
    if (inventory.length === 0) {
      return null;
    }

    const tags = preferredTags ? await this.availableTags({ type }) : {};
    const preferences = Object.entries(preferredTags || {});
    const preferredSlugs = new Set(
      Object.entries(tags)
        .filter(
          ([, resourceTags]) =>
            preferences.length > 0 &&
            preferences.every(
              ([key, value]) => Object.hasOwn(resourceTags, key) && resourceTags[key] === value,
            ),
        )
        .map(([slug]) => slug),
    );
    const activeLeases = new Set(
      this.ctx.storage.sql
        .exec<{ slug: string }>("SELECT slug FROM leases")
        .toArray()
        .map((row) => row.slug),
    );

    // Prefer matching free slots, with the oldest release first in each group.
    // With no preference, retain ordinary oldest-first selection (never-released first).
    const allowedSlugSet = allowedSlugs ? new Set(allowedSlugs) : null;
    const candidates = inventory
      .filter(
        (resource) =>
          !activeLeases.has(resource.slug) &&
          (allowedSlugSet === null || allowedSlugSet.has(resource.slug)),
      )
      .sort(
        (left, right) =>
          Number(preferredSlugs.has(right.slug)) - Number(preferredSlugs.has(left.slug)) ||
          (left.lastReleasedAt || 0) - (right.lastReleasedAt || 0),
      );
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const lease = await this.createLease(candidate, leaseMs, holder);
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
    for (;;) {
      const queued = this.waiters;
      const deferred: Waiter[] = [];
      let capacityFreedDuringPass = false;
      this.waiters = [];
      for (const waiter of queued) {
        if (waiter.settled) {
          continue;
        }

        const lease = await this.tryAcquire(
          waiter.type,
          waiter.leaseMs,
          waiter.holder,
          waiter.allowedSlugs,
          waiter.preferredTags,
        );
        if (!lease) {
          if (!waiter.settled) {
            deferred.push(waiter);
          }
          continue;
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
          capacityFreedDuringPass = true;
          continue;
        }

        waiter.settled = true;
        clearTimeout(waiter.timeoutHandle);
        waiter.resolve(lease);
      }

      const arrivals = this.waiters;
      this.waiters = [...deferred.filter((waiter) => !waiter.settled), ...arrivals];
      if (!capacityFreedDuringPass && arrivals.length === 0) {
        return;
      }
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

  private async createLease(
    candidate: Awaited<ReturnType<typeof selectInventoryByType>>[number],
    leaseMs: number,
    holder: string | null,
  ) {
    // Inventory reads can yield to another acquisition. Claim only if still free.
    if (
      this.ctx.storage.sql.exec("SELECT slug FROM leases WHERE slug = ?", candidate.slug).toArray()
        .length
    )
      return null;
    // Older service versions do not consume tags, but do record lease events.
    // Bind preparation to its releasing lease so a rollback cannot resurrect it.
    const tagsRow = this.ctx.storage.sql
      .exec<{ tags: string }>(
        `SELECT t.tags FROM available_tags t
         JOIN events e ON e.id = (SELECT MAX(id) FROM events WHERE slug = t.slug)
         WHERE t.slug = ? AND e.event = 'released'
           AND json_extract(e.payload, '$.leaseId') = t.lease_id`,
        candidate.slug,
      )
      .toArray()[0];
    const tags = tagsRow ? z.record(z.string(), z.string()).parse(JSON.parse(tagsRow.tags)) : {};
    this.ctx.storage.sql.exec("DELETE FROM available_tags WHERE slug = ?", candidate.slug);
    const now = Date.now();
    const expiresAt = now + leaseMs;
    const leaseId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      "INSERT INTO leases (slug, lease_id, expires_at, created_at, holder) VALUES (?, ?, ?, ?, ?)",
      candidate.slug,
      leaseId,
      expiresAt,
      now,
      holder,
    );

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

    this.logEvent("acquired", candidate.slug, { leaseId, expiresAt, holder });
    await this.scheduleNextAlarm();

    return {
      type: candidate.type,
      slug: candidate.slug,
      data: candidate.data,
      leaseId,
      expiresAt,
      holder,
      tags,
    } satisfies SemaphoreLeaseRecord;
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
