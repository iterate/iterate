import { randomUUID } from "node:crypto";
import { eventSchema } from "@jonasland2/events-contract";
import { orderSchema, ordersContract } from "@jonasland2/orders-contract";
import {
  createRequestContextMiddleware,
  createRequestLifecycleMiddleware,
  createServiceLogger,
  type SharedRequestContext,
} from "@jonasland2/orpc-shared";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";

type OrderRecord = InferSchemaOutput<typeof orderSchema>;
type OrdersContext = SharedRequestContext;

const serviceName = "jonasland2-orders-service";
const log = createServiceLogger(serviceName);
const os = implement(ordersContract).$context<OrdersContext>();

const withSharedMiddlewares = os
  .use(os.middleware(createRequestContextMiddleware(serviceName, log)))
  .use(os.middleware(createRequestLifecycleMiddleware(serviceName, log)));

const eventsServiceBaseUrl =
  process.env.EVENTS_SERVICE_BASE_URL || "http://events-service.service.consul:19010/api";
const orders: OrderRecord[] = [];

async function createEventForOrder(order: OrderRecord, requestId: string | undefined) {
  const response = await fetch(`${eventsServiceBaseUrl}/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
    body: JSON.stringify({
      type: "order_placed",
      payload: {
        orderId: order.id,
        sku: order.sku,
        quantity: order.quantity,
      },
    }),
  });

  if (!response.ok) {
    throw new ORPCError("BAD_GATEWAY", {
      message: `events-service responded with ${response.status}`,
    });
  }

  const body = await response.json();
  const parsed = eventSchema.safeParse(body);
  if (!parsed.success) {
    throw new ORPCError("BAD_GATEWAY", {
      message: "events-service response shape mismatch",
    });
  }

  return parsed.data;
}

const placeOrder = withSharedMiddlewares.orders.place.handler(async ({ context, input }) => {
  const order: OrderRecord = {
    id: randomUUID(),
    sku: input.sku,
    quantity: input.quantity,
    status: "accepted",
    eventId: "",
    createdAt: new Date().toISOString(),
  };

  const createdEvent = await createEventForOrder(order, context.requestId);
  order.eventId = createdEvent.id;

  orders.unshift(order);
  if (orders.length > 500) orders.length = 500;

  log("orders.placed", {
    request_id: context.requestId,
    order_id: order.id,
    event_id: order.eventId,
    sku: order.sku,
    quantity: order.quantity,
  });

  return order;
});

const ping = withSharedMiddlewares.orders.ping.handler(async () => {
  return {
    ok: true,
    service: serviceName,
  };
});

export const ordersRouter = withSharedMiddlewares.router({
  orders: {
    place: placeOrder,
    ping,
  },
});
