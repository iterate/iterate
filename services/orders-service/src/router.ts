import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import {
  eventBusContract,
  serviceManifest as eventsServiceManifest,
} from "@iterate-com/events-contract";
import {
  orderSchema,
  ordersContract,
  ordersServiceEnvSchema,
  ordersServiceManifest,
} from "@iterate-com/orders-contract";
import {
  createLocalServiceOrpcClient,
  infoFromContext,
  transformSqlResultSet,
  type ServiceRequestLogger,
} from "@iterate-com/shared/jonasland";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";
import { db } from "./db.ts";
import * as schema from "./db.ts";

type OrderRecord = InferSchemaOutput<typeof orderSchema>;

interface OrdersContext {
  requestId: string;
  serviceName: string;
  log: ServiceRequestLogger;
}

interface EventsClientContext {
  requestId: string;
}

const serviceName = "jonasland-orders-service";
const ORDER_PLACED_EVENT_TYPE = "https://events.iterate.com/orders/order-placed";
const ORDER_WORKFLOW_STARTED_EVENT_TYPE = "https://events.iterate.com/orders/workflow-started";
const ORDER_WORKFLOW_COMPLETED_EVENT_TYPE = "https://events.iterate.com/orders/workflow-completed";
const os = implement(ordersContract).$context<OrdersContext>();

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
  return normalized.length > 0 ? normalized : "orders";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function toOrderRecord(row: typeof schema.ordersTable.$inferSelect): OrderRecord {
  return {
    id: row.id,
    sku: row.sku,
    quantity: row.quantity,
    status: row.status as "accepted",
    eventId: row.eventId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function getOrderRowById(id: string) {
  const [row] = await db
    .select()
    .from(schema.ordersTable)
    .where(eq(schema.ordersTable.id, id))
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

async function createEventForOrder(order: OrderRecord, requestId: string) {
  return await appendEventToStream({
    path: "/orders",
    type: ORDER_PLACED_EVENT_TYPE,
    payload: {
      orderId: order.id,
      sku: order.sku,
      quantity: order.quantity,
    },
    requestId,
  });
}

const serviceHealth = os.service.health.handler(async ({ context }) => ({
  ok: true,
  service: context.serviceName,
  version: ordersServiceManifest.version,
}));

const serviceSql = os.service.sql.handler(async ({ input, context }) => {
  const startedAt = Date.now();
  const result = transformSqlResultSet(await schema.executeOrdersSql(input.statement));

  infoFromContext(context, "orders.service.sql", {
    service: context.serviceName,
    request_id: context.requestId,
    duration_ms: Date.now() - startedAt,
    rows: result.rows.length,
    rows_affected: result.stat.rowsAffected,
  });

  return result;
});

const placeOrder = os.orders.place.handler(async ({ context, input }) => {
  const now = new Date().toISOString();

  const order: OrderRecord = {
    id: randomUUID(),
    sku: input.sku,
    quantity: input.quantity,
    status: "accepted",
    eventId: "",
    createdAt: now,
    updatedAt: now,
  };

  const createdEvent = await createEventForOrder(order, context.requestId);
  order.eventId = createdEvent.id;

  await db.insert(schema.ordersTable).values({
    id: order.id,
    sku: order.sku,
    quantity: order.quantity,
    status: order.status,
    eventId: order.eventId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  });

  infoFromContext(context, "orders.placed", {
    service: context.serviceName,
    request_id: context.requestId,
    order_id: order.id,
    event_id: order.eventId,
    sku: order.sku,
    quantity: order.quantity,
  });

  return order;
});

const kickoffWorkflow = os.orders.kickoffWorkflow.handler(async ({ context, input }) => {
  const now = new Date().toISOString();
  const workflowId = randomUUID();
  const orderId = randomUUID();
  const streamPath = normalizeStreamPath(input.streamPath);

  const order: OrderRecord = {
    id: orderId,
    sku: input.sku,
    quantity: input.quantity,
    status: "accepted",
    eventId: "",
    createdAt: now,
    updatedAt: now,
  };

  const startedEvent = await appendEventToStream({
    path: streamPath,
    type: ORDER_WORKFLOW_STARTED_EVENT_TYPE,
    payload: {
      workflowId,
      orderId: order.id,
      sku: order.sku,
      quantity: order.quantity,
      delayMs: input.delayMs,
      streamPath,
    },
    requestId: context.requestId,
  });

  order.eventId = startedEvent.id;

  await db.insert(schema.ordersTable).values({
    id: order.id,
    sku: order.sku,
    quantity: order.quantity,
    status: order.status,
    eventId: order.eventId,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  });

  const timer = setTimeout(() => {
    void appendEventToStream({
      path: streamPath,
      type: ORDER_WORKFLOW_COMPLETED_EVENT_TYPE,
      payload: {
        workflowId,
        orderId: order.id,
        sku: order.sku,
        quantity: order.quantity,
        delayMs: input.delayMs,
        streamPath,
        startedEventId: startedEvent.id,
      },
      requestId: context.requestId,
    })
      .then((completedEvent) => {
        infoFromContext(context, "orders.workflow.completed", {
          service: context.serviceName,
          request_id: context.requestId,
          workflow_id: workflowId,
          order_id: order.id,
          event_id: completedEvent.id,
          delay_ms: input.delayMs,
          stream_path: streamPath,
        });
      })
      .catch((error) => {
        context.log.error(toError(error), {
          event: "orders.workflow.complete.failed",
          service: context.serviceName,
          request_id: context.requestId,
          workflow_id: workflowId,
          order_id: order.id,
          stream_path: streamPath,
          delay_ms: input.delayMs,
        });
      });
  }, input.delayMs);
  timer.unref?.();

  infoFromContext(context, "orders.workflow.started", {
    service: context.serviceName,
    request_id: context.requestId,
    workflow_id: workflowId,
    order_id: order.id,
    event_id: startedEvent.id,
    delay_ms: input.delayMs,
    stream_path: streamPath,
  });

  return {
    accepted: true as const,
    workflowId,
    orderId: order.id,
    streamPath,
    delayMs: input.delayMs,
    createdEventId: startedEvent.id,
    createdAt: now,
  };
});

const listOrders = os.orders.list.handler(async ({ input, context }) => {
  const [totalRow] = await db.select({ value: sql<number>`count(*)` }).from(schema.ordersTable);

  const rows = await db
    .select()
    .from(schema.ordersTable)
    .orderBy(desc(schema.ordersTable.createdAt))
    .limit(input.limit)
    .offset(input.offset);

  infoFromContext(context, "orders.list", {
    service: context.serviceName,
    request_id: context.requestId,
    limit: input.limit,
    offset: input.offset,
    total: totalRow?.value ?? 0,
  });

  return {
    orders: rows.map(toOrderRecord),
    total: totalRow?.value ?? 0,
  };
});

const findOrder = os.orders.find.handler(async ({ input, context }) => {
  const row = await getOrderRowById(input.id);
  if (!row) {
    throw new ORPCError("NOT_FOUND", {
      message: `Order ${input.id} not found`,
    });
  }

  infoFromContext(context, "orders.found", {
    service: context.serviceName,
    request_id: context.requestId,
    order_id: row.id,
  });

  return toOrderRecord(row);
});

const updateOrder = os.orders.update.handler(async ({ input, context }) => {
  const existing = await getOrderRowById(input.id);
  if (!existing) {
    throw new ORPCError("NOT_FOUND", {
      message: `Order ${input.id} not found`,
    });
  }

  const updatedAt = new Date().toISOString();
  const nextSku = input.sku ?? existing.sku;
  const nextQuantity = input.quantity ?? existing.quantity;

  await db
    .update(schema.ordersTable)
    .set({
      sku: nextSku,
      quantity: nextQuantity,
      updatedAt,
    })
    .where(eq(schema.ordersTable.id, input.id));

  const updated = toOrderRecord({
    ...existing,
    sku: nextSku,
    quantity: nextQuantity,
    updatedAt,
  });

  infoFromContext(context, "orders.updated", {
    service: context.serviceName,
    request_id: context.requestId,
    order_id: updated.id,
    sku: updated.sku,
    quantity: updated.quantity,
  });

  return updated;
});

const removeOrder = os.orders.remove.handler(async ({ input, context }) => {
  const existing = await getOrderRowById(input.id);

  if (existing) {
    await db.delete(schema.ordersTable).where(eq(schema.ordersTable.id, input.id));
  }

  infoFromContext(context, "orders.removed", {
    service: context.serviceName,
    request_id: context.requestId,
    order_id: input.id,
    deleted: existing !== null,
  });

  return {
    ok: true as const,
    id: input.id,
    deleted: existing !== null,
  };
});

const ping = os.orders.ping.handler(async ({ context }) => {
  infoFromContext(context, "orders.ping", {
    service: context.serviceName,
    request_id: context.requestId,
  });

  return {
    ok: true,
    service: serviceName,
  };
});

export const ordersRouter = os.router({
  service: {
    health: serviceHealth,
    sql: serviceSql,
  },
  orders: {
    place: placeOrder,
    kickoffWorkflow,
    list: listOrders,
    find: findOrder,
    update: updateOrder,
    remove: removeOrder,
    ping,
  },
});
