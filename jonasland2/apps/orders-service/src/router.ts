import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { desc, eq, sql } from "drizzle-orm";
import { RPCLink } from "@orpc/client/fetch";
import { inferRPCMethodFromContractRouter } from "@orpc/contract";
import { eventsContract } from "@jonasland2/events-contract";
import {
  orderSchema,
  ordersContract,
  ordersServiceEnvSchema,
  ordersServiceManifest,
} from "@jonasland2/orders-contract";
import {
  createServiceSubRouterHandlers,
  createServiceContextMiddleware,
  infoFromContext,
  type ServiceInitialContext,
} from "@jonasland2/shared";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";
import { db } from "./db.ts";
import * as schema from "./db.ts";

type OrderRecord = InferSchemaOutput<typeof orderSchema>;
type OrdersContext = ServiceInitialContext;

const serviceName = "jonasland2-orders-service";
const os = implement(ordersContract).$context<OrdersContext>();

const withSharedMiddlewares = os.use(os.middleware(createServiceContextMiddleware(serviceName)));

const env = ordersServiceEnvSchema.parse(process.env);
const eventsServiceBaseUrl = env.EVENTS_SERVICE_BASE_URL;

interface EventsClientContext {
  requestId: string;
}

const eventsLink = new RPCLink<EventsClientContext>({
  url: eventsServiceBaseUrl,
  method: inferRPCMethodFromContractRouter(eventsContract),
  headers: (clientContext) => {
    const headers: Record<string, string> = {};

    if (clientContext.context?.requestId) {
      headers["x-request-id"] = clientContext.context.requestId;
    }

    return headers;
  },
});

const eventsClient: ContractRouterClient<typeof eventsContract, EventsClientContext> =
  createORPCClient(eventsLink);

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

async function createEventForOrder(order: OrderRecord, requestId: string) {
  try {
    return await eventsClient.events.create(
      {
        type: "order_placed",
        payload: {
          orderId: order.id,
          sku: order.sku,
          quantity: order.quantity,
        },
      },
      {
        context: {
          requestId,
        },
      },
    );
  } catch (error) {
    throw new ORPCError("BAD_GATEWAY", {
      message: error instanceof Error ? error.message : "events-service request failed",
      cause: error,
    });
  }
}

const placeOrder = withSharedMiddlewares.orders.place.handler(async ({ context, input }) => {
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

const listOrders = withSharedMiddlewares.orders.list.handler(async ({ input, context }) => {
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

const findOrder = withSharedMiddlewares.orders.find.handler(async ({ input, context }) => {
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

const updateOrder = withSharedMiddlewares.orders.update.handler(async ({ input, context }) => {
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

const removeOrder = withSharedMiddlewares.orders.remove.handler(async ({ input, context }) => {
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

const ping = withSharedMiddlewares.orders.ping.handler(async ({ context }) => {
  infoFromContext(context, "orders.ping", {
    service: context.serviceName,
    request_id: context.requestId,
  });

  return {
    ok: true,
    service: serviceName,
  };
});

const serviceProcedures = createServiceSubRouterHandlers(withSharedMiddlewares, {
  manifest: {
    name: serviceName,
    version: ordersServiceManifest.version,
  },
  executeSql: schema.executeOrdersSql,
  logPrefix: "orders.service",
});

export const ordersRouter = withSharedMiddlewares.router({
  service: serviceProcedures,
  orders: {
    place: placeOrder,
    list: listOrders,
    find: findOrder,
    update: updateOrder,
    remove: removeOrder,
    ping,
  },
});
