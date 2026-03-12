import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { ORPCError, implement, onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { RequestHeadersPlugin, type RequestHeadersPluginContext } from "@orpc/server/plugins";
import { z } from "zod/v4";
import {
  AcquireResourceInput,
  DeleteResourceInput,
  ReleaseResourceInput,
  semaphoreContract,
  semaphoreDataSchema,
  semaphoreTypeSchema,
  type SemaphoreJsonObject,
  type SemaphoreLeaseRecord,
  type SemaphoreResourceRecord,
} from "@iterate-com/semaphore-contract";

type ResourceRow = {
  type: string;
  slug: string;
  data: string;
  lease_state: "available" | "leased";
  leased_until: number | null;
  last_acquired_at: number | null;
  last_released_at: number | null;
  created_at: string;
  updated_at: string;
};

type Waiter = {
  id: number;
  type: string;
  leaseMs: number;
  timeoutHandle: ReturnType<typeof setTimeout>;
  settled: boolean;
  resolve: (value: SemaphoreLeaseRecord | null) => void;
};

type RawSemaphoreEnv = {
  DB: D1Database;
  RESOURCE_COORDINATOR: DurableObjectNamespace<ResourceCoordinator>;
  SEMAPHORE_API_TOKEN: string;
};

type SemaphoreEnv = RawSemaphoreEnv;

const WorkerEnv = z.object({
  DB: z.custom<D1Database>(
    (value) => typeof value === "object" && value !== null && "prepare" in value,
    { message: "DB binding is required" },
  ),
  RESOURCE_COORDINATOR: z.custom<DurableObjectNamespace<ResourceCoordinator>>(
    (value) => typeof value === "object" && value !== null && "getByName" in value,
    { message: "RESOURCE_COORDINATOR binding is required" },
  ),
  SEMAPHORE_API_TOKEN: z.string().trim().min(1, "SEMAPHORE_API_TOKEN is required"),
});

const parsedEnvCache = new WeakMap<RawSemaphoreEnv, SemaphoreEnv>();

function parseWorkerEnv(env: RawSemaphoreEnv): SemaphoreEnv {
  const cached = parsedEnvCache.get(env);
  if (cached) return cached;

  const parsed = WorkerEnv.parse(env);
  parsedEnvCache.set(env, parsed);
  return parsed;
}

function readBearerToken(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const match = /^bearer\s+(.+)$/i.exec(headerValue);
  if (!match) return null;
  const token = match[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

function parseType(input: string): string {
  return semaphoreTypeSchema.parse(input);
}

function parseData(value: string): SemaphoreJsonObject {
  try {
    return semaphoreDataSchema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ResourceInputError("data must be valid JSON");
    }

    throw error;
  }
}

function rowToResourceRecord(row: ResourceRow): SemaphoreResourceRecord {
  return {
    type: row.type,
    slug: row.slug,
    data: parseData(row.data),
    leaseState: row.lease_state,
    leasedUntil: row.leased_until,
    lastAcquiredAt: row.last_acquired_at,
    lastReleasedAt: row.last_released_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ResourceInputError extends Error {}

async function listResourcesFromDb(
  db: D1Database,
  params: { type?: string } = {},
): Promise<SemaphoreResourceRecord[]> {
  const statement = params.type
    ? db
        .prepare(
          "SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at FROM resources WHERE type = ? ORDER BY created_at ASC, slug ASC",
        )
        .bind(params.type)
    : db.prepare(
        "SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at FROM resources ORDER BY type ASC, created_at ASC, slug ASC",
      );
  const result = await statement.all<ResourceRow>();
  return (result.results ?? []).map(rowToResourceRecord);
}

async function insertResource(
  db: D1Database,
  resource: {
    type: string;
    slug: string;
    data: SemaphoreJsonObject;
  },
): Promise<SemaphoreResourceRecord> {
  await db
    .prepare("INSERT INTO resources (type, slug, data) VALUES (?, ?, ?)")
    .bind(resource.type, resource.slug, JSON.stringify(resource.data))
    .run();

  const row = await db
    .prepare(
      "SELECT type, slug, data, lease_state, leased_until, last_acquired_at, last_released_at, created_at, updated_at FROM resources WHERE type = ? AND slug = ?",
    )
    .bind(resource.type, resource.slug)
    .first<ResourceRow>();

  if (!row) {
    throw new Error("Inserted resource row not found");
  }

  return rowToResourceRecord(row);
}

async function deleteResourceFromDb(
  db: D1Database,
  key: {
    type: string;
    slug: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare("DELETE FROM resources WHERE type = ? AND slug = ?")
    .bind(key.type, key.slug)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function selectInventoryByType(
  db: D1Database,
  type: string,
): Promise<SemaphoreResourceRecord[]> {
  return listResourcesFromDb(db, { type });
}

async function hasInventoryForType(db: D1Database, type: string): Promise<boolean> {
  const result = await db
    .prepare("SELECT 1 AS present FROM resources WHERE type = ? LIMIT 1")
    .bind(type)
    .first<{ present: number }>();
  return Boolean(result?.present);
}

async function markResourceLeasedInDb(
  db: D1Database,
  params: {
    type: string;
    slug: string;
    leasedUntil: number;
    lastAcquiredAt: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE resources SET lease_state = 'leased', leased_until = ?, last_acquired_at = ?, updated_at = CURRENT_TIMESTAMP WHERE type = ? AND slug = ?",
    )
    .bind(params.leasedUntil, params.lastAcquiredAt, params.type, params.slug)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

async function markResourceAvailableInDb(
  db: D1Database,
  params: {
    type: string;
    slug: string;
    lastReleasedAt: number | null;
  },
): Promise<void> {
  await db
    .prepare(
      "UPDATE resources SET lease_state = 'available', leased_until = NULL, last_released_at = COALESCE(?, last_released_at), updated_at = CURRENT_TIMESTAMP WHERE type = ? AND slug = ?",
    )
    .bind(params.lastReleasedAt, params.type, params.slug)
    .run();
}

export class ResourceCoordinator extends DurableObject<RawSemaphoreEnv> {
  private waiters: Waiter[] = [];
  private nextWaiterId = 0;
  private coordinatorType: string | null = null;

  constructor(ctx: DurableObjectState, env: RawSemaphoreEnv) {
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

    // Alarms run without request parameters, so the coordinator persists its type once and
    // then reuses it for D1 mirror updates triggered by lease expiry.
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

      // Durable Objects stay authoritative. D1 mirrors the visible lease state so inventory
      // queries can show who is likely busy and until when without consulting every coordinator.
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

type ORPCContext = RequestHeadersPluginContext & {
  env: SemaphoreEnv;
};

const os = implement(semaphoreContract).$context<ORPCContext>();

const authProcedure = os.middleware(async ({ context, next }) => {
  const expectedToken = context.env.SEMAPHORE_API_TOKEN;
  const providedToken = readBearerToken(context.reqHeaders?.get("authorization") ?? null);

  if (!providedToken || providedToken !== expectedToken) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Missing or invalid Authorization header",
    });
  }

  return next();
});

function mapResourceError(error: unknown): never {
  if (error instanceof ORPCError) {
    throw error;
  }

  if (error instanceof ResourceInputError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }

  if (isZodErrorLike(error)) {
    throw new ORPCError("BAD_REQUEST", {
      message: error.issues[0]?.message ?? "Invalid request input.",
    });
  }

  if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
    throw new ORPCError("CONFLICT", {
      message: "Resource already exists for this type and slug.",
    });
  }

  throw error;
}

function isZodErrorLike(error: unknown): error is { issues: Array<{ message?: string }> } {
  if (!(error instanceof z.ZodError) && !(error instanceof Error)) {
    return false;
  }

  if (!("issues" in error)) {
    return false;
  }

  return Array.isArray(error.issues);
}

function getCoordinator(env: SemaphoreEnv, type: string) {
  return env.RESOURCE_COORDINATOR.getByName(type);
}

const addResourceProcedure = os.resources.add
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, data } = input;
      const coordinator = getCoordinator(context.env, type);
      const hasActiveLease = await coordinator.hasActiveLease({ type, slug });
      if (hasActiveLease) {
        throw new ORPCError("CONFLICT", {
          message: "Cannot add a resource while an older lease is still active for this slug.",
        });
      }

      const created = await insertResource(context.env.DB, {
        type,
        slug,
        data,
      });
      await coordinator.inventoryChanged({ type });
      return created;
    } catch (error) {
      return mapResourceError(error);
    }
  });

const deleteResourceProcedure = os.resources.delete
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug } = input;
      const deleted = await deleteResourceFromDb(context.env.DB, { type, slug });
      return { deleted };
    } catch (error) {
      return mapResourceError(error);
    }
  });

const listResourcesProcedure = os.resources.list
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      return await listResourcesFromDb(context.env.DB, { type: input.type });
    } catch (error) {
      return mapResourceError(error);
    }
  });

const acquireResourceProcedure = os.resources.acquire
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, leaseMs, waitMs = 0 } = input;
      const hasInventory = await hasInventoryForType(context.env.DB, type);
      if (!hasInventory) {
        throw new ORPCError("NOT_FOUND", {
          message: "No resources are configured for this type.",
        });
      }

      const coordinator = getCoordinator(context.env, type);
      const lease = await coordinator.acquire({
        type,
        leaseMs,
        waitMs,
      });

      if (!lease) {
        throw new ORPCError("CONFLICT", {
          message:
            waitMs > 0
              ? "No resource became available before waitMs elapsed."
              : "No resource is currently available for this type.",
        });
      }

      return lease;
    } catch (error) {
      return mapResourceError(error);
    }
  });

const releaseResourceProcedure = os.resources.release
  .use(authProcedure)
  .handler(async ({ context, input }) => {
    try {
      const { type, slug, leaseId } = input;
      const coordinator = getCoordinator(context.env, type);
      const released = await coordinator.release({
        type,
        slug,
        leaseId,
      });
      return { released };
    } catch (error) {
      return mapResourceError(error);
    }
  });

export const appRouter = os.router({
  resources: {
    add: addResourceProcedure,
    delete: deleteResourceProcedure,
    list: listResourcesProcedure,
    acquire: acquireResourceProcedure,
    release: releaseResourceProcedure,
  },
});

const orpcHandler = new RPCHandler(appRouter, {
  plugins: [new RequestHeadersPlugin()],
  interceptors: [
    onError((error) => {
      if (error instanceof ORPCError) return;
      throw error;
    }),
  ],
});

export const app = new Hono<{
  Bindings: RawSemaphoreEnv;
}>();

app.get("/health", (c) => c.text("OK"));

app.all("/api/orpc/*", async (c) => {
  const parsedEnv = parseWorkerEnv(c.env);
  const { matched, response } = await orpcHandler.handle(c.req.raw, {
    prefix: "/api/orpc",
    context: {
      env: parsedEnv,
    },
  });

  if (!matched) {
    return c.json({ error: "Not found" }, 404);
  }

  return c.newResponse(response.body, response);
});

app.all("*", (c) => {
  return c.json({ error: "Not found" }, 404);
});

export default app;

export type { RawSemaphoreEnv };
