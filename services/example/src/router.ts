import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import { serviceManifest as eventsServiceManifest } from "@iterate-com/events-contract";
import {
  exampleContract,
  exampleServiceManifest,
  thingSchema,
} from "@iterate-com/example-contract";
import {
  createLocalServiceOrpcClient,
  infoFromContext,
  transformSqlResultSet,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";
import { db } from "./db.ts";
import * as schema from "./db.ts";

type ThingRecord = InferSchemaOutput<typeof thingSchema>;

interface ExampleContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
}

interface EventsClientContext {
  requestId: string;
}

const serviceName = "jonasland-example";
const THING_CREATED_EVENT_TYPE = "https://events.iterate.com/example/thing-created";
const THING_UPDATED_EVENT_TYPE = "https://events.iterate.com/example/thing-updated";
const THING_REMOVED_EVENT_TYPE = "https://events.iterate.com/example/thing-removed";
const os = implement(exampleContract).$context<ExampleContext>();

const eventsClient = createLocalServiceOrpcClient({
  manifest: eventsServiceManifest,
  headers: (clientContext: { context?: EventsClientContext }) => {
    const headers: Record<string, string> = {};
    if (clientContext.context?.requestId) {
      headers["x-request-id"] = clientContext.context.requestId;
    }
    return headers;
  },
});

function normalizeStreamPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  return normalized.length > 0 ? normalized : "example/things";
}

function normalizeEventType(type: string): `https://events.iterate.com/${string}` {
  if (type.startsWith("https://events.iterate.com/")) {
    return type as `https://events.iterate.com/${string}`;
  }
  const normalized = type.replace(/^\/+/, "");
  return `https://events.iterate.com/${normalized}`;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toThingRecord(row: typeof schema.thingsTable.$inferSelect): ThingRecord {
  return {
    id: row.id,
    thing: row.thing,
    eventId: row.eventId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getThingRowById(id: string) {
  const [row] = await db
    .select()
    .from(schema.thingsTable)
    .where(eq(schema.thingsTable.id, id))
    .limit(1);
  return row ?? null;
}

async function appendEventToStream(params: {
  path: string;
  type: `https://events.iterate.com/${string}`;
  payload: Record<string, unknown>;
  requestId: string;
}) {
  const eventId = randomUUID();

  try {
    await eventsClient.append(
      {
        path: normalizeStreamPath(params.path),
        events: [
          {
            type: params.type,
            payload: {
              eventId,
              ...params.payload,
            },
          },
        ],
      },
      {
        context: {
          requestId: params.requestId,
        },
      },
    );

    return { id: eventId };
  } catch (error) {
    throw new ORPCError("BAD_GATEWAY", {
      message: toError(error).message || "events-service request failed",
      cause: error,
    });
  }
}

const serviceHealth = os.service.health.handler(async ({ context }) => ({
  ok: true,
  service: context.serviceName,
  version: exampleServiceManifest.version,
}));

const serviceSql = os.service.sql.handler(async ({ input, context }) => {
  const startedAt = Date.now();
  const result = transformSqlResultSet(await schema.executeExampleSql(input.statement));

  infoFromContext(context, "example.service.sql", {
    service: context.serviceName,
    request_id: context.requestId,
    duration_ms: Date.now() - startedAt,
    rows: result.rows.length,
    rows_affected: result.stat.rowsAffected,
  });

  return result;
});

const createThing = os.things.create.handler(async ({ context, input }) => {
  const now = new Date().toISOString();
  const id = randomUUID();

  const createdEvent = await appendEventToStream({
    path: "/example/things",
    type: THING_CREATED_EVENT_TYPE,
    payload: { thingId: id, thing: input.thing },
    requestId: context.requestId,
  });

  await db.insert(schema.thingsTable).values({
    id,
    thing: input.thing,
    eventId: createdEvent.id,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    thing: input.thing,
    eventId: createdEvent.id,
    createdAt: now,
    updatedAt: now,
  };
});

const listThings = os.things.list.handler(async ({ input }) => {
  const [totalRow] = await db.select({ value: sql<number>`count(*)` }).from(schema.thingsTable);
  const rows = await db
    .select()
    .from(schema.thingsTable)
    .orderBy(desc(schema.thingsTable.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  return {
    things: rows.map(toThingRecord),
    total: totalRow?.value ?? 0,
  };
});

const findThing = os.things.find.handler(async ({ input }) => {
  const row = await getThingRowById(input.id);
  if (!row) {
    throw new ORPCError("NOT_FOUND", { message: `Thing ${input.id} not found` });
  }
  return toThingRecord(row);
});

const updateThing = os.things.update.handler(async ({ input, context }) => {
  const existing = await getThingRowById(input.id);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", { message: `Thing ${input.id} not found` });
  }

  const updatedAt = new Date().toISOString();
  const nextThing = input.thing ?? existing.thing;

  const updatedEvent = await appendEventToStream({
    path: "/example/things",
    type: THING_UPDATED_EVENT_TYPE,
    payload: { thingId: input.id, thing: nextThing },
    requestId: context.requestId,
  });

  await db
    .update(schema.thingsTable)
    .set({
      thing: nextThing,
      eventId: updatedEvent.id,
      updatedAt,
    })
    .where(eq(schema.thingsTable.id, input.id));

  return {
    id: input.id,
    thing: nextThing,
    eventId: updatedEvent.id,
    createdAt: existing.createdAt,
    updatedAt,
  };
});

const removeThing = os.things.remove.handler(async ({ input, context }) => {
  const existing = await getThingRowById(input.id);
  if (!existing) {
    return { ok: true as const, id: input.id, deleted: false };
  }

  await appendEventToStream({
    path: "/example/things",
    type: THING_REMOVED_EVENT_TYPE,
    payload: { thingId: input.id, thing: existing.thing },
    requestId: context.requestId,
  });
  await db.delete(schema.thingsTable).where(eq(schema.thingsTable.id, input.id));

  return { ok: true as const, id: input.id, deleted: true };
});

const ping = os.things.ping.handler(async ({ context }) => {
  infoFromContext(context, "example.ping", {
    service: context.serviceName,
    request_id: context.requestId,
  });
  return {
    ok: true,
    service: serviceName,
  };
});

const delayedPublish = os.things.delayedPublish.handler(async ({ input, context }) => {
  const scheduledAt = new Date();
  const dueAt = new Date(scheduledAt.getTime() + input.delayMs);
  const streamPath = normalizeStreamPath(input.streamPath);
  const eventType = normalizeEventType(input.type);

  const timer = setTimeout(() => {
    void appendEventToStream({
      path: streamPath,
      type: eventType,
      payload: {
        ...input.payload,
        scheduledAt: scheduledAt.toISOString(),
        dueAt: dueAt.toISOString(),
      },
      requestId: context.requestId,
    }).catch((error) => {
      context.log.error(toError(error), {
        event: "example.delayed_publish.failed",
        stream_path: streamPath,
        type: eventType,
      });
    });
  }, input.delayMs);
  timer.unref?.();

  return {
    accepted: true as const,
    scheduledAt: scheduledAt.toISOString(),
    dueAt: dueAt.toISOString(),
    streamPath,
    type: eventType,
    delayMs: input.delayMs,
  };
});

export const exampleRouter = os.router({
  service: {
    health: serviceHealth,
    sql: serviceSql,
  },
  things: {
    create: createThing,
    list: listThings,
    find: findThing,
    update: updateThing,
    remove: removeThing,
    ping,
    delayedPublish,
  },
});
