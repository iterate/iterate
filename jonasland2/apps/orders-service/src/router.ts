import { randomUUID } from "node:crypto";
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import type { JsonifiedClient } from "@orpc/openapi-client";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { eventsContract } from "@jonasland2/events-contract";
import { orderSchema, ordersContract } from "@jonasland2/orders-contract";
import {
  createServiceContextMiddleware,
  infoFromContext,
  type ServiceInitialContext,
} from "@jonasland2/orpc-shared";
import { ORPCError, implement, type InferSchemaOutput } from "@orpc/server";

type OrderRecord = InferSchemaOutput<typeof orderSchema>;
type OrdersContext = ServiceInitialContext;

const serviceName = "jonasland2-orders-service";
const os = implement(ordersContract).$context<OrdersContext>();

const withSharedMiddlewares = os.use(os.middleware(createServiceContextMiddleware(serviceName)));

const eventsServiceBaseUrl =
  process.env.EVENTS_SERVICE_BASE_URL || "http://events-service.service.consul:19010/api";
const orders: OrderRecord[] = [];

interface EventsClientContext {
  requestId: string;
}

const eventsLink = new OpenAPILink<EventsClientContext>(eventsContract, {
  url: eventsServiceBaseUrl,
  headers: ({ context: clientContext }) => {
    const headers: Record<string, string> = {};

    if (clientContext?.requestId) {
      headers["x-request-id"] = clientContext.requestId;
    }

    return headers;
  },
});

const eventsClient: JsonifiedClient<
  ContractRouterClient<typeof eventsContract, EventsClientContext>
> = createORPCClient(eventsLink);

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

export const ordersRouter = withSharedMiddlewares.router({
  orders: {
    place: placeOrder,
    ping,
  },
});
