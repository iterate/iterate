import { randomUUID } from "node:crypto";
import { eventSchema, eventsContract, eventsServiceManifest } from "@jonasland2/events-contract";
import {
  createServiceSubRouterHandlers,
  createServiceContextMiddleware,
  infoFromContext,
  type ServiceInitialContext,
} from "@jonasland2/shared";
import { desc, eq, sql } from "drizzle-orm";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";
import { db } from "./db.ts";
import * as schema from "./db.ts";

type EventRecord = InferSchemaOutput<typeof eventSchema>;
type EventsContext = ServiceInitialContext;

const serviceName = "jonasland2-events-service";
const os = implement(eventsContract).$context<EventsContext>();

const withSharedMiddlewares = os.use(os.middleware(createServiceContextMiddleware(serviceName)));

function parsePayload(payload: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  return {};
}

function toEventRecord(row: typeof schema.eventsTable.$inferSelect): EventRecord {
  return {
    id: row.id,
    type: row.type,
    payload: parsePayload(row.payload),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getEventRowById(id: string) {
  const [row] = await db
    .select()
    .from(schema.eventsTable)
    .where(eq(schema.eventsTable.id, id))
    .limit(1);
  return row ?? null;
}

const listEvents = withSharedMiddlewares.events.list.handler(async ({ input, context }) => {
  const [totalRow] = await db.select({ value: sql<number>`count(*)` }).from(schema.eventsTable);

  const rows = await db
    .select()
    .from(schema.eventsTable)
    .orderBy(desc(schema.eventsTable.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  infoFromContext(context, "events.list", {
    service: context.serviceName,
    request_id: context.requestId,
    limit: input.limit,
    offset: input.offset,
    total: totalRow?.value ?? 0,
  });

  return {
    events: rows.map(toEventRecord),
    total: totalRow?.value ?? 0,
  };
});

const createEvent = withSharedMiddlewares.events.create.handler(async ({ input, context }) => {
  const now = new Date().toISOString();
  const id = randomUUID();

  await db.insert(schema.eventsTable).values({
    id,
    type: input.type,
    payload: JSON.stringify(input.payload ?? {}),
    createdAt: now,
    updatedAt: now,
  });

  const event = toEventRecord({
    id,
    type: input.type,
    payload: JSON.stringify(input.payload ?? {}),
    createdAt: now,
    updatedAt: now,
  });

  infoFromContext(context, "events.created", {
    service: context.serviceName,
    request_id: context.requestId,
    event_id: event.id,
    event_type: event.type,
  });

  return event;
});

const findEvent = withSharedMiddlewares.events.find.handler(async ({ input, context }) => {
  const row = await getEventRowById(input.id);
  if (!row) {
    throw new ORPCError("NOT_FOUND", {
      message: `Event ${input.id} not found`,
    });
  }

  infoFromContext(context, "events.found", {
    service: context.serviceName,
    request_id: context.requestId,
    event_id: row.id,
  });

  return toEventRecord(row);
});

const updateEvent = withSharedMiddlewares.events.update.handler(async ({ input, context }) => {
  const existing = await getEventRowById(input.id);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", {
      message: `Event ${input.id} not found`,
    });
  }

  const updatedAt = new Date().toISOString();
  const nextType = input.type ?? existing.type;
  const nextPayload =
    input.payload !== undefined ? JSON.stringify(input.payload) : existing.payload;

  await db
    .update(schema.eventsTable)
    .set({
      type: nextType,
      payload: nextPayload,
      updatedAt,
    })
    .where(eq(schema.eventsTable.id, input.id));

  const updated = toEventRecord({
    ...existing,
    type: nextType,
    payload: nextPayload,
    updatedAt,
  });

  infoFromContext(context, "events.updated", {
    service: context.serviceName,
    request_id: context.requestId,
    event_id: updated.id,
    event_type: updated.type,
  });

  return updated;
});

const removeEvent = withSharedMiddlewares.events.remove.handler(async ({ input, context }) => {
  const existing = await getEventRowById(input.id);

  if (existing) {
    await db.delete(schema.eventsTable).where(eq(schema.eventsTable.id, input.id));
  }

  infoFromContext(context, "events.removed", {
    service: context.serviceName,
    request_id: context.requestId,
    event_id: input.id,
    deleted: existing !== null,
  });

  return {
    ok: true as const,
    id: input.id,
    deleted: existing !== null,
  };
});

const serviceProcedures = createServiceSubRouterHandlers(withSharedMiddlewares, {
  manifest: {
    name: serviceName,
    version: eventsServiceManifest.version,
  },
  executeSql: schema.executeEventsSql,
  logPrefix: "events.service",
});

export const eventsRouter = withSharedMiddlewares.router({
  service: serviceProcedures,
  events: {
    list: listEvents,
    create: createEvent,
    find: findEvent,
    update: updateEvent,
    remove: removeEvent,
  },
});
