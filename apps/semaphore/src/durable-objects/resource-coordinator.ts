import { DurableObject } from "cloudflare:workers";
import {
  AcquireResourceInput,
  DeleteResourceInput,
  ReleaseResourceInput,
  type SemaphoreJsonObject,
  type SemaphoreLeaseRecord,
} from "@iterate-com/semaphore-contract";
import { z } from "zod";
import {
  createD1Client,
  createDurableObjectClient,
  type AsyncClient,
  type SyncClient,
} from "sqlfu";
import { migrate } from "./db/migrations/.generated/migrations.ts";
import {
  deleteLeaseBySlug,
  deleteLeaseBySlugAndLeaseId,
  insertCoordinatorType,
  insertEvent,
  insertLease,
  selectActiveLeaseSlugs,
  selectCoordinatorType,
  selectExpiredLeases,
  selectLeaseBySlug,
  selectLeaseCountBySlug,
  selectLeaseIdBySlug,
  selectNextLease,
  updateLeaseExpires,
} from "./db/queries/.generated/index.ts";
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
  private readonly client: SyncClient;
  private readonly resourcesDb: AsyncClient;
  private waiters: Waiter[] = [];
  private nextWaiterId = 0;
  private coordinatorType: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.client = createDurableObjectClient(ctx.storage);
    this.resourcesDb = createD1Client(env.DB);
    this.ctx.blockConcurrencyWhile(async () => {
      migrate(this.client);
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
    const existing = selectLeaseIdBySlug(this.client, { slug });

    if (!existing || existing.lease_id !== leaseId) {
      return false;
    }

    deleteLeaseBySlug(this.client, { slug });
    this.logEvent("released", slug, { leaseId });
    await markResourceAvailableInDb(this.resourcesDb, {
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
    const existing = selectLeaseBySlug(this.client, { slug: parsed.slug });

    if (!existing) {
      return null;
    }

    return {
      leaseId: existing.lease_id,
      expiresAt: existing.expires_at,
    };
  }

  async acquireSpecific(params: { type: string; slug: string; leaseMs: number }) {
    const parsed = z
      .object({
        type: AcquireResourceInput.shape.type,
        slug: DeleteResourceInput.shape.slug,
        leaseMs: AcquireResourceInput.shape.leaseMs,
      })
      .parse(params);

    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const activeLease = selectLeaseIdBySlug(this.client, { slug: parsed.slug });
    if (activeLease) {
      return null;
    }

    const inventory = await selectInventoryByType(this.resourcesDb, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    if (!candidate) {
      return null;
    }

    return this.createLease(candidate, parsed.leaseMs);
  }

  async renew(params: { type: string; slug: string; leaseId: string; leaseMs: number }) {
    const parsed = z
      .object({
        type: AcquireResourceInput.shape.type,
        slug: DeleteResourceInput.shape.slug,
        leaseId: ReleaseResourceInput.shape.leaseId,
        leaseMs: AcquireResourceInput.shape.leaseMs,
      })
      .parse(params);

    this.rememberCoordinatorType(parsed.type);
    await this.reapExpiredLeases(parsed.type);
    const existing = selectLeaseIdBySlug(this.client, { slug: parsed.slug });
    if (!existing || existing.lease_id !== parsed.leaseId) {
      return null;
    }

    const inventory = await selectInventoryByType(this.resourcesDb, parsed.type);
    const candidate = inventory.find((resource) => resource.slug === parsed.slug);
    if (!candidate) {
      await this.release(parsed);
      return null;
    }

    const now = Date.now();
    const expiresAt = now + parsed.leaseMs;
    updateLeaseExpires(this.client, { expiresAt }, { slug: parsed.slug, leaseId: parsed.leaseId });
    await markResourceLeasedInDb(this.resourcesDb, {
      type: parsed.type,
      slug: parsed.slug,
      leasedUntil: expiresAt,
      lastAcquiredAt: now,
    });
    this.logEvent("renewed", parsed.slug, { leaseId: parsed.leaseId, expiresAt });
    await this.scheduleNextAlarm();

    return {
      type: candidate.type,
      slug: candidate.slug,
      data: candidate.data,
      leaseId: parsed.leaseId,
      expiresAt,
    };
  }

  async hasActiveLease(params: { type: string; slug: string }): Promise<boolean> {
    const { type, slug } = DeleteResourceInput.parse(params);
    this.rememberCoordinatorType(type);
    await this.reapExpiredLeases(type);
    const row = selectLeaseCountBySlug(this.client, { slug });
    if (!row) {
      return false;
    }
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

    insertCoordinatorType(this.client, { type: parsedType });
    this.coordinatorType = parsedType;
  }

  private loadCoordinatorType(): string | null {
    if (this.coordinatorType) {
      return this.coordinatorType;
    }

    const row = selectCoordinatorType(this.client);
    const storedType = row?.value ? parseType(row.value) : null;
    this.coordinatorType = storedType;
    return storedType;
  }

  private async tryAcquire(type: string, leaseMs: number): Promise<SemaphoreLeaseRecord | null> {
    await this.reapExpiredLeases();

    const inventory = await selectInventoryByType(this.resourcesDb, type);
    if (inventory.length === 0) {
      return null;
    }

    const activeLeases = new Set(selectActiveLeaseSlugs(this.client).map((row) => row.slug));

    const candidates = inventory.filter((resource) => !activeLeases.has(resource.slug));
    if (candidates.length === 0) {
      return null;
    }

    for (const candidate of candidates) {
      const lease = await this.createLease(candidate, leaseMs);
      if (lease) {
        return lease;
      }
    }

    return null;
  }

  private async reapExpiredLeases(type?: string): Promise<void> {
    const now = Date.now();
    const expired = selectExpiredLeases(this.client, { now });

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
    deleteLeaseBySlugAndLeaseId(this.client, { slug, leaseId });
    await markResourceAvailableInDb(this.resourcesDb, {
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
  ) {
    const now = Date.now();
    const expiresAt = now + leaseMs;
    const leaseId = crypto.randomUUID();
    insertLease(this.client, {
      slug: candidate.slug,
      leaseId,
      expiresAt,
      createdAt: now,
    });

    const mirrored = await markResourceLeasedInDb(this.resourcesDb, {
      type: candidate.type,
      slug: candidate.slug,
      leasedUntil: expiresAt,
      lastAcquiredAt: now,
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

    this.logEvent("acquired", candidate.slug, { leaseId, expiresAt });
    await this.scheduleNextAlarm();

    return {
      type: candidate.type,
      slug: candidate.slug,
      data: candidate.data,
      leaseId,
      expiresAt,
    } satisfies SemaphoreLeaseRecord;
  }

  private async scheduleNextAlarm(): Promise<void> {
    const nextLease = selectNextLease(this.client);

    if (!nextLease) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    await this.ctx.storage.setAlarm(nextLease.expires_at);
  }

  private logEvent(event: string, slug: string | null, payload: SemaphoreJsonObject) {
    insertEvent(this.client, {
      occurredAt: Date.now(),
      event,
      slug,
      payload: JSON.stringify(payload),
    });
  }
}
